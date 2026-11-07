import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { forbidden, invalid } from '../../../shared/seam-contracts/errors.ts'
import { ReceiptConflictError } from '../../../shared/subagent-receipts.ts'
import type { ChildResultBody, StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'
import { assertAllowedCallback } from './callback-policy.ts'

export const START_GUARD_DDL = `CREATE TABLE IF NOT EXISTS subagent_start_guard (
  realm TEXT NOT NULL, child_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  node_id TEXT NOT NULL, cancelled BOOLEAN NOT NULL DEFAULT false,
  admitted BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,child_id)
);
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS start_request JSONB;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS boot_holder TEXT;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS boot_token BIGINT;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS settled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subagent_start_guard ADD COLUMN IF NOT EXISTS cancel_all BOOLEAN NOT NULL DEFAULT false;
UPDATE subagent_start_guard SET cancel_all=true WHERE attempt=0 AND cancelled=true AND cancel_all=false;
CREATE TABLE IF NOT EXISTS subagent_host_boot (
  node_id TEXT PRIMARY KEY, holder TEXT NOT NULL, fencing_token BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
)`

/** Permanent fencing: retrying the old process's receipt cannot restore ownership. */
export class HostBootLeaseError extends ReceiptConflictError {
  constructor() { super(); this.message = 'subagent host boot lease is unavailable or has been fenced' }
}

/** A stable execution node can have only one live process generation in PostgreSQL. */
export class PgHostBootLease {
  readonly holder = randomUUID()
  private token: number | undefined
  private deadline = 0
  private active = false
  constructor(private readonly pool: Pool, readonly nodeId: string, readonly ttlMs = 30_000) {
    if (!nodeId || !Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 300_000) throw new Error('invalid host boot lease identity or TTL')
  }
  isOwned(): boolean { return this.active && performance.now() < this.deadline }
  get fencingToken(): number | undefined { return this.token }
  async init(): Promise<void> { await new PgDurableStartGuard(this.pool, this.nodeId).init() }
  async acquire(): Promise<void> {
    const started = performance.now()
    try {
      const result = await this.pool.query<{ fencing_token: string }>(`INSERT INTO subagent_host_boot(node_id,holder,fencing_token,expires_at)
        VALUES($1,$2,1,clock_timestamp()+$3 * interval '1 millisecond')
        ON CONFLICT(node_id) DO UPDATE SET holder=EXCLUDED.holder,
          fencing_token=CASE WHEN subagent_host_boot.holder=EXCLUDED.holder AND subagent_host_boot.expires_at>clock_timestamp()
            THEN subagent_host_boot.fencing_token ELSE subagent_host_boot.fencing_token+1 END,
          expires_at=clock_timestamp()+$3 * interval '1 millisecond'
        WHERE subagent_host_boot.expires_at<=clock_timestamp() OR subagent_host_boot.holder=EXCLUDED.holder
        RETURNING fencing_token`, [this.nodeId, this.holder, this.ttlMs])
      if (!result.rowCount) throw new HostBootLeaseError()
      this.token = Number(result.rows[0]!.fencing_token)
      this.deadline = started + this.ttlMs
      this.active = true
      if (!this.isOwned()) throw new HostBootLeaseError()
    } catch (error) { this.active = false; throw error }
  }
  async renew(): Promise<void> {
    if (!this.isOwned()) { this.active = false; throw new HostBootLeaseError() }
    const started = performance.now()
    try {
      const result = await this.pool.query(`UPDATE subagent_host_boot SET expires_at=clock_timestamp()+$4 * interval '1 millisecond'
        WHERE node_id=$1 AND holder=$2 AND fencing_token=$3 AND expires_at>clock_timestamp() RETURNING node_id`,
      [this.nodeId, this.holder, this.token, this.ttlMs])
      if (!result.rowCount) throw new HostBootLeaseError()
      this.deadline = started + this.ttlMs
      if (!this.isOwned()) throw new HostBootLeaseError()
    } catch (error) { this.active = false; throw error }
  }
  async assertOwned(): Promise<void> {
    const client = await this.pool.connect()
    try { await this.lockOwned(client) } finally { client.release() }
  }
  /** Held until the caller commits, so admission and receipt commits cannot cross a takeover. */
  async lockOwned(client: PoolClient): Promise<void> {
    if (!this.isOwned()) { this.active = false; throw new HostBootLeaseError() }
    const result = await client.query(`SELECT node_id FROM subagent_host_boot
      WHERE node_id=$1 AND holder=$2 AND fencing_token=$3 AND expires_at>clock_timestamp() FOR SHARE`,
    [this.nodeId, this.holder, this.token])
    if (!result.rowCount) { this.active = false; throw new HostBootLeaseError() }
  }
  async release(): Promise<void> {
    this.active = false
    await this.pool.query(`UPDATE subagent_host_boot SET expires_at=clock_timestamp()
      WHERE node_id=$1 AND holder=$2 AND fencing_token=$3`, [this.nodeId, this.holder, this.token])
  }
}

/** Durable cancellation wins over a delayed HTTP start, including after restart. */
export class PgDurableStartGuard {
  constructor(private readonly pool: Pool, private readonly nodeId?: string, private readonly boot?: PgHostBootLease) {
    if (boot && boot.nodeId !== nodeId) throw new Error('host boot lease must match the execution node')
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(671839416)')
      await client.query(START_GUARD_DDL)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async admit(request: StartChildRequest): Promise<void> {
    const attempt = request.schedulerAttempt
    const nodeId = request.schedulerNodeId
    if (!Number.isSafeInteger(attempt) || !attempt || !nodeId || (this.nodeId && nodeId !== this.nodeId)) {
      throw forbidden('subagent start requires the current Scheduler attempt and this execution node')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.boot?.lockOwned(client)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([request.realm, request.childId])])
      const placement = await client.query(`SELECT task_id FROM scheduler_tasks
        WHERE task_id=$1 AND realm=$2 AND node_id=$3 AND attempt=$4 AND state IN ('PLACED','RUNNING') FOR UPDATE`,
      [request.childId, request.realm, nodeId, attempt])
      if (!placement.rowCount) throw forbidden('subagent Scheduler assignment is no longer executable')
      const result = await client.query(`INSERT INTO subagent_start_guard
        (realm,child_id,attempt,node_id,admitted,start_request,boot_holder,boot_token)
        VALUES($1,$2,$3,$4,true,$5,$6,$7) ON CONFLICT(realm,child_id) DO UPDATE
        SET attempt=EXCLUDED.attempt,node_id=EXCLUDED.node_id,cancelled=false,admitted=true,updated_at=now(),
          start_request=EXCLUDED.start_request,boot_holder=EXCLUDED.boot_holder,boot_token=EXCLUDED.boot_token,settled=false
        WHERE subagent_start_guard.attempt>0 AND subagent_start_guard.attempt<EXCLUDED.attempt
          AND subagent_start_guard.cancel_all=false
        RETURNING child_id`, [request.realm, request.childId, attempt, nodeId, JSON.stringify(request), this.boot?.holder ?? null, this.boot?.fencingToken ?? null])
      if (!result.rowCount) throw invalid('subagent start is cancelled or already admitted; inspect its existing result')
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async stop(realm: string, childId: string, attempt?: number, nodeId?: string): Promise<{ neverStarted: boolean; applied: boolean }> {
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1 || !nodeId)) {
      throw invalid('subagent stop attempt requires nodeId')
    }
    if (nodeId && this.nodeId && nodeId !== this.nodeId) throw forbidden('subagent stop addressed to a different node')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.boot?.lockOwned(client)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([realm, childId])])
      const result = await client.query<{ admitted: boolean }>(`INSERT INTO subagent_start_guard(realm,child_id,attempt,node_id,cancelled,cancel_all)
        VALUES($1,$2,$3,$4,true,$5) ON CONFLICT(realm,child_id) DO UPDATE SET
        cancelled=true,cancel_all=subagent_start_guard.cancel_all OR EXCLUDED.cancel_all,updated_at=now(),
        admitted=CASE WHEN EXCLUDED.attempt>subagent_start_guard.attempt THEN false ELSE subagent_start_guard.admitted END,
        start_request=CASE WHEN EXCLUDED.attempt>subagent_start_guard.attempt THEN NULL ELSE subagent_start_guard.start_request END,
        boot_holder=CASE WHEN EXCLUDED.attempt>subagent_start_guard.attempt THEN NULL ELSE subagent_start_guard.boot_holder END,
        boot_token=CASE WHEN EXCLUDED.attempt>subagent_start_guard.attempt THEN NULL ELSE subagent_start_guard.boot_token END,
        settled=CASE WHEN EXCLUDED.attempt>subagent_start_guard.attempt THEN false ELSE subagent_start_guard.settled END,
        node_id=CASE WHEN EXCLUDED.attempt>subagent_start_guard.attempt THEN EXCLUDED.node_id ELSE subagent_start_guard.node_id END,
        attempt=GREATEST(subagent_start_guard.attempt,EXCLUDED.attempt)
        WHERE EXCLUDED.cancel_all OR (subagent_start_guard.cancel_all AND subagent_start_guard.attempt=0) OR (subagent_start_guard.attempt>0 AND subagent_start_guard.attempt<EXCLUDED.attempt)
          OR (subagent_start_guard.attempt=EXCLUDED.attempt AND subagent_start_guard.node_id=EXCLUDED.node_id)
        RETURNING admitted`, [realm, childId, attempt ?? 0, nodeId ?? '', attempt === undefined])
      await client.query('COMMIT')
      return { neverStarted: result.rows[0]?.admitted === false, applied: result.rowCount === 1 }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async assertMayRun(request: StartChildRequest): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.boot?.lockOwned(client)
      const result = await client.query(`SELECT g.child_id FROM subagent_start_guard g
        JOIN scheduler_tasks s ON s.task_id=g.child_id AND s.realm=g.realm AND s.attempt=g.attempt AND s.node_id=g.node_id
        WHERE g.realm=$1 AND g.child_id=$2 AND g.attempt=$3 AND g.node_id=$4
          AND g.admitted=true AND g.cancelled=false AND g.settled=false AND s.state IN ('PLACED','RUNNING')
          AND ($5::text IS NULL OR (g.boot_holder=$5 AND g.boot_token=$6))`,
      [request.realm, request.childId, request.schedulerAttempt, request.schedulerNodeId, this.boot?.holder ?? null, this.boot?.fencingToken ?? null])
      if (!result.rowCount) throw forbidden('subagent start cancelled or superseded before its first turn')
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** Adapter for persistCallback; result persistence and admission settlement commit together. */
  callbackStore(request: StartChildRequest): { enqueue(realm: string, url: string, body: ChildResultBody): Promise<void> } {
    return { enqueue: async (realm, url, body) => {
      if (realm !== request.realm || url !== request.callbackUrl) throw new ReceiptConflictError()
      await this.settle(request, body)
    } }
  }

  async settle(request: StartChildRequest, body: ChildResultBody): Promise<void> {
    if (body.runId !== request.childId) throw new ReceiptConflictError()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.boot?.lockOwned(client)
      const guard = await client.query(`SELECT child_id FROM subagent_start_guard
        WHERE realm=$1 AND child_id=$2 AND attempt=$3 AND node_id=$4 AND admitted=true
          AND start_request=$5::jsonb AND ($6::text IS NULL OR (boot_holder=$6 AND boot_token=$7)) FOR UPDATE`,
      [request.realm, request.childId, request.schedulerAttempt, request.schedulerNodeId, JSON.stringify(request), this.boot?.holder ?? null, this.boot?.fencingToken ?? null])
      if (!guard.rowCount) throw new ReceiptConflictError()
      await this.enqueue(client, request.realm, request.callbackUrl, body)
      await client.query('UPDATE subagent_start_guard SET settled=true,updated_at=now() WHERE realm=$1 AND child_id=$2', [request.realm, request.childId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** Only a proven successor may settle a previous process's abandoned admissions. */
  async recoverAbandoned(realms: readonly string[], origins: ReadonlySet<string>): Promise<number> {
    if (!this.boot || !this.nodeId) throw new HostBootLeaseError()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.boot.lockOwned(client)
      const stale = await client.query<{
        realm: string; child_id: string; attempt: number; node_id: string; start_request: StartChildRequest | null
      }>(`SELECT realm,child_id,attempt,node_id,start_request FROM subagent_start_guard
        WHERE node_id=$1 AND realm=ANY($2::text[]) AND admitted=true AND settled=false
          AND (boot_holder IS DISTINCT FROM $3 OR boot_token IS DISTINCT FROM $4::bigint) FOR UPDATE`,
      [this.nodeId, [...realms], this.boot.holder, this.boot.fencingToken])
      for (const row of stale.rows) {
        const request = row.start_request
        if (request && (request.realm !== row.realm || request.childId !== row.child_id ||
            request.schedulerAttempt !== row.attempt || request.schedulerNodeId !== row.node_id)) {
          throw new Error('invalid subagent admission identity requires operator review before host recovery')
        }
        const existing = await client.query<{ callback_url: string }>('SELECT callback_url FROM subagent_callback_outbox WHERE realm=$1 AND run_id=$2', [row.realm, row.child_id])
        if (existing.rowCount) {
          // A previous process may have committed a real receipt just before it
          // stopped. Its immutable outcome wins over synthetic crash recovery.
          if (request && request.callbackUrl !== existing.rows[0]!.callback_url) throw new ReceiptConflictError()
          assertAllowedCallback(existing.rows[0]!.callback_url, row.child_id, origins)
        } else {
          if (!request) {
            throw new Error('legacy or invalid subagent admission requires operator review before host recovery')
          }
          assertAllowedCallback(request.callbackUrl, request.childId, origins)
          await this.enqueue(client, row.realm, request.callbackUrl, { runId: row.child_id, ok: false,
            code: 'HOST_PROCESS_LOST', message: 'The execution host process stopped before committing this child result; the child was not replayed.' })
        }
        await client.query('UPDATE subagent_start_guard SET settled=true,updated_at=now() WHERE realm=$1 AND child_id=$2', [row.realm, row.child_id])
      }
      await client.query('COMMIT')
      return stale.rowCount ?? 0
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async enqueue(client: PoolClient, realm: string, url: string, body: ChildResultBody): Promise<void> {
    const result = await client.query(`INSERT INTO subagent_callback_outbox
      (realm,run_id,callback_url,callback_origin,payload) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(realm,run_id) DO UPDATE SET run_id=EXCLUDED.run_id
      WHERE subagent_callback_outbox.callback_url=EXCLUDED.callback_url AND subagent_callback_outbox.payload=EXCLUDED.payload
      RETURNING run_id`, [realm, body.runId, url, new URL(url).origin, JSON.stringify(body)])
    if (result.rowCount !== 1) throw new ReceiptConflictError()
  }
}
