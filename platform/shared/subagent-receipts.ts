import type { Pool } from 'pg'
import type { ChildResultBody } from './seam-contracts/subagent-host.ts'

export interface CallbackRegistration {
  secretHash: string
  attempt?: number
  body?: ChildResultBody
}

export interface CallbackReceipt extends CallbackRegistration {
  body: ChildResultBody
}

export interface CallbackInbox {
  register(realm: string, runId: string, registration: CallbackRegistration): Promise<void>
  get(realm: string, runId: string): Promise<CallbackRegistration | undefined>
  put(realm: string, receipt: CallbackReceipt): Promise<void>
}

export interface PendingCallback {
  realm: string
  runId: string
  url: string
  body: ChildResultBody
  claimToken: string
}

export interface CallbackOutboxStore {
  enqueue(realm: string, url: string, body: ChildResultBody): Promise<void>
  claim(realms: string[], origins: string[], token: string): Promise<PendingCallback[]>
  acknowledge(item: PendingCallback): Promise<void>
  defer(item: PendingCallback): Promise<void>
}

export class ReceiptConflictError extends Error {
  constructor() { super('subagent result receipt is immutable') }
}

const DDL = `
CREATE TABLE IF NOT EXISTS subagent_callback_outbox (
  realm TEXT NOT NULL,
  run_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  callback_origin TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,run_id)
);
CREATE INDEX IF NOT EXISTS subagent_callback_pending_idx
  ON subagent_callback_outbox(next_attempt_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS subagent_callback_inbox (
  realm TEXT NOT NULL,
  run_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  payload JSONB,
  scheduler_attempt INTEGER,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,run_id)
);
ALTER TABLE subagent_callback_inbox ALTER COLUMN payload DROP NOT NULL;`

/** Transport receipts are durable independently of the in-memory Agent handles. */
export class PgSubagentReceipts implements CallbackInbox, CallbackOutboxStore {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(671839415)')
      await client.query(DDL)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async enqueue(realm: string, url: string, body: ChildResultBody): Promise<void> {
    const result = await this.pool.query(`INSERT INTO subagent_callback_outbox
      (realm,run_id,callback_url,callback_origin,payload) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(realm,run_id) DO UPDATE SET run_id=EXCLUDED.run_id
      WHERE subagent_callback_outbox.callback_url=EXCLUDED.callback_url AND subagent_callback_outbox.payload=EXCLUDED.payload
      RETURNING run_id`, [realm, body.runId, url, new URL(url).origin, JSON.stringify(body)])
    if (result.rowCount !== 1) throw new ReceiptConflictError()
  }

  async claim(realms: string[], origins: string[], token: string): Promise<PendingCallback[]> {
    const result = await this.pool.query<{ realm: string; run_id: string; callback_url: string; payload: ChildResultBody }>(`
      WITH picked AS (
        SELECT realm,run_id FROM subagent_callback_outbox
        WHERE realm=ANY($1::text[]) AND callback_origin=ANY($2::text[]) AND delivered_at IS NULL AND next_attempt_at<=now()
        ORDER BY next_attempt_at,created_at LIMIT 8 FOR UPDATE SKIP LOCKED
      ) UPDATE subagent_callback_outbox o SET claim_token=$3,attempts=attempts+1,next_attempt_at=now()+interval '30 seconds'
      FROM picked p WHERE o.realm=p.realm AND o.run_id=p.run_id
      RETURNING o.realm,o.run_id,o.callback_url,o.payload`, [realms, origins, token])
    return result.rows.map(row => ({ realm: row.realm, runId: row.run_id, url: row.callback_url, body: row.payload, claimToken: token }))
  }

  async acknowledge(item: PendingCallback): Promise<void> {
    await this.pool.query(`UPDATE subagent_callback_outbox SET delivered_at=now(),claim_token=NULL
      WHERE realm=$1 AND run_id=$2 AND claim_token=$3 AND delivered_at IS NULL`, [item.realm, item.runId, item.claimToken])
  }

  async defer(item: PendingCallback): Promise<void> {
    await this.pool.query(`UPDATE subagent_callback_outbox SET claim_token=NULL,
      next_attempt_at=now()+LEAST(60,power(2,LEAST(attempts,6))) * interval '1 second'
      WHERE realm=$1 AND run_id=$2 AND claim_token=$3 AND delivered_at IS NULL`, [item.realm, item.runId, item.claimToken])
  }

  async register(realm: string, runId: string, registration: CallbackRegistration): Promise<void> {
    const result = await this.pool.query(`INSERT INTO subagent_callback_inbox(realm,run_id,secret_hash,scheduler_attempt)
      VALUES($1,$2,$3,$4) ON CONFLICT(realm,run_id) DO UPDATE SET run_id=EXCLUDED.run_id
      WHERE subagent_callback_inbox.secret_hash=EXCLUDED.secret_hash
        AND subagent_callback_inbox.scheduler_attempt IS NOT DISTINCT FROM EXCLUDED.scheduler_attempt RETURNING run_id`,
    [realm, runId, registration.secretHash, registration.attempt ?? null])
    if (result.rowCount !== 1) throw new ReceiptConflictError()
  }

  async get(realm: string, runId: string): Promise<CallbackRegistration | undefined> {
    const result = await this.pool.query<{ secret_hash: string; payload: ChildResultBody | null; scheduler_attempt: number | null }>(
      'SELECT secret_hash,payload,scheduler_attempt FROM subagent_callback_inbox WHERE realm=$1 AND run_id=$2', [realm, runId])
    const row = result.rows[0]
    return row ? { secretHash: row.secret_hash, ...(row.payload == null ? {} : { body: row.payload }),
      ...(row.scheduler_attempt == null ? {} : { attempt: row.scheduler_attempt }) } : undefined
  }

  async put(realm: string, receipt: CallbackReceipt): Promise<void> {
    const result = await this.pool.query(`INSERT INTO subagent_callback_inbox(realm,run_id,secret_hash,payload,scheduler_attempt)
      VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(realm,run_id) DO UPDATE SET payload=EXCLUDED.payload,
        received_at=CASE WHEN subagent_callback_inbox.payload IS NULL THEN now() ELSE subagent_callback_inbox.received_at END
      WHERE subagent_callback_inbox.secret_hash=EXCLUDED.secret_hash
        AND (subagent_callback_inbox.payload IS NULL OR subagent_callback_inbox.payload=EXCLUDED.payload)
        AND subagent_callback_inbox.scheduler_attempt IS NOT DISTINCT FROM EXCLUDED.scheduler_attempt
      RETURNING run_id`, [realm, receipt.body.runId, receipt.secretHash, JSON.stringify(receipt.body), receipt.attempt ?? null])
    if (result.rowCount !== 1) throw new ReceiptConflictError()
  }
}
