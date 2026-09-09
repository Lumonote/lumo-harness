import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PgSubagentReceipts, ReceiptConflictError } from '../../../shared/subagent-receipts.ts'
import type { ChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'

const dsn = process.env['LUMO_TEST_PG_DSN']
describe.skipIf(!dsn)('PostgreSQL callback receipts', () => {
  const schema = `lumo_subagent_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: dsn })
  const pool = new pg.Pool({ connectionString: dsn, options: `-c search_path=${schema}` })
  const store = new PgSubagentReceipts(pool)
  const body: ChildResultBody = { runId: 'child', ok: true, stopReason: 'completed', structured: { a: 1, b: 2 } }
  const origin = 'http://parent.invalid'
  const url = `${origin}/subagent/result/child/0123456789abcdef`

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await store.init()
    await store.init()
  })
  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })

  it('turns a durable registration into an immutable, realm-scoped receipt', async () => {
    await store.register('realm', 'child', { secretHash: 'hash', attempt: 4 })
    expect(await store.get('realm', 'child')).toEqual({ secretHash: 'hash', attempt: 4 })
    await store.put('realm', { secretHash: 'hash', attempt: 4, body })
    expect(await new PgSubagentReceipts(pool).get('realm', 'child')).toEqual({ secretHash: 'hash', attempt: 4, body })
    await store.put('realm', { secretHash: 'hash', attempt: 4, body: { ...body, structured: { b: 2, a: 1 } } })
    await expect(store.put('realm', { secretHash: 'hash', attempt: 4, body: { ...body, stopReason: 'error' } })).rejects.toBeInstanceOf(ReceiptConflictError)
    await expect(store.register('realm', 'child', { secretHash: 'other', attempt: 4 })).rejects.toBeInstanceOf(ReceiptConflictError)
    expect(await store.get('other-realm', 'child')).toBeUndefined()
  })

  it('leases a receipt once, fences stale acknowledgments and retains delivered idempotency', async () => {
    await store.enqueue('realm', url, body)
    await store.enqueue('realm', url, { ...body, structured: { b: 2, a: 1 } })
    expect(await store.claim(['other-realm'], [origin], 'other')).toEqual([])
    expect(await store.claim(['realm'], ['http://other.invalid'], 'other')).toEqual([])
    const claims = (await Promise.all([
      store.claim(['realm'], [origin], 'one'), store.claim(['realm'], [origin], 'two'),
    ])).flat()
    expect(claims).toHaveLength(1)
    const old = claims[0]!
    await pool.query("UPDATE subagent_callback_outbox SET next_attempt_at=now()-interval '1 second'")
    const [current] = await store.claim(['realm'], [origin], 'new-owner')
    expect(current).toBeDefined()
    await store.acknowledge(old)
    expect((await pool.query('SELECT delivered_at FROM subagent_callback_outbox')).rows[0].delivered_at).toBeNull()
    await store.defer(old)
    expect((await pool.query('SELECT claim_token FROM subagent_callback_outbox')).rows[0].claim_token).toBe('new-owner')
    await store.acknowledge(current!)
    await store.enqueue('realm', url, body)
    expect(await store.claim(['realm'], [origin], 'replay')).toEqual([])
    await expect(store.enqueue('realm', url, { ...body, stopReason: 'error' })).rejects.toBeInstanceOf(ReceiptConflictError)
  })
})
