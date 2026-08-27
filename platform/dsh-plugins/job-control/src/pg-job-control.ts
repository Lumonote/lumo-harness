/**
 * PG-backed job control channel.
 *
 * The database is the control-plane mailbox, not a second job registry: a
 * dispatch only records an authorized, idempotent command for `ref.node`.
 * That node's executor performs the local `ctx.jobs` action and records the
 * resulting terminal event. This preserves the OS-handle affinity boundary.
 */
import pg from 'pg'

import {
  assertJobRef,
  formatJobRef,
  isTerminal,
  type JobControlDecision,
  type JobControlRequest,
  type JobControlSeam,
  type JobLifecycleStatus,
  type JobRef,
  type JobResultEvent,
  type JobSnapshotView,
  type TerminalJobStatus,
} from '../../../shared/seam-contracts/job-virtualization.ts'

export const JOB_CONTROL_DDL = `
CREATE TABLE IF NOT EXISTS job_execution (
  session_ref       TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  job_id            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  label             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('running','stopping','completed','killed','failed')),
  detail            TEXT NULL,
  started_at        BIGINT NOT NULL,
  finished_at       BIGINT NULL,
  started_recorded  BOOLEAN NOT NULL DEFAULT FALSE,
  finished_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (session_ref, node_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_event_seq (
  session_ref TEXT PRIMARY KEY,
  next_seq    BIGINT NOT NULL CHECK (next_seq > 0)
);

CREATE TABLE IF NOT EXISTS job_result_event (
  session_ref TEXT NOT NULL,
  seq         BIGINT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('job/started','job/output','job/finished')),
  node_id     TEXT NOT NULL,
  job_id      TEXT NOT NULL,
  kind        TEXT NULL,
  label       TEXT NULL,
  text        TEXT NULL,
  status      TEXT NULL CHECK (status IS NULL OR status IN ('completed','killed','failed')),
  detail      TEXT NULL,
  event_at    BIGINT NOT NULL,
  PRIMARY KEY (session_ref, seq)
);

CREATE TABLE IF NOT EXISTS job_control_command (
  correlation_id TEXT PRIMARY KEY,
  session_ref    TEXT NOT NULL,
  node_id        TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  command        TEXT NOT NULL CHECK (command IN ('kill','timeout','status')),
  actor          TEXT NOT NULL,
  role           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  allowed        BOOLEAN NOT NULL,
  decision_effect TEXT NULL CHECK (decision_effect IS NULL OR decision_effect IN ('requested','already-terminal','observed')),
  denied_reason  TEXT NULL CHECK (denied_reason IS NULL OR denied_reason IN ('not-authorized','unknown-job')),
  locked_at      TIMESTAMPTZ NULL,
  delivered_at   TIMESTAMPTZ NULL,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_control_inbox
  ON job_control_command (node_id, delivered_at, locked_at)
  WHERE allowed = TRUE AND delivered_at IS NULL;
`

export interface JobControlPolicy {
  evaluate(request: JobControlRequest): boolean
}

/** Default conservative policy: display-only roles cannot control execution. */
export class RoleJobControlPolicy implements JobControlPolicy {
  constructor(private readonly allowedRoles: readonly string[] = ['operator', 'admin', 'owner']) {}

  evaluate(request: JobControlRequest): boolean {
    return this.allowedRoles.includes(request.role)
  }
}

export interface LocalJobSnapshot {
  ref: JobRef
  kind: string
  label: string
  status: JobLifecycleStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

export interface PendingJobControl {
  correlationId: string
  ref: JobRef
  command: 'kill' | 'timeout'
  reason: string
}

/** Extra executor-facing half of the seam; it is deliberately not public to callers. */
export interface JobControlInbox {
  record(snapshot: LocalJobSnapshot): Promise<void>
  take(node: string, limit?: number): Promise<PendingJobControl[]>
  ack(correlationId: string): Promise<void>
}

type ExecutionRow = {
  session_ref: string
  node_id: string
  job_id: string
  kind: string
  label: string
  status: JobLifecycleStatus
  detail: string | null
  started_at: string | number
  finished_at: string | number | null
}

type DecisionRow = {
  allowed: boolean
  decision_effect: 'requested' | 'already-terminal' | 'observed' | null
  denied_reason: 'not-authorized' | 'unknown-job' | null
}

type UnsequencedJobResultEvent =
  | { type: 'job/started'; ref: JobRef; kind: string; label: string; startedAt: number }
  | { type: 'job/output'; ref: JobRef; text: string }
  | { type: 'job/finished'; ref: JobRef; status: TerminalJobStatus; detail?: string; finishedAt: number }

/**
 * Durable control mailbox + durable event stream. Commands use a short lease:
 * a node crash after take but before ack becomes eligible again, while a
 * successful local action is itself idempotent in `ctx.jobs`.
 */
export class PgJobControlSeam implements JobControlSeam, JobControlInbox {
  private readonly pool: pg.Pool
  private initPromise: Promise<void> | undefined

  constructor(connectionString: string, private readonly policy: JobControlPolicy = new RoleJobControlPolicy()) {
    this.pool = new pg.Pool({ connectionString })
  }

  async init(): Promise<void> {
    this.initPromise ??= this.pool.query(JOB_CONTROL_DDL).then(() => undefined)
    await this.initPromise
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async dispatch(request: JobControlRequest): Promise<JobControlDecision> {
    await this.init()
    assertJobRef(request.ref)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const prior = await client.query<DecisionRow>(
        'SELECT allowed, decision_effect, denied_reason FROM job_control_command WHERE correlation_id = $1',
        [request.correlationId],
      )
      if (prior.rows[0]) {
        await client.query('COMMIT')
        return decisionOf(prior.rows[0])
      }

      // Authorization precedes existence checks: a caller must not use this
      // mailbox as a probing oracle for other sessions' jobs.
      if (!this.policy.evaluate(request)) {
        const decision: JobControlDecision = { allowed: false, reason: 'not-authorized' }
        await this.insertDecision(client, request, decision)
        await client.query('COMMIT')
        return decision
      }

      const row = await client.query<ExecutionRow>(
        `SELECT session_ref, node_id, job_id, kind, label, status, detail, started_at, finished_at
         FROM job_execution WHERE session_ref = $1 AND node_id = $2 AND job_id = $3 FOR UPDATE`,
        [request.ref.sessionRef, request.ref.node, request.ref.jobId],
      )
      const job = row.rows[0]
      let decision: JobControlDecision
      if (!job) decision = { allowed: false, reason: 'unknown-job' }
      else if (request.command === 'status') decision = { allowed: true, effect: 'observed' }
      else if (isTerminal(job.status)) decision = { allowed: true, effect: 'already-terminal' }
      else decision = { allowed: true, effect: 'requested' }

      await this.insertDecision(client, request, decision)
      await client.query('COMMIT')
      return decision
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async events(sessionRef: string, fromSeq?: number): Promise<JobResultEvent[]> {
    await this.init()
    const rows = await this.pool.query<{
      seq: string | number; event_type: JobResultEvent['type']; node_id: string; job_id: string
      kind: string | null; label: string | null; text: string | null; status: TerminalJobStatus | null
      detail: string | null; event_at: string | number
    }>(
      `SELECT seq, event_type, node_id, job_id, kind, label, text, status, detail, event_at
       FROM job_result_event WHERE session_ref = $1 AND ($2::BIGINT IS NULL OR seq >= $2)
       ORDER BY seq`,
      [sessionRef, fromSeq ?? null],
    )
    return rows.rows.map((row) => eventOf(sessionRef, row))
  }

  async snapshot(ref: JobRef): Promise<JobSnapshotView | undefined> {
    await this.init()
    assertJobRef(ref)
    const rows = await this.pool.query<ExecutionRow>(
      `SELECT session_ref, node_id, job_id, kind, label, status, detail, started_at, finished_at
       FROM job_execution WHERE session_ref = $1 AND node_id = $2 AND job_id = $3`,
      [ref.sessionRef, ref.node, ref.jobId],
    )
    return rows.rows[0] ? snapshotOf(rows.rows[0]) : undefined
  }

  async record(snapshot: LocalJobSnapshot): Promise<void> {
    await this.init()
    assertJobRef(snapshot.ref)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query<{ started_recorded: boolean; finished_recorded: boolean }>(
        `SELECT started_recorded, finished_recorded FROM job_execution
         WHERE session_ref = $1 AND node_id = $2 AND job_id = $3 FOR UPDATE`,
        [snapshot.ref.sessionRef, snapshot.ref.node, snapshot.ref.jobId],
      )
      const prior = existing.rows[0]
      if (!prior) {
        await client.query(
          `INSERT INTO job_execution
           (session_ref,node_id,job_id,kind,label,status,detail,started_at,finished_at,started_recorded,finished_recorded)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,FALSE)`,
          [snapshot.ref.sessionRef, snapshot.ref.node, snapshot.ref.jobId, snapshot.kind, snapshot.label,
            snapshot.status, snapshot.detail ?? null, snapshot.startedAt, snapshot.finishedAt ?? null],
        )
        await this.append(client, {
          type: 'job/started', ref: snapshot.ref, kind: snapshot.kind, label: snapshot.label, startedAt: snapshot.startedAt,
        })
        await client.query(
          `UPDATE job_execution SET started_recorded = TRUE
           WHERE session_ref = $1 AND node_id = $2 AND job_id = $3`,
          [snapshot.ref.sessionRef, snapshot.ref.node, snapshot.ref.jobId],
        )
      } else {
        await client.query(
          `UPDATE job_execution SET kind = $4, label = $5, status = $6, detail = $7, started_at = $8,
             finished_at = $9
           WHERE session_ref = $1 AND node_id = $2 AND job_id = $3`,
          [snapshot.ref.sessionRef, snapshot.ref.node, snapshot.ref.jobId, snapshot.kind, snapshot.label,
            snapshot.status, snapshot.detail ?? null, snapshot.startedAt, snapshot.finishedAt ?? null],
        )
      }
      if (isTerminal(snapshot.status) && !prior?.finished_recorded) {
        await this.append(client, {
          type: 'job/finished', ref: snapshot.ref, status: snapshot.status,
          ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
          finishedAt: snapshot.finishedAt ?? Date.now(),
        })
        await client.query(
          `UPDATE job_execution SET finished_recorded = TRUE
           WHERE session_ref = $1 AND node_id = $2 AND job_id = $3`,
          [snapshot.ref.sessionRef, snapshot.ref.node, snapshot.ref.jobId],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async take(node: string, limit = 32): Promise<PendingJobControl[]> {
    await this.init()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const rows = await client.query<{
        correlation_id: string; session_ref: string; node_id: string; job_id: string; command: 'kill' | 'timeout'; reason: string
      }>(
        `WITH picked AS (
           SELECT correlation_id FROM job_control_command
           WHERE node_id = $1 AND command IN ('kill','timeout') AND allowed = TRUE AND delivered_at IS NULL
             AND (locked_at IS NULL OR locked_at < now() - interval '30 seconds')
           ORDER BY decided_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE job_control_command c SET locked_at = now()
         FROM picked WHERE c.correlation_id = picked.correlation_id
         RETURNING c.correlation_id, c.session_ref, c.node_id, c.job_id, c.command, c.reason`,
        [node, limit],
      )
      await client.query('COMMIT')
      return rows.rows.map((row) => ({
        correlationId: row.correlation_id,
        ref: { sessionRef: row.session_ref, node: row.node_id, jobId: row.job_id },
        command: row.command,
        reason: row.reason,
      }))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async ack(correlationId: string): Promise<void> {
    await this.init()
    await this.pool.query(
      `UPDATE job_control_command SET delivered_at = now() WHERE correlation_id = $1`,
      [correlationId],
    )
  }

  private async insertDecision(client: pg.PoolClient, request: JobControlRequest, decision: JobControlDecision): Promise<void> {
    await client.query(
      `INSERT INTO job_control_command
       (correlation_id,session_ref,node_id,job_id,command,actor,role,reason,allowed,decision_effect,denied_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [request.correlationId, request.ref.sessionRef, request.ref.node, request.ref.jobId,
        request.command, request.actor, request.role, request.reason, decision.allowed,
        decision.allowed ? decision.effect : null, decision.allowed ? null : decision.reason],
    )
  }

  private async append(
    client: pg.PoolClient,
    event: UnsequencedJobResultEvent,
  ): Promise<void> {
    const seq = await nextSeq(client, event.ref.sessionRef)
    if (event.type === 'job/started') {
      await client.query(
        `INSERT INTO job_result_event
         (session_ref,seq,event_type,node_id,job_id,kind,label,event_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [event.ref.sessionRef, seq, event.type, event.ref.node, event.ref.jobId, event.kind, event.label, event.startedAt],
      )
    } else if (event.type === 'job/output') {
      await client.query(
        `INSERT INTO job_result_event (session_ref,seq,event_type,node_id,job_id,text,event_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [event.ref.sessionRef, seq, event.type, event.ref.node, event.ref.jobId, event.text, Date.now()],
      )
    } else {
      await client.query(
        `INSERT INTO job_result_event
         (session_ref,seq,event_type,node_id,job_id,status,detail,event_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [event.ref.sessionRef, seq, event.type, event.ref.node, event.ref.jobId, event.status,
          event.detail ?? null, event.finishedAt],
      )
    }
  }
}

async function nextSeq(client: pg.PoolClient, sessionRef: string): Promise<number> {
  const result = await client.query<{ seq: string | number }>(
    `INSERT INTO job_event_seq (session_ref, next_seq) VALUES ($1, 2)
     ON CONFLICT (session_ref) DO UPDATE SET next_seq = job_event_seq.next_seq + 1
     RETURNING next_seq - 1 AS seq`,
    [sessionRef],
  )
  return Number(result.rows[0]!.seq)
}

function decisionOf(row: DecisionRow): JobControlDecision {
  if (row.allowed) return { allowed: true, effect: row.decision_effect ?? 'requested' }
  return { allowed: false, reason: row.denied_reason ?? 'not-authorized' }
}

function snapshotOf(row: ExecutionRow): JobSnapshotView {
  return {
    ref: { sessionRef: row.session_ref, node: row.node_id, jobId: row.job_id },
    kind: row.kind,
    status: row.status,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    startedAt: Number(row.started_at),
    ...(row.finished_at !== null ? { finishedAt: Number(row.finished_at) } : {}),
  }
}

function eventOf(sessionRef: string, row: {
  seq: string | number; event_type: JobResultEvent['type']; node_id: string; job_id: string
  kind: string | null; label: string | null; text: string | null; status: TerminalJobStatus | null
  detail: string | null; event_at: string | number
}): JobResultEvent {
  const ref = { sessionRef, node: row.node_id, jobId: row.job_id }
  if (row.event_type === 'job/started') {
    return { type: row.event_type, seq: Number(row.seq), ref, kind: row.kind ?? '', label: row.label ?? '', startedAt: Number(row.event_at) }
  }
  if (row.event_type === 'job/output') {
    return { type: row.event_type, seq: Number(row.seq), ref, text: row.text ?? '' }
  }
  return {
    type: row.event_type, seq: Number(row.seq), ref, status: row.status ?? 'failed',
    ...(row.detail !== null ? { detail: row.detail } : {}), finishedAt: Number(row.event_at),
  }
}
