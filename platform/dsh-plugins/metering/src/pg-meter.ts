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

  async reserve(ctx: MeterContext): Promise<MeterResult> {
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
      if (userRow.rows.length === 0 || userRow.rows[0]!.budget <= 0) {
        await client.query('ROLLBACK')
        return { approved: false, reason: 'denied-user-budget', ledgerRef: '' }
      }
      if (projRow.rows.length === 0 || projRow.rows[0]!.budget <= 0) {
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
      const upd = `UPDATE budget_trees SET budget = budget - $2 WHERE kind = $1 AND id = $3 AND budget >= $2`
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

  async balance(key: { kind: 'user' | 'project'; id: string }): Promise<number> {
    const row = await this.pool.query<{ budget: number }>(
      'SELECT budget FROM budget_trees WHERE kind = $1 AND id = $2',
      [key.kind, key.id],
    )
    return row.rows[0]?.budget ?? Number.POSITIVE_INFINITY
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
