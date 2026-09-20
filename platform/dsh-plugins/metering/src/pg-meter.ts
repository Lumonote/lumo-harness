/**
 * MeteringSeam 的 PostgreSQL 实现（§6.4 + 评审 N3 并行预算树）。
 * 语义与契约（shared/seam-contracts/metering.ts）一致：
 *   - reserve：双树预算检查，任一超限即拒
 *   - commit：预算树扣减 + 事件入 usage_event_outbox（同一事务，设计说明 2026-08-26）；
 *     台账写穿即见换有界最终一致——usage_ledger 由 drainOnce 批量搬入
 * 树扣减原子性：本实现以 PG 事务完成；分布式的 RocketMQ 事务消息在 P2 接入（铁律 5）。
 */
import pg from 'pg'
import ledgerSchema from '../../../shared/manifests/usage-ledger.schema.json' with { type: 'json' }
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
import {
  SCOPE_GOVERNED_RUN,
  type MeterContext,
  type MeterRecord,
  type MeterResult,
  type MeteringSeam,
  type ScopeCapSeam,
} from '../../../shared/seam-contracts/metering.ts'

type LedgerSchema = typeof ledgerSchema & {
  columns: Array<{ name: string; pgType: string; notNull: boolean; default?: string; primaryKey?: boolean }>
}

/** usage_ledger 列名（唯一真相源：shared/manifests/usage-ledger.schema.json）。
 * DDL 与批量 INSERT 的列清单都从这里生成——加列只改清单，两侧生成同源失效即红。 */
export const USAGE_LEDGER_COLUMNS: string[] = (ledgerSchema as LedgerSchema).columns.map((c) => c.name)

/** 由清单生成的 DDL 列段（幂等 CREATE 与清单同步——不再有第二份列清单字符串）。 */
const USAGE_LEDGER_DDL_COLUMNS = (ledgerSchema as LedgerSchema).columns.map((c) =>
  `  ${c.name} ${c.pgType}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.notNull ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${c.default}` : ''}`,
).join(',\n')

export const METERING_DDL = `
CREATE TABLE IF NOT EXISTS usage_ledger (
${USAGE_LEDGER_DDL_COLUMNS}
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

-- 计量事件 outbox（设计说明 2026-08-26 §2）：commit/emit 只写意图，台账由 drain
-- 器批量搬入 —— 扣减 + 事件同事务（原子配套），写穿即见换有界最终一致（§4）。
-- 幂等键由 PG 生成（事件在管线内唯一；重放/至少一次投递靠 event_key 去重）。
CREATE TABLE IF NOT EXISTS usage_event_outbox (
  seq          BIGSERIAL PRIMARY KEY,
  event_key    TEXT NOT NULL UNIQUE,
  payload      JSONB NOT NULL,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ
);

-- 部分索引：只扫未投影的尾巴，已投影历史不拖慢轮询（同 knowledge_graph_outbox）
CREATE INDEX IF NOT EXISTS idx_usage_outbox_pending
  ON usage_event_outbox (seq) WHERE projected_at IS NULL;

-- 作用域金额上限（一次工作的封顶，见 shared/seam-contracts/metering.ts 的 ScopeCapSeam）。
--
-- **单位写在列名里**，这是它没并进 budget_trees 的全部理由：那张表的 budget 列是 **token**，
-- 这里是**分**。同一个列名承担两种单位，读到的人只会按自己那套解释——E4/D6 已经吃过一次
-- 「一个字段两个语义」的亏，不该再吃第二次。
--
-- spent_cents 用 NUMERIC(18,6) 与 usage_ledger.cost_usd 同精度：它是**钱的累加**，
-- 用浮点会在多次小额调用后漂出可观测的分差。
CREATE TABLE IF NOT EXISTS budget_scope_caps (
  scope       TEXT   NOT NULL,
  id          TEXT   NOT NULL,
  cap_cents   BIGINT NOT NULL CHECK (cap_cents >= 0),
  spent_cents NUMERIC(18,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, id)
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

-- 事件幂等键（设计说明 2026-08-26 §2）：存量行 NULL 不迁移——历史行不用假数据回填；
-- UNIQUE 允许多个 NULL，既有行不受约束。unique index 而非列级 UNIQUE，便于
-- ON CONFLICT (event_key) 唯一地命中。
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_event_key_idx ON usage_ledger (event_key);

-- RocketMQ 传输形态（设计说明 2026-08-26 §2/§8）：rmq 装配下搬运由 usage-ledger
-- Go 服务负责（outbox → RocketMQ → usage_ledger），TS 侧 drain 不启动。published_at
-- 与 projected_at 平行、互不清零——同一行双通道各自推进，切换形态不重搬历史。
ALTER TABLE usage_event_outbox ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
-- publisher 批处理主查询路径（FOR UPDATE SKIP LOCKED 只扫未发布尾巴）
CREATE INDEX IF NOT EXISTS idx_usage_outbox_unpublished
  ON usage_event_outbox (seq) WHERE published_at IS NULL;
`

export class PgMeteringSeam implements MeteringSeam, ScopeCapSeam {
  private pool: pg.Pool
  /** drainOnce 单实例内不并发重入（定时间隔小于一轮搬运时长时的压车），同 GraphProjector */
  private running = false
  /**
   * 费率缓存（model → 每百万 token 的输入/输出价）。
   *
   * 缓存的理由不是省那次查询，而是**让「没有这个模型」这件事只被抱怨一次**：未知模型会
   * 一直未知，每次调用都打一行日志会把真正的异常淹掉。因此这里缓存的是 `null`
   * （「查过了，没有」）而不是只缓存命中项。
   */
  private readonly rateCache = new Map<string, { inPerMtok: number; outPerMtok: number } | null>()
  /** 已经为「查不到费率」抱怨过的模型，避免同一个未知模型刷屏。 */
  private readonly warnedModels = new Set<string>()

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  /**
   * 按模型取费率。**与 llm-gateway 用同一张表、同一个公式**——费率只有一份真相源
   * （`llm_providers`），两个计价点各查各的，而不是各自抄一份费率表。
   *
   * 查不到时返回 `undefined` 并**只抱怨一次**：节点侧的 agent 调用拿不到上游账单，只能
   * 靠这张表推价，所以「表里没有这个模型」是一条需要有人去补费率的真实信号，不是噪音。
   */
  private async ratesFor(model: string): Promise<{ inPerMtok: number; outPerMtok: number } | undefined> {
    if (this.rateCache.has(model)) return this.rateCache.get(model) ?? undefined
    let value: { inPerMtok: number; outPerMtok: number } | null = null
    try {
      const row = await this.pool.query<{ price_in_per_mtok: string; price_out_per_mtok: string }>(
        `SELECT price_in_per_mtok, price_out_per_mtok FROM llm_providers WHERE model = $1`, [model],
      )
      const hit = row.rows[0]
      if (hit) value = { inPerMtok: Number(hit.price_in_per_mtok), outPerMtok: Number(hit.price_out_per_mtok) }
    } catch (error) {
      // 表不存在（该部署没装 llm-gateway）与查询失败都走这里：两者都不该让计量失败——
      // 台账本身比成本列更重要，静默降级到「成本未知」并由下面那条 warn 说出来。
      if (!this.warnedModels.has(model)) {
        this.warnedModels.add(model)
        // eslint-disable-next-line no-console
        console.warn(`metering: 读取 llm_providers 费率失败（模型 ${model}），本次起成本按未计处理：`,
          error instanceof Error ? error.message : String(error))
      }
      return undefined
    }
    this.rateCache.set(model, value)
    if (value === null && !this.warnedModels.has(model)) {
      this.warnedModels.add(model)
      // eslint-disable-next-line no-console
      console.warn(`metering: llm_providers 里没有模型 ${model} 的费率，agent 发起的调用成本将记为 0；` +
        '补一行费率即可让历史之后的调用恢复计量（已入账的行不改写——台账是 append-only）')
    }
    return value ?? undefined
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
      // 作用域金额上限（一次工作的封顶）。**有行才查**：没有行 = 这次工作没有封顶，
      // 与「无预算记录时的隐性额度」同一条语义；把它当成「上限是 0」会把每一条没设过
      // 上限的执行全部拒掉。
      //
      // 判据是「**已经花超了**」而不是「这一次会不会超」：预计量是 token，而上限是钱，
      // 两者在这条路径上没法换算。代价是允许**一次**越界（把它顶过线的那次调用），
      // 之后每次调用都会被拦。这是拿不到预估时的诚实做法——编一个换算率反而会让上限
      // 看起来在精确执法。
      const cap = await client.query<{ cap_cents: string; spent_cents: string }>(
        `SELECT cap_cents, spent_cents FROM budget_scope_caps WHERE scope = $1 AND id = $2`,
        [SCOPE_GOVERNED_RUN, ctx.sessionRef],
      )
      const capRow = cap.rows[0]
      if (capRow !== undefined && Number(capRow.spent_cents) >= Number(capRow.cap_cents)) {
        await client.query('ROLLBACK')
        // state 报 `hard`：它与 approved 必须自洽（`approved ⟺ state !== 'hard'`），
        // 而这条拒因本来就是硬顶——没有软限额、没有透支，一次工作没有「下个周期」可言。
        return { approved: false, reason: 'denied-scope-budget', ledgerRef: '', state: 'hard' }
      }
      await client.query('COMMIT')
      return { approved: true, reason: 'ok', ledgerRef: '', state }
    } finally {
      client.release()
    }
  }

  /**
   * 按费率推一次调用的成本。公式与 `llm-gateway/internal/server/server.go:222` 的
   * `cost = (input*PriceIn + output*PriceOut)/1e6` **逐字一致**。
   *
   * 费率只有一份真相源（`llm_providers`），公式却写了两遍——一处改而另一处不改时，两边的
   * 成本会**静默分叉**（同一笔调用在网关侧与节点侧报出不同的价）。各自的测试钉住自己的
   * 结果，所以这条注释的作用是让人在改任一处时想到另一处。
   *
   * 拿不到费率时返回 0，**不猜价**：编一个默认费率会让成本看起来有了，而它是错的，
   * 且错得没有任何痕迹。「为什么是 0」由 `ratesFor` 只抱怨一次。
   */
  private async costOf(record: MeterRecord): Promise<number> {
    const rates = await this.ratesFor(record.model)
    if (!rates) return 0
    const input = record.inputTokens
    const output = record.outputTokens
    let cost: number
    if (input !== undefined && output !== undefined) {
      cost = (input * rates.inPerMtok + output * rates.outPerMtok) / 1e6
    } else {
      // 只知道总数、不知道拆分时，两价取**较高**者计。
      //
      // 这是刻意的保守方向：低估会让金额上限**晚响**（超支已经发生），而高估只是让账更
      // 保守。金额上限是这个成本数唯一的执法用途，所以两个方向的代价不对等。真正的修法
      // 是调用方把 input/output 分开给（节点侧的 hook 已经这么做）。
      cost = (record.tokens * Math.max(rates.inPerMtok, rates.outPerMtok)) / 1e6
    }
    return Number.isFinite(cost) && cost > 0 ? cost : 0
  }

  async commit(record: MeterRecord): Promise<void> {
    // 发出方给了价就用它的（网关侧自己算得出）；没给才按费率推。
    //
    // **`undefined` 与 `0` 在这里分叉**：省略 = 请本函数算；显式 0 = 免费调用，照收。
    // 合并两者的后果是「没人算过价的账」在台账里与「价格真的是零的账」长得一样，
    // 而前者需要有人去补费率。
    const costUsd = record.costUsd ?? await this.costOf(record)
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
      // 作用域上限同步扣减（**钱**，与上面两条的 token 不同单位——这也是它单独一张表的
      // 理由）。没有行时不建行：不限额不等于「上限 0」。
      //
      // scope 固定为受治理执行、id 取会话 ref：一次受治理执行的全部花费都记在它自己的
      // 会话上，所以这个会话里的每一次模型调用都该计入那次执行的上限。将来若出现第二种
      // 作用域，`MeterRecord` 需要一个显式的 scope 字段——**不要**在这里猜第二套规则。
      const costCents = costUsd * 100
      if (costCents > 0) {
        await client.query(
          `UPDATE budget_scope_caps SET spent_cents = spent_cents + $3 WHERE scope = $1 AND id = $2`,
          [SCOPE_GOVERNED_RUN, record.context.sessionRef, costCents],
        )
      }
      const event: CostEvent = {
        context: record.context,
        costType: 'llm.tokens',
        qty: record.tokens,
        unit: 'tokens',
        // 现有 commit() 路径尚无 trace 上下文（调用方是 llm/stream 瀑布）。
        // 用显式哨兵而不是空串：空串会和「发出方忘了填」混在一起，而这两件事的
        // 处理方式不同——前者等接线，后者是 bug。
        traceId: record.traceId ?? 'legacy-llm-cross-section',
        emitter: 'metering:llm-cross-section',
        costUsd,
        tokens: record.tokens,
        model: record.model,
      }
      // 事件经 assertCostEvent 后与扣减**同事务**入 outbox（设计说明 §3 不变式④：
      // 原子配套——本地由 PG 事务满足，集群版由事务消息满足，同一个不变式）。
      assertCostEvent(event)
      await client.query(
        `INSERT INTO usage_event_outbox (event_key, payload) VALUES (gen_random_uuid(), $1)`,
        [JSON.stringify(event)],
      )
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
    await this.pool.query(
      `INSERT INTO usage_event_outbox (event_key, payload) VALUES (gen_random_uuid(), $1)`,
      [JSON.stringify(e)],
    )
  }

  /**
   * 搬运一批未投影事件入台账（设计说明 2026-08-26 §5，本地 = 「PG 事务 outbox +
   * 进程内调度器」的调度端；换 RocketMQ 时只换这个入口的调用者）。
   *
   * 四个跨传输不变式在此兑现：
   * - **一次事件一账**：`ON CONFLICT (event_key) DO NOTHING`——至少一次投递/崩溃重跑
   *   不重复入账（幂等键在写 outbox 时由 PG 生成，发出方不必协商键格式）；
   * - **事件时刻保真**：`ts` 取 outbox 的事件时刻而非 `now()`——账单周期门按事件时刻判，
   *   搬运用时哪怕跨了周期也不能改账的日期；
   * - **顺序稳定**：按 `seq` 序搬，台账内 `(ts, id)` 排序语义不变；
   * - **原子**：批量插入与标记 `projected_at` 同一事务——崩溃窗口只造成重放，不丢账。
   *
   * 毒丸（payload 被手工编辑坏）→ `assertCostEvent` 抛 → 整批回滚 → 下一轮重试；
   * 已知不足：毒丸会阻塞其后的批次（同 knowledge 投影先例，设计说明 §6）。
   */
  async drainOnce(batchSize = 100): Promise<number> {
    if (this.running) return 0
    this.running = true
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const pending = await client.query<OutboxRow>(
        `SELECT seq, ts, event_key, payload FROM usage_event_outbox
         WHERE projected_at IS NULL
         ORDER BY seq
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [Math.max(batchSize, 1)],
      )
      if (pending.rows.length === 0) {
        await client.query('COMMIT')
        return 0
      }

      const rows = pending.rows.map((r) => {
        const e = r.payload as CostEvent
        assertCostEvent(e)   // 写入口已验过；再验一次防手工编辑（毒丸整批回滚）
        return { e, eventKey: r.event_key, ts: r.ts }
      })
      await batchInsertLedger(client, rows)
      await client.query(
        'UPDATE usage_event_outbox SET projected_at = now() WHERE seq = ANY($1::bigint[])',
        [pending.rows.map((r) => r.seq)],
      )
      await client.query('COMMIT')
      return pending.rows.length
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
      this.running = false
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

  /**
   * 设一次工作的金额上限（`capCents`，单位**分**）。
   *
   * 重复设即覆盖，**并把已花清零**：它表达的是「这次工作的额度」。不清零会得到一个很
   * 隐蔽的形态——重跑一次同样的执行，上限还没开始就被上一轮的账顶满了。
   */
  async setCap(scope: string, id: string, capCents: number): Promise<void> {
    if (!Number.isSafeInteger(capCents) || capCents < 0) {
      throw new RangeError(`metering: 上限必须是非负整数分，收到 ${capCents}`)
    }
    await this.pool.query(
      `INSERT INTO budget_scope_caps (scope, id, cap_cents, spent_cents) VALUES ($1,$2,$3,0)
       ON CONFLICT (scope, id) DO UPDATE SET cap_cents = EXCLUDED.cap_cents, spent_cents = 0`,
      [scope, id, capCents],
    )
  }

  async clearCap(scope: string, id: string): Promise<void> {
    await this.pool.query(`DELETE FROM budget_scope_caps WHERE scope = $1 AND id = $2`, [scope, id])
  }

  async spentCents(scope: string, id: string): Promise<number | undefined> {
    const rows = await this.pool.query<{ spent_cents: string }>(
      `SELECT spent_cents FROM budget_scope_caps WHERE scope = $1 AND id = $2`, [scope, id],
    )
    // 没有行返回 `undefined` 而不是 0：「没设过上限」与「设了但一分没花」不是一回事，
    // 而 0 会把前者说成后者。
    return rows.rows[0] === undefined ? undefined : Number(rows.rows[0].spent_cents)
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
 * `usage_ledger` 的**唯一写入方法**（批量版）。
 *
 * `drainOnce` 是它唯一的调用方（设计说明 2026-08-26 §2：写穿即见换有界最终一致，
 * 台账只由搬运器写入）。多行单语句 INSERT 即削峰本体：一批事件一次事务，而不是
 * 每事件的独立小 INSERT。
 *
 * 发出方跨语言（连接器网关是 Go），因此约束是**表只有一个写入者**：Go 侧经 sink
 * 接口交事件，不直连这张表。
 */
/** INSERT 列（不含 self 主键 id）；列清单由清单生成（单一真相源）。 */
const INSERT_COLUMNS = USAGE_LEDGER_COLUMNS.filter((n) => n !== 'id').join(', ')

async function batchInsertLedger(
  client: pg.PoolClient,
  rows: Array<{ e: CostEvent; eventKey: string; ts: Date }>,
): Promise<void> {
  const values: string[] = []
  const params: unknown[] = []
  for (const { e, eventKey, ts } of rows) {
    values.push(
      `($${params.length + 1},$${params.length + 2},$${params.length + 3},$${params.length + 4},` +
      `$${params.length + 5},$${params.length + 6},$${params.length + 7},$${params.length + 8},` +
      `$${params.length + 9},$${params.length + 10},$${params.length + 11},$${params.length + 12},` +
      `$${params.length + 13},$${params.length + 14},$${params.length + 15},$${params.length + 16},` +
      `$${params.length + 17},$${params.length + 18})`,
    )
    // 每一行固定 18 个参数：列数每变一次，这里必须有意识改一次（生成列数与
    // this push 数不符会在插入时以「参数数量不匹配」响亮失败——不会被静默错过）
    params.push(
      ts,   // 事件时刻（outbox.ts），不是投影时刻（不变式②）
      e.context.userId, e.context.deptId, e.context.role, e.context.projectId,
      e.context.agentId, e.context.componentId, e.context.feature, e.context.sessionRef,
      e.model ?? null,
      // 非 token 类型的 tokens 列写 0 而不是 NULL：既有的 SUM(tokens) 报表遇到 NULL
      // 会得到 NULL 而不是原来的数，那是一次静默的报表回归
      e.tokens ?? 0,
      e.costType, e.costUsd, e.traceId, e.emitter, e.qty, e.unit, eventKey,
    )
  }
  await client.query(
    `INSERT INTO usage_ledger
       (${INSERT_COLUMNS})
     VALUES ${values.join(',')}
     ON CONFLICT (event_key) DO NOTHING`,
    params,
  )
}

/** `budget_trees` 行。BIGINT 列 pg 读成字符串；总额列可空（NULL = 旧模式）。 */
type BudgetTreeRow = {
  budget: string | number
  budget_total: string | number | null
  soft_limit: string | number | null
  overdraft: string | number | null
}

/** `usage_event_outbox` 行。`seq` 是 BIGINT（pg 读成字符串），`ts` 是事件时刻，
 * `payload` 是已通过 assertCostEvent 的 CostEvent（jsonb 被 pg 解析为对象）。 */
type OutboxRow = {
  seq: string
  ts: Date
  event_key: string
  payload: CostEvent
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
