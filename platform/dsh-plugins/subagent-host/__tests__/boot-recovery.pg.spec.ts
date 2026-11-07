import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PgDurableStartGuard, PgHostBootLease, HostBootLeaseError } from '../src/durable-start-guard.ts'
import { PgSubagentReceipts, ReceiptConflictError } from '../../../shared/subagent-receipts.ts'
import type { ChildResultBody, StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

const dsn = process.env['LUMO_TEST_PG_DSN']
describe.skipIf(!dsn)('execution host process lease and crash receipts', () => {
  const schema = 'host_boot_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: dsn })
  const pool = new pg.Pool({ connectionString: dsn, options: '-c search_path=' + schema, max: 12,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 })
  const receipts = new PgSubagentReceipts(pool)
  const origins = new Set(['http://parent.invalid'])
  const request: StartChildRequest = { realm: 'realm', childId: 'child', schedulerAttempt: 1, schedulerNodeId: 'N1',
    callbackUrl: 'http://parent.invalid/subagent/result/child/0123456789abcdef', prompt: [], descriptor: {},
    parent: { sessionId: 'parent', delegationDepth: 0 } }
  const result: ChildResultBody = { runId: 'child', ok: true, stopReason: 'completed', structured: { answer: 42 } }
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema)
    await pool.query('CREATE TABLE scheduler_tasks(task_id TEXT PRIMARY KEY,realm TEXT,node_id TEXT,attempt INTEGER,state TEXT)')
    await new PgDurableStartGuard(pool, 'N1').init()
    await receipts.init()
  })
  beforeEach(async () => {
    await pool.query('TRUNCATE scheduler_tasks,subagent_start_guard,subagent_host_boot,subagent_callback_outbox,subagent_callback_inbox')
    await pool.query("INSERT INTO scheduler_tasks VALUES('child','realm','N1',1,'PLACED')")
  })
  afterAll(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  async function owner(nodeId = 'N1') {
    const boot = new PgHostBootLease(pool, nodeId)
    await boot.acquire()
    return { boot, guard: new PgDurableStartGuard(pool, nodeId, boot) }
  }
  async function expire(nodeId = 'N1') {
    await pool.query("UPDATE subagent_host_boot SET expires_at=clock_timestamp()-interval '1 second' WHERE node_id=$1", [nodeId])
  }
  async function outbox() { return (await pool.query('SELECT run_id,payload,callback_url FROM subagent_callback_outbox ORDER BY run_id')).rows }

  it('admits one of concurrent boot acquisitions and never displaces a live owner', async () => {
    const candidates = Array.from({ length: 6 }, () => new PgHostBootLease(pool, 'N1'))
    const attempts = await Promise.allSettled(candidates.map(boot => boot.acquire()))
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const winner = candidates.find(boot => boot.isOwned())!
    const guard = new PgDurableStartGuard(pool, 'N1', winner)
    await guard.admit(request)
    const rejected = candidates.find(boot => !boot.isOwned())!
    await expect(new PgDurableStartGuard(pool, 'N1', rejected).recoverAbandoned(['realm'], origins)).rejects.toBeInstanceOf(HostBootLeaseError)
    await expect(guard.assertMayRun(request)).resolves.toBeUndefined()
    expect(await outbox()).toEqual([])
  })

  it('recovers an expired predecessor as a durable failure and fences its admission, execution and result', async () => {
    const previous = await owner()
    await previous.guard.admit(request)
    expect((await pool.query('SELECT start_request,boot_holder,boot_token FROM subagent_start_guard')).rows[0])
      .toMatchObject({ start_request: request, boot_holder: previous.boot.holder, boot_token: '1' })
    await expire()
    const replacement = await owner()
    expect(replacement.boot.fencingToken).toBe(2)
    expect(await replacement.guard.recoverAbandoned(['realm'], origins)).toBe(1)
    expect(await replacement.guard.recoverAbandoned(['realm'], origins)).toBe(0)
    expect(await outbox()).toMatchObject([{ run_id: 'child', callback_url: request.callbackUrl,
      payload: { runId: 'child', ok: false, code: 'HOST_PROCESS_LOST' } }])
    await expect(previous.guard.assertMayRun(request)).rejects.toBeInstanceOf(HostBootLeaseError)
    await expect(previous.guard.settle(request, result)).rejects.toBeInstanceOf(HostBootLeaseError)
    await expect(previous.guard.admit(request)).rejects.toBeInstanceOf(HostBootLeaseError)
    await expect(replacement.guard.admit(request)).rejects.toThrow('already admitted')
    expect((await pool.query('SELECT settled FROM subagent_start_guard')).rows[0].settled).toBe(true)
  })

  it('settles an admitted child after cancellation omitted its attempt identity', async () => {
    const first = await owner()
    await first.guard.admit(request)
    await first.guard.stop('realm', 'child')
    await first.guard.settle(request, { ...result, stopReason: 'aborted' })
    expect((await outbox())[0].payload).toMatchObject({ stopReason: 'aborted' })
  })

  it('recovers an unscoped cancelled admission with its original request identity', async () => {
    const first = await owner()
    await first.guard.admit(request)
    await first.guard.stop('realm', 'child')
    await expire()
    const second = await owner()
    expect(await second.guard.recoverAbandoned(['realm'], origins)).toBe(1)
    expect((await outbox())[0].payload).toMatchObject({ code: 'HOST_PROCESS_LOST' })
  })

  it('commits the actual result and settled marker atomically with immutable retries', async () => {
    const first = await owner()
    await first.guard.admit(request)
    await first.guard.callbackStore(request).enqueue('realm', request.callbackUrl, result)
    await first.guard.settle(request, result)
    await expect(first.guard.settle(request, { ...result, stopReason: 'error' })).rejects.toBeInstanceOf(ReceiptConflictError)
    expect((await pool.query('SELECT settled FROM subagent_start_guard')).rows[0].settled).toBe(true)
    await expire()
    const second = await owner()
    expect(await second.guard.recoverAbandoned(['realm'], origins)).toBe(0)
    expect((await outbox())[0].payload).toEqual(result)
  })

  it('preserves a receipt committed before a legacy settlement marker was updated', async () => {
    const first = await owner()
    await first.guard.admit(request)
    await receipts.enqueue('realm', request.callbackUrl, result)
    await expire()
    const second = await owner()
    expect(await second.guard.recoverAbandoned(['realm'], origins)).toBe(1)
    expect((await outbox())[0].payload).toEqual(result)
  })

  it('isolates recovery by the owned node, allowed realm and exact callback origin', async () => {
    const first = await owner()
    await first.guard.admit(request)
    const foreignRealm = { ...request, realm: 'private', childId: 'private-child', callbackUrl: 'http://parent.invalid/subagent/result/private-child/0123456789abcdef' }
    await pool.query("INSERT INTO scheduler_tasks VALUES('private-child','private','N1',1,'PLACED'),('other-child','realm','N2',1,'PLACED')")
    await first.guard.admit(foreignRealm)
    const otherNode = await owner('N2')
    await otherNode.guard.admit({ ...request, childId: 'other-child', schedulerNodeId: 'N2', callbackUrl: 'http://parent.invalid/subagent/result/other-child/0123456789abcdef' })
    await expire()
    const second = await owner()
    await expect(second.guard.recoverAbandoned(['realm'], new Set(['http://untrusted.invalid']))).rejects.toThrow()
    expect(await outbox()).toEqual([])
    expect(await second.guard.recoverAbandoned(['realm'], origins)).toBe(1)
    expect((await outbox()).map(item => item.run_id)).toEqual(['child'])
    await expect(otherNode.guard.assertMayRun({ ...request, childId: 'other-child', schedulerNodeId: 'N2' })).resolves.toBeUndefined()
    expect((await pool.query("SELECT settled FROM subagent_start_guard WHERE realm='private'")).rows[0].settled).toBe(false)
  })

  it('rejects a persisted request whose scheduler generation does not match its admission', async () => {
    const first = await owner()
    await first.guard.admit(request)
    await pool.query("UPDATE subagent_start_guard SET start_request=jsonb_set(start_request,'{schedulerAttempt}','2')")
    await expire()
    const second = await owner()
    await expect(second.guard.recoverAbandoned(['realm'], origins)).rejects.toThrow('invalid subagent admission identity')
    expect(await outbox()).toEqual([])
  })

  it('never renews an expired boot or lets an old release invalidate its successor', async () => {
    const first = await owner()
    await first.boot.renew()
    await expire()
    await expect(first.boot.renew()).rejects.toBeInstanceOf(HostBootLeaseError)
    expect(first.boot.isOwned()).toBe(false)
    const second = await owner()
    await first.boot.release()
    await expect(second.boot.assertOwned()).resolves.toBeUndefined()
  })

  it('retains an unprovable legacy admission for review instead of inventing a callback', async () => {
    await pool.query("INSERT INTO subagent_start_guard(realm,child_id,attempt,node_id,admitted) VALUES('realm','child',1,'N1',true)")
    const current = await owner()
    await expect(current.guard.recoverAbandoned(['realm'], origins)).rejects.toThrow('operator review')
    expect(await outbox()).toEqual([])
    expect((await pool.query('SELECT settled FROM subagent_start_guard')).rows[0].settled).toBe(false)
  })
})
