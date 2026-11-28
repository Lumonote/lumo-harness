import type pg from 'pg'

/** Initialization owns a disposable connection so abort also cancels blocked DDL. */
export async function withInitializationClient(pool: pg.Pool, signal: AbortSignal | undefined, action: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  signal?.throwIfAborted()
  const client = await pool.connect()
  let released = false
  const release = () => { if (!released) { released = true; client.release(true) } }
  const abort = () => release()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    // Server-side lock/statement limits also protect direct provider.init() users.
    await client.query("SET statement_timeout = '30s'; SET lock_timeout = '10s'")
    await action(client)
    signal?.throwIfAborted()
  } finally {
    signal?.removeEventListener('abort', abort)
    // Do not leak initialization-only timeout settings into runtime queries.
    release()
  }
}
