/**
 * MeteringSeam 的 PostgreSQL 实现（§6.4 + 评审 N3 并行预算树）。
 * 语义与契约（shared/seam-contracts/metering.ts）一致：
 *   - reserve：双树预算检查，任一超限即拒
 *   - commit：落 usage_ledger 明细（归因链 user/dept/role/project/agent/component/feature）
 * 树扣减原子性：本实现以 PG 事务完成；分布式的 RocketMQ 事务消息在 P2 接入（铁律 5）。
 */
import pg from 'pg'
import {
  COST_TYPES,
  assertCostEvent,
  isCostType,
  type CostEvent,
} from '../../../shared/seam-contracts/cost-events.ts'
import {
  budgetState,
  resolveLimits,
  worseOf,
  type BudgetState,
} from '../../../shared/seam-contracts/budget-policy.ts'
import type {
  MeterContext,
  MeterRecord,
  MeterResult,
  MeteringSeam,
} from '../../../shared/seam-contracts/metering.ts'

export const METERING_DDL = `
CREATE TABLE IF NOT EXISTS usage_ledger (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT NOT NULL,
  dept_id     TEXT NOT NULL,
  role        TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  component_id TEXT NOT NULL,
  feature     TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  model       TEXT NULL,
  tokens      INTEGER NOT NULL,
  cost_type   TEXT NOT NULL,
  cost_usd    NUMERIC(18,6) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_trees (
  kind    TEXT NOT NULL CHECK (kind IN ('user', 'project')),
  id      TEXT NOT NULL,
  budget  BIGINT NOT NULL,
  -- 本期配额总额与限额（总额模型，设计说明 2026-08-26）。NULL = 旧模式：
  -- 只认剩余、仅 within/hard（既有行为）；非空 = 四态，used = (total − remaining) + need
  budget_total BIGINT NULL,
  soft_limit   BIGINT NULL,   -- NULL = 缺省=budget_total
  overdraft    BIGINT NULL,   -- NULL = 0
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS budget_commit_seq (
  id BIGSERIAL PRIMARY KEY
);
`

/**
 * 增量迁移（评审 B2 的新维度）。
 *
 * **必须用 ALTER 而不是只改上面的 CREATE**：既有库已经建过表，`CREATE TABLE IF NOT
 * EXISTS` 对它是空操作，只改 CREATE 会得到「本地新库测试全绿、部署到既有库后列不
 * 存在」——这是这类改动最经典的失败方式。
 *
 * 新列可空：历史行不回填假数据（设计说明 §7）。回填会让「本项上线前的成本」看起来
 * 像是已经分类过的，而它并没有。
 */
export const METERING_MIGRATIONS = `
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS trace_id TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS emitter  TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS qty      NUMERIC(20,6);
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS unit     TEXT;

-- 判据 6 要按 trace 取回因果链；无索引会随台账增长退化成全表扫
CREATE INDEX IF NOT EXISTS usage_ledger_trace_idx ON usage_ledger (trace_id);
-- 按 (类型, 时间) 下钻是「解释一次尖峰」的主查询路径
CREATE INDEX IF NOT EXISTS usage_ledger_type_ts_idx ON usage_ledger (cost_type, ts DESC);

-- 总额模型（设计说明 2026-08-26）：既有库的表已建过，必须 ALTER 而不是只改上面的
-- CREATE（CREATE IF NOT EXISTS 对既有库是空操作）。新列可空：历史行保持旧模式两态，
-- 不回填假数据。
ALTER TABLE budget_trees ADD COLUMN IF NOT EXISTS budget_total BIGINT;
ALTER TABLE budget_trees ADD COLUMN IF NOT EXISTS soft_limit   BIGINT;
ALTER TABLE budget_trees ADD COLUMN IF NOT EXISTS overdraft    BIGINT;
`

export class PgMeteringSeam implements MeteringSeam {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  async init(): Promise<void> {
    await this.pool.query(METERING_DDL)
    await this.pool.query(METERING_MIGRATIONS)
  }

  /**
   * 测试专用逃生口（TRUNCATE / 断言用查询）。
   *
   * 显式给一个窄口，而不是让测试去碰私有 `pool`：碰私有字段的测试会在下一次重构
   * 时坏掉，而坏掉的方式是「测试自己报错」而非「被测行为变了」，很难判断。
   */
  async raw<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const r = await this.pool.query<T>(sql, params)
    return r.rows
  }

  /**
   * 前置拦截：两棵树都查，任一不足即拒。
   *
   * `estimate` 给了就判「够不够这一次」，不给退回「余额是否还有」。只判后者的话，
   * 剩 1 token 的用户可以发起任意大的调用——封顶在事前完全不起作用，只能靠事后
   * 扣成负数补救。
   *
   * 返回值带 `state`：双树取更严者（§5），`approved ⟺ state !== 'hard'`。
   * 投影口径见 `stateOfTree`——本实现只存剩余、不存总额，算不出「已用」，所以
   * 退化为「放不放得下这一次」；三态在 PG 侧留待「总额模型」落地（见 `stateOfTree`）。
   */
  async reserve(ctx: MeterContext, estimate?: number): Promise<MeterResult> {
    const need = estimate !== undefined && Number.isFinite(estimate) && estimate > 0
      ? estimate
      : 1
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const userRow = await client.query<BudgetTreeRow>(
        'SELECT budget, budget_total, soft_limit, overdraft FROM budget_trees WHERE kind = $1 AND id = $2 FOR UPDATE',
        ['user', ctx.userId],
      )
      const projRow = await client.query<BudgetTreeRow>(
        'SELECT budget, budget_total, soft_limit, overdraft FROM budget_trees WHERE kind = $1 AND id = $2 FOR UPDATE',
        ['project', ctx.projectId],
      )
      // 并行树：任一超限即拒（评审 N3）
      const userState = stateOfTree(userRow.rows[0], need)
      const projState = stateOfTree(projRow.rows[0], need)
      // 双树取更严者（§5）；`reason` 保留区分两树的语义（既有调用方依赖）
      const state = worseOf(userState, projState)
      if (projState === 'hard' && userState !== 'hard') {
        await client.query('ROLLBACK')
        return { approved: false, reason: 'denied-project-budget', ledgerRef: '', state }
      }
      if (userState === 'hard') {
        await client.query('ROLLBACK')
        return { approved: false, reason: 'denied-user-budget', ledgerRef: '', state }
      }
      await client.query('COMMIT')
      return { approved: true, reason: 'ok', ledgerRef: '', state }
    } finally {
      client.release()
    }
  }

  async commit(record: MeterRecord): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // 双树同事务扣减（§8.3 事务消息将扩展为分布式形态；本地 PG 事务满足本地形态）
      //
      // **无条件扣减，允许负数。** 这里曾有 `AND budget >= $2`，于是「余额 500、消耗
      // 600」时 0 行被更新且无报错，余额冻结在 500 而台账照记 —— 下一次 reserve 读到
      // 500 继续放行。一旦「余额 < 单次调用量」，封顶就永久失效，方向朝着无限消费。
      //
      // 允许负数不是放松封顶，恰恰是让封顶可判：余额永远非负时，「已透支多少」这个量
      // 根本不存在，也就无法区分「刚好用完」与「超了三倍」。
      const upd = `UPDATE budget_trees SET budget = budget - $2 WHERE kind = $1 AND id = $3`
      await client.query(upd, ['user', record.tokens, record.context.userId])
      await client.query(upd, ['project', record.tokens, record.context.projectId])
      await insertLedger(client, {
        context: record.context,
        costType: 'llm.tokens',
        qty: record.tokens,
        unit: 'tokens',
        // 现有 commit() 路径尚无 trace 上下文（调用方是 llm/stream 瀑布）。
        // 用显式哨兵而不是空串：空串会和「发出方忘了填」混在一起，而这两件事的
        // 处理方式不同——前者等接线，后者是 bug。
        traceId: record.traceId ?? 'legacy-llm-cross-section',
        emitter: 'metering:llm-cross-section',
        costUsd: record.costUsd,
        tokens: record.tokens,
        model: record.model,
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  /**
   * 成本事件入账（评审 B2 的并行成本流）。
   *
   * **校验在写库之前**：一行脏数据一旦进了 append-only 台账就不能删，删了就破坏了
   * §6.4 的 append-only 承诺。
   */
  async emit(e: CostEvent): Promise<void> {
    assertCostEvent(e)
    const client = await this.pool.connect()
    try {
      await insertLedger(client, e)
    } finally {
      client.release()
    }
  }

  /** 按 trace 取回一条因果链。顺序稳定（ts, id），否则「这次尖峰的构成」每次读都不同。 */
  async byTrace(traceId: string): Promise<CostEvent[]> {
    const rows = await this.raw<LedgerRow>(
      `SELECT * FROM usage_ledger WHERE trace_id = $1 ORDER BY ts ASC, id ASC`,
      [traceId],
    )
    return rows.map(rowToEvent)
  }

  /**
   * 余额查询。**可为负**——负数即透支量。
   *
   * 无预算记录时返回 `+Infinity`，即 **fail open**。这与「未定级即拒绝」的精神相反，
   * 是显式选择而非疏漏：翻成 fail closed 会让所有未预置 `budget_trees` 行的部署
   * 立刻停摆，那是一次生产事故而不是一次修复。正确的收敛路径是先加「预算记录缺失」
   * 告警，观察到零告警后再翻向。这一条已记入评审 B2 落地状态，不要当它已解决。
   */
  async balance(key: { kind: 'user' | 'project'; id: string }): Promise<number> {
    const row = await this.pool.query<{ budget: number }>(
      'SELECT budget FROM budget_trees WHERE kind = $1 AND id = $2',
      [key.kind, key.id],
    )
    // pg 把 BIGINT 读成字符串，不转数字会让 `bal === 5000` 这类断言以字符串比较失败
    const raw = row.rows[0]?.budget
    return raw === undefined ? Number.POSITIVE_INFINITY : Number(raw)
  }

  /**
   * 期初/重配（设计说明 2026-08-26 §3）：本期配额设为 `total`，剩余重置为 `total`。
   *
   * opts 语义：**给则替换对应列，不给则保留存储值**（新行即 NULL 缺省 = softLimit 取
   * budget_total、overdraft 0）——「只改预算、不改软限额」是运维的默认预期。
   *
   * 校验在写入时做（fail closed at config）：配置不自洽（负值/NaN/softLimit > total）
   * 在 `setBudget` 处拒绝，而不是延迟成 `reserve` 判态时的 run 时抛错。
   */
  async setBudget(
    kind: 'user' | 'project', id: string, total: number,
    opts?: { softLimit?: number; overdraft?: number },
  ): Promise<void> {
    resolveLimits(total, opts)
    await this.pool.query(
      `INSERT INTO budget_trees (kind, id, budget, budget_total, soft_limit, overdraft)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (kind, id) DO UPDATE SET
         budget = EXCLUDED.budget,
         budget_total = EXCLUDED.budget_total,
         soft_limit = COALESCE(EXCLUDED.soft_limit, budget_trees.soft_limit),
         overdraft = COALESCE(EXCLUDED.overdraft, budget_trees.overdraft)`,
      [kind, id, total, total, opts?.softLimit ?? null, opts?.overdraft ?? null],
    )
  }

  /**
   * 期中调整（设计说明 2026-08-26 §3）：总额**平移**到 `newTotal`——
   * `remaining += newTotal − oldTotal`，因此 `used = total − remaining` 前后不变。
   *
   * 降额不追溯由此成为机制而非承诺：已发生消费既不回收（used 不变）也不豁免
   * （降额后下一次 reserve 立即按新总额判态，`used ≥ total` 即 hard）。
   *
   * 旧模式行（`budget_total` NULL）拒绝——把「只有剩余」的旧行剩余当成总额去平移是
   * 错的，显式拒绝并给修复指引（先 `setBudget` 重配）；不存在的树同样拒绝。
   */
  async adjustBudget(
    kind: 'user' | 'project', id: string, newTotal: number,
    opts?: { softLimit?: number; overdraft?: number },
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const row = await client.query<BudgetTreeRow>(
        'SELECT budget, budget_total, soft_limit FROM budget_trees WHERE kind = $1 AND id = $2 FOR UPDATE',
        [kind, id],
      )
      const r = row.rows[0]
      if (!r) {
        await client.query('ROLLBACK')
        throw new Error(`要调整的预算树不存在（${kind}:${id}）—— 先用 setBudget 建树`)
      }
      if (r.budget_total == null) {
        await client.query('ROLLBACK')
        throw new Error(
          `旧模式树没有总额，无法调整（${kind}:${id}）—— 先用 setBudget 重配为总额模式`,
        )
      }
      const storedSoft = r.soft_limit == null ? undefined : Number(r.soft_limit)
      const storedOd = r.overdraft == null ? undefined : Number(r.overdraft)
      // 合并后的配置必须自洽——存量软限额超过新总额时在配置处拒绝。
      // 注意：这里只校验；写入用 COALESCE 保持「没给就保留存储值」——把默认值写进列
      // 会把「NULL=跟随总额」静默变成显式配置，之后再降额就会误判为用户配置的自洽性。
      resolveLimits(newTotal, {
        softLimit: opts?.softLimit ?? storedSoft,
        overdraft: opts?.overdraft ?? storedOd,
      })
      const oldTotal = Number(r.budget_total)
      const remaining = Number(r.budget) + (newTotal - oldTotal)
      await client.query(
        `UPDATE budget_trees
           SET budget = $3, budget_total = $4,
               soft_limit = COALESCE($5, budget_trees.soft_limit),
               overdraft = COALESCE($6, budget_trees.overdraft)
           WHERE kind = $1 AND id = $2`,
        [kind, id, remaining, newTotal, opts?.softLimit ?? null, opts?.overdraft ?? null],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  /**
   * 装配层默认预算种子（设计说明 2026-08-26 §4）。
   *
   * **仅当无行时插入**（`ON CONFLICT DO NOTHING`），且插入**旧模式**行（无总额 = 两态）
   * ——「默认不限额」的既有语义是「很大的剩余」，不是「总额 1e9 的四态」；且种子不得
   * 覆盖运维已配置的预算（旧实现每次启动无条件 upsert，运维的硬停/透支会被冲回默认值）。
   */
  async seedDefaultBudget(
    kind: 'user' | 'project', id: string, defaultBudget: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO budget_trees (kind, id, budget) VALUES ($1, $2, $3)
       ON CONFLICT (kind, id) DO NOTHING`,
      [kind, id, defaultBudget],
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** `usage_ledger` 的原始行形状。 */
interface LedgerRow {
  user_id: string; dept_id: string; role: string; project_id: string
  agent_id: string; component_id: string; feature: string; session_ref: string
  model: string | null; tokens: number | string | null
  cost_type: string; cost_usd: number | string
  trace_id: string | null; emitter: string | null
  qty: number | string | null; unit: string | null
}

/**
 * `usage_ledger` 的**唯一写入方法**。
 *
 * `commit()`（LLM 截面）与 `emit()`（其它成本类型）都走它。两条写路径各写一遍
 * INSERT 就是 schema 的第二份副本——加一列时只会改一处，另一处静默过期，而过期的
 * 方向是「新维度在某类成本上永远为空」，看起来像那类成本天生没有 trace。
 *
 * 发出方跨语言（连接器网关是 Go），因此约束是**表只有一个写入者**：Go 侧经 sink
 * 接口交事件，不直连这张表。
 */
/** `budget_trees` 行。BIGINT 列 pg 读成字符串；总额列可空（NULL = 旧模式）。 */
type BudgetTreeRow = {
  budget: string | number
  budget_total: string | number | null
  soft_limit: string | number | null
  overdraft: string | number | null
}

/**
 * 某棵树对「一次 need 大小的调用」的投影状态（口径见契约 `MeterResult.state`）。
 *
 * **两种模式，两个边界，用 `budget_total` 是否为空显式区分**（设计说明 2026-08-26 §2）：
 *
 * - 旧模式（NULL）：只存剩余，退化为旧判据——**这棵树还能不能放下这一次调用**。
 *   边界与既有行为一致：`remaining === need` 仍放行（旧语义是「还有就一定够?」不是，
 *   它是「< 才拒」）。历史行不回填假数据，所以这个模式必须保留。
 * - 总额模式：`used = (total − remaining) + need`，四态由纯策略 `budgetState` 判定，
 *   左闭右开（`used === total` 已越界）。存储空值 = 策略层缺省（softLimit=total、
 *   overdraft=0），由 `resolveLimits` 补齐。
 *
 * 没有行的树没有预算可用（旧实现即「无行即拒」），统一 `hard`——由
 * `state === 'hard'` 单一裁决，而不是散落两个分支各判一遍。
 */
function stateOfTree(row: BudgetTreeRow | undefined, need: number): BudgetState {
  if (!row) return 'hard'
  if (row.budget_total == null) {
    return Number(row.budget) < need ? 'hard' : 'within'
  }
  const total = Number(row.budget_total)
  const remaining = Number(row.budget)
  return budgetState(total - remaining + need, {
    budget: total,
    softLimit: row.soft_limit == null ? undefined : Number(row.soft_limit),
    overdraft: row.overdraft == null ? undefined : Number(row.overdraft),
  })
}

async function insertLedger(client: pg.PoolClient, e: CostEvent): Promise<void> {
  await client.query(
    `INSERT INTO usage_ledger
       (user_id, dept_id, role, project_id, agent_id, component_id, feature,
        session_ref, model, tokens, cost_type, cost_usd, trace_id, emitter, qty, unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      e.context.userId, e.context.deptId, e.context.role, e.context.projectId,
      e.context.agentId, e.context.componentId, e.context.feature, e.context.sessionRef,
      e.model ?? null,
      // 非 token 类型的 tokens 列写 0 而不是 NULL：既有的 SUM(tokens) 报表遇到 NULL
      // 会得到 NULL 而不是原来的数，那是一次静默的报表回归
      e.tokens ?? 0,
      e.costType, e.costUsd, e.traceId, e.emitter, e.qty, e.unit,
    ],
  )
}

function rowToEvent(r: LedgerRow): CostEvent {
  const costType = r.cost_type
  if (!isCostType(costType)) {
    // 读到闭集外的类型说明是本项上线前的历史行，或有人绕过 sink 直写了表
    throw new Error(
      `usage_ledger 中存在闭集外的 cost_type=${costType}（trace=${r.trace_id}）：` +
      `历史行或有写入方绕过了 sink`,
    )
  }
  const e: CostEvent = {
    context: {
      userId: r.user_id, deptId: r.dept_id, role: r.role, projectId: r.project_id,
      agentId: r.agent_id, componentId: r.component_id, feature: r.feature,
      sessionRef: r.session_ref,
    },
    costType,
    qty: Number(r.qty ?? 0),
    unit: r.unit ?? COST_TYPES[costType].unit,
    traceId: r.trace_id ?? '',
    emitter: r.emitter ?? '',
    costUsd: Number(r.cost_usd),
  }
  if (costType === 'llm.tokens') {
    e.tokens = Number(r.tokens ?? 0)
    if (r.model) e.model = r.model
  }
  return e
}
