/**
 * 恢复日志的 PG 实现（WAL：意图先写、结果后写）。
 *
 * 关键约束：**intent 必须在工具执行之前提交**。若与执行同事务，崩溃时事务回滚，
 * 意图就消失了——而外部副作用已经发生，这正是要防的情形。故 intent 独立事务先落地。
 */
import pg from 'pg'
import type {
  CallIntent,
  CallOutcome,
  RecoverySeam,
  ResumeVerdict,
} from '../../../shared/seam-contracts/recovery.ts'
import { adjudicateIntent } from '../../../shared/seam-contracts/recovery.ts'

export const RECOVERY_DDL = `
CREATE TABLE IF NOT EXISTS tool_call_journal (
  idempotency_key  TEXT PRIMARY KEY,
  session_ref      TEXT NOT NULL,
  turn             INTEGER NOT NULL,
  tool_name        TEXT NOT NULL,
  args_fingerprint TEXT NOT NULL,
  idempotency      TEXT NOT NULL,
  started_at       BIGINT NOT NULL,
  -- NULL = 孤儿（有意图无结果）：resume 的危险区
  status           TEXT NULL,
  finished_at      BIGINT NULL,
  detail           TEXT NULL,
  -- 人工确认放行（HITL）
  confirmed_by     TEXT NULL,
  confirmed_at     BIGINT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_orphans
  ON tool_call_journal (session_ref) WHERE status IS NULL;
`

export class PgRecoveryJournal implements RecoverySeam {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  async init(): Promise<void> {
    await this.pool.query(RECOVERY_DDL)
  }

  async recordIntent(intent: CallIntent): Promise<{ replay: boolean; priorOutcome?: CallOutcome }> {
    // 幂等键冲突 = 这次调用是重放。DO NOTHING 后回读既有记录判断该跳过还是该重试。
    const inserted = await this.pool.query(
      `INSERT INTO tool_call_journal
         (idempotency_key, session_ref, turn, tool_name, args_fingerprint, idempotency, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [intent.idempotencyKey, intent.sessionRef, intent.turn, intent.toolName,
       intent.argsFingerprint, intent.idempotency, intent.startedAt],
    )
    if ((inserted.rowCount ?? 0) > 0) return { replay: false }

    const prior = await this.pool.query<{ status: string | null; finished_at: string | null; detail: string | null }>(
      'SELECT status, finished_at, detail FROM tool_call_journal WHERE idempotency_key = $1',
      [intent.idempotencyKey],
    )
    const row = prior.rows[0]
    if (!row || row.status === null) {
      // 重放且前次是孤儿：外部副作用状态未知 —— 交由 adjudicate 决定
      return { replay: true }
    }
    return {
      replay: true,
      priorOutcome: {
        status: row.status as 'completed' | 'failed' | 'rejected',
        finishedAt: Number(row.finished_at ?? 0),
        ...(row.status === 'failed' ? { error: row.detail ?? '' } : {}),
        ...(row.status === 'rejected' ? { reason: row.detail ?? '' } : {}),
      } as CallOutcome,
    }
  }

  async recordOutcome(idempotencyKey: string, outcome: CallOutcome): Promise<void> {
    const detail = outcome.status === 'failed' ? outcome.error
      : outcome.status === 'rejected' ? outcome.reason
      : null
    await this.pool.query(
      'UPDATE tool_call_journal SET status = $2, finished_at = $3, detail = $4 WHERE idempotency_key = $1',
      [idempotencyKey, outcome.status, outcome.finishedAt, detail],
    )
  }

  async orphans(sessionRef: string): Promise<CallIntent[]> {
    const rows = await this.pool.query<{
      idempotency_key: string
      session_ref: string
      turn: number
      tool_name: string
      args_fingerprint: string
      idempotency: string
      started_at: string
    }>(
      `SELECT idempotency_key, session_ref, turn, tool_name, args_fingerprint, idempotency, started_at
       FROM tool_call_journal WHERE session_ref = $1 AND status IS NULL
       ORDER BY started_at`,
      [sessionRef],
    )
    return rows.rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      sessionRef: r.session_ref,
      turn: r.turn,
      toolName: r.tool_name,
      argsFingerprint: r.args_fingerprint,
      idempotency: r.idempotency as CallIntent['idempotency'],
      startedAt: Number(r.started_at),
    }))
  }

  adjudicate(intent: CallIntent): ResumeVerdict {
    return adjudicateIntent(intent, false)
  }

  /** 带确认状态的裁决（读库判断是否已被人工放行） */
  async adjudicateAsync(intent: CallIntent): Promise<ResumeVerdict> {
    const row = await this.pool.query<{ confirmed_by: string | null }>(
      'SELECT confirmed_by FROM tool_call_journal WHERE idempotency_key = $1',
      [intent.idempotencyKey],
    )
    return adjudicateIntent(intent, row.rows[0]?.confirmed_by != null)
  }

  async confirm(idempotencyKey: string, actor: string): Promise<void> {
    const res = await this.pool.query(
      'UPDATE tool_call_journal SET confirmed_by = $2, confirmed_at = $3 WHERE idempotency_key = $1 AND status IS NULL',
      [idempotencyKey, actor, Date.now()],
    )
    if ((res.rowCount ?? 0) === 0) {
      throw new Error(`recovery: 幂等键 ${idempotencyKey} 不存在或已有结果，不可确认放行`)
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
