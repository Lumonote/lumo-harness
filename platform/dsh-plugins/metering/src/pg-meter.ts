/**
 * MeteringSeam 的 PostgreSQL 实现（§6.4 + 评审 N3 并行预算树）。
 * 语义与契约（shared/seam-contracts/metering.ts）一致：
 *   - reserve：双树预算检查，任一超限即拒
 *   - commit：落 usage_ledger 明细（归因链 user/dept/role/project/agent/component/feature）
 * 树扣减原子性：本实现以 PG 事务完成；分布式的 RocketMQ 事务消息在 P2 接入（铁律 5）。
 */
import pg from 'pg'
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
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS budget_commit_seq (
  id BIGSERIAL PRIMARY KEY
);
`

export class PgMeteringSeam implements MeteringSeam {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  async init(): Promise<void> {
    await this.pool.query(METERING_DDL)
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
   */
  async reserve(ctx: MeterContext, estimate?: number): Promise<MeterResult> {
    const need = estimate !== undefined && Number.isFinite(estimate) && estimate > 0
      ? estimate
      : 1
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const userRow = await client.query<{ budget: number }>(
        'SELECT budget FROM budget_trees WHERE kind = $1 AND id = $2 FOR UPDATE',
        ['user', ctx.userId],
      )
      const projRow = await client.query<{ budget: number }>(
        'SELECT budget FROM budget_trees WHERE kind = $1 AND id = $2 FOR UPDATE',
        ['project', ctx.projectId],
      )
      // 并行树：任一超限即拒（评审 N3）
      if (userRow.rows.length === 0 || Number(userRow.rows[0]!.budget) < need) {
        await client.query('ROLLBACK')
        return { approved: false, reason: 'denied-user-budget', ledgerRef: '' }
      }
      if (projRow.rows.length === 0 || Number(projRow.rows[0]!.budget) < need) {
        await client.query('ROLLBACK')
        return { approved: false, reason: 'denied-project-budget', ledgerRef: '' }
      }
      await client.query('COMMIT')
      return { approved: true, reason: 'ok', ledgerRef: '' }
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
      await client.query(
        `INSERT INTO usage_ledger
           (user_id, dept_id, role, project_id, agent_id, component_id, feature, session_ref, model, tokens, cost_type, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          record.context.userId, record.context.deptId, record.context.role,
          record.context.projectId, record.context.agentId, record.context.componentId,
          record.context.feature, record.context.sessionRef, record.model,
          record.tokens, record.costType, record.costUsd,
        ],
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

  async setBudget(kind: 'user' | 'project', id: string, budget: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO budget_trees (kind, id, budget) VALUES ($1,$2,$3)
       ON CONFLICT (kind, id) DO UPDATE SET budget = EXCLUDED.budget`,
      [kind, id, budget],
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
