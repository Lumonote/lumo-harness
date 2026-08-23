/**
 * 共享执行控制的 PostgreSQL 实现（§8.4 + 铁律 18）。
 *
 * 控制指令是一等审计事件：经策略点评估 → 落审计 → 作用于会话状态。
 * 幂等：同 correlationId 只生效一次（§8.3 至少一次投递按 id 去重）。
 * 权限：三层取交集（realm RBAC ∩ 项目角色 ∩ 会话控制权），且项目权限不得提升
 * realm 权限（评审 N4 —— 否则建项目即可越权，是权限提升漏洞）。
 */
import pg from 'pg'
import type {
  ControlAudit,
  ControlCommand,
  ControlDecision,
  ControlPolicy,
  ControlRequest,
  ControlSeam,
} from '../../../shared/seam-contracts/control.ts'

export const CONTROL_DDL = `
CREATE TABLE IF NOT EXISTS session_control_audit (
  request_id   TEXT PRIMARY KEY,
  command      TEXT NOT NULL,
  session_ref  TEXT NOT NULL,
  actor        TEXT NOT NULL,
  role         TEXT NOT NULL,
  realm        TEXT NOT NULL,
  reason       TEXT NOT NULL,
  allowed      BOOLEAN NOT NULL,
  denied_cause TEXT NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_control_audit_session ON session_control_audit (session_ref, decided_at);

-- 会话控制状态：pause/resume/abort 的生效结果（终端只渲染，不实现状态机 —— 铁律 18）
CREATE TABLE IF NOT EXISTS session_control_state (
  session_ref TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('running','paused','stopping','aborted')),
  reason      TEXT NULL,
  actor       TEXT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话控制权名单（session manifest 指派的 co-controller，§8.4.2）
CREATE TABLE IF NOT EXISTS session_controllers (
  session_ref TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  commands    TEXT[] NOT NULL,
  PRIMARY KEY (session_ref, user_id)
);
`

/** 指令 → 目标状态（仅状态型指令；approve/reject/replay/degrade 不改状态机） */
const STATE_TRANSITIONS: Partial<Record<ControlCommand, 'running' | 'paused' | 'stopping' | 'aborted'>> = {
  pause: 'paused',
  resume: 'running',
  stop: 'stopping',
  abort: 'aborted',
}

export type SessionControlState = 'running' | 'paused' | 'stopping' | 'aborted'

export class PgControlSeam implements ControlSeam {
  private pool: pg.Pool
  private readonly policy: ControlPolicy

  constructor(connectionString: string, policy: ControlPolicy) {
    this.pool = new pg.Pool({ connectionString })
    this.policy = policy
  }

  async init(): Promise<void> {
    await this.pool.query(CONTROL_DDL)
  }

  async dispatch(request: ControlRequest): Promise<ControlDecision> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // 幂等去重：同 correlationId 已决策则原样返回（不产生第二次动作、不重复审计）
      const seen = await client.query<{ allowed: boolean; denied_cause: string | null }>(
        'SELECT allowed, denied_cause FROM session_control_audit WHERE request_id = $1',
        [request.correlationId],
      )
      if (seen.rows.length > 0) {
        await client.query('COMMIT')
        const row = seen.rows[0]!
        return row.allowed
          ? { allowed: true }
          : { allowed: false, reason: (row.denied_cause as ControlDecision['reason']) ?? 'policy-denied' }
      }

      // 策略评估（OPA 单点；实现由装配层注入）
      let decision = this.policy.evaluate({
        command: request.command,
        actor: request.actor,
        role: request.role,
        realm: request.realm,
        sessionRef: request.sessionRef,
      })

      // 会话控制权名单校验（取交集：策略通过 ∧ 名单授予该指令）
      if (decision.allowed) {
        const grant = await client.query<{ commands: string[] }>(
          'SELECT commands FROM session_controllers WHERE session_ref = $1 AND user_id = $2',
          [request.sessionRef, request.actor],
        )
        // 无名单记录 = 该会话未限定 co-controller（沿用策略结论）；有记录则必须含该指令
        if (grant.rows.length > 0 && !grant.rows[0]!.commands.includes(request.command)) {
          decision = { allowed: false, reason: 'not-authorized' }
        }
      }

      await client.query(
        `INSERT INTO session_control_audit
           (request_id, command, session_ref, actor, role, realm, reason, allowed, denied_cause)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [request.correlationId, request.command, request.sessionRef, request.actor,
         request.role, request.realm, request.reason, decision.allowed, decision.reason ?? null],
      )

      // 状态型指令生效（approve/reject/replay/degrade 只留审计，不改状态机）
      const target = STATE_TRANSITIONS[request.command]
      if (decision.allowed && target) {
        await client.query(
          `INSERT INTO session_control_state (session_ref, state, reason, actor)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (session_ref) DO UPDATE SET
             state = EXCLUDED.state, reason = EXCLUDED.reason,
             actor = EXCLUDED.actor, updated_at = now()`,
          [request.sessionRef, target, request.reason, request.actor],
        )
      }

      await client.query('COMMIT')
      return decision
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async audit(sessionRef: string): Promise<ControlAudit[]> {
    const rows = await this.pool.query<{
      request_id: string
      command: string
      session_ref: string
      actor: string
      allowed: boolean
      decided_at: Date
    }>(
      `SELECT request_id, command, session_ref, actor, allowed, decided_at
       FROM session_control_audit WHERE session_ref = $1 ORDER BY decided_at`,
      [sessionRef],
    )
    return rows.rows.map((r) => ({
      requestId: r.request_id,
      command: r.command as ControlCommand,
      sessionRef: r.session_ref,
      actor: r.actor,
      allowed: r.allowed,
      decidedAt: r.decided_at.getTime(),
    }))
  }

  /** 当前控制状态（agent 生命周期挂点读取） */
  async state(sessionRef: string): Promise<SessionControlState> {
    const row = await this.pool.query<{ state: SessionControlState }>(
      'SELECT state FROM session_control_state WHERE session_ref = $1',
      [sessionRef],
    )
    return row.rows[0]?.state ?? 'running'
  }

  /** 指派会话控制权（§8.4.2 co-controller 名单） */
  async grant(sessionRef: string, userId: string, commands: ControlCommand[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_controllers (session_ref, user_id, commands) VALUES ($1,$2,$3)
       ON CONFLICT (session_ref, user_id) DO UPDATE SET commands = EXCLUDED.commands`,
      [sessionRef, userId, commands],
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
