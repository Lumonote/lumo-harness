import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgPlacementRecovery } from '../src/placement-recovery.ts'

const dsn = process.env['LUMO_TEST_PG_DSN']
describe.skipIf(!dsn)('durable placement cleanup', () => {
  const schema = `placement_recovery_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: dsn })
  const pool = new pg.Pool({ connectionString: dsn, options: `-c search_path=${schema}` })
  const identity = { base: 'http://scheduler', realm: 'realm', controlPlaneToken: 'token' }
  const first = new PgPlacementRecovery(pool, identity)
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM subagent_placement_cleanup')).rows[0].n
  beforeAll(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await first.init() })
  beforeEach(async () => { await pool.query('TRUNCATE subagent_placement_cleanup') })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

  it('cancels a placement left in flight by a crashed parent', async () => {
    await first.begin('child', 120_000)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ state: 'ABORTED' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const restarted = new PgPlacementRecovery(pool, identity)
    await restarted.sweep()
    expect(fetch).not.toHaveBeenCalled()
    await pool.query("UPDATE subagent_placement_cleanup SET expires_at=now()-interval '1 second'")
    await restarted.sweep()
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe('http://scheduler/v1/tasks/child/cancel')
    expect(await count()).toBe(0)
  })

  it('keeps cancellation durable across an outage and waits for actual terminal state', async () => {
    await first.begin('child', 120_000)
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('scheduler offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'CANCELLING' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'ABORTED' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(first.cancel('child', { attempt: 2, nodeId: 'N1' })).rejects.toThrow('offline')
    const restarted = new PgPlacementRecovery(pool, identity)
    await restarted.sweep()
    expect(await count()).toBe(1)
    await pool.query("UPDATE subagent_placement_cleanup SET next_attempt_at=now()-interval '1 second'")
    await restarted.sweep()
    expect(await count()).toBe(0)
    for (const [, init] of fetch.mock.calls) expect(JSON.parse(String(init?.body))).toEqual({ attempt: 2, node_id: 'N1' })
  })

  it('does not cancel a placement after successful handoff', async () => {
    await first.begin('child', 1)
    await first.finish('child')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await first.sweep()
    expect(fetch).not.toHaveBeenCalled()
    expect(await count()).toBe(0)
  })
})
