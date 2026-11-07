import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PgDurableStartGuard } from '../src/durable-start-guard.ts'
import type { StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

const dsn = process.env['LUMO_TEST_PG_DSN']
describe.skipIf(!dsn)('durable raw subagent start guard', () => {
  const schema = `start_guard_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: dsn })
  const pool = new pg.Pool({ connectionString: dsn, options: `-c search_path=${schema}` })
  const guard = new PgDurableStartGuard(pool, 'N1')
  const request = { realm: 'realm', childId: 'child', schedulerAttempt: 1, schedulerNodeId: 'N1' } as StartChildRequest
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await pool.query('CREATE TABLE scheduler_tasks(task_id TEXT PRIMARY KEY,realm TEXT,node_id TEXT,attempt INTEGER,state TEXT)')
    await guard.init()
  })
  beforeEach(async () => {
    await pool.query('TRUNCATE scheduler_tasks,subagent_start_guard')
    await pool.query("INSERT INTO scheduler_tasks VALUES('child','realm','N1',1,'PLACED')")
  })
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  it('remembers stop before start, including after host restart', async () => {
    expect(await guard.stop('realm', 'child', 1, 'N1')).toEqual({ neverStarted: true, applied: true })
    const restarted = new PgDurableStartGuard(pool, 'N1')
    await expect(restarted.admit(request)).rejects.toThrow('cancelled')
  })
  it('admits one of many concurrent deliveries and rejects spoofed assignments', async () => {
    await expect(guard.admit({ ...request, schedulerNodeId: 'N2' })).rejects.toThrow('execution node')
    await expect(guard.admit({ ...request, schedulerAttempt: 2 })).rejects.toThrow('no longer executable')
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => guard.admit(request)))
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  })
  it('stops a start admitted before the local agent was created', async () => {
    await guard.admit(request)
    await guard.stop('realm', 'child', 1, 'N1')
    await expect(guard.assertMayRun(request)).rejects.toThrow('cancelled')
  })
  it('persists a higher-attempt stop before that attempt starts and rejects a delayed start', async () => {
    await guard.admit(request)
    await pool.query("UPDATE scheduler_tasks SET attempt=2 WHERE task_id='child'")
    const next = { ...request, schedulerAttempt: 2 }
    expect(await guard.stop('realm', 'child', 2, 'N1')).toEqual({ neverStarted: true, applied: true })
    expect(await guard.stop('realm', 'child', 1, 'N1')).toEqual({ neverStarted: false, applied: false })
    await expect(guard.admit(next)).rejects.toThrow('cancelled')
    expect((await pool.query('SELECT attempt,admitted,cancelled,start_request FROM subagent_start_guard')).rows[0])
      .toMatchObject({ attempt: 2, admitted: false, cancelled: true, start_request: null })
  })
  it('keeps an unscoped cancellation terminal when a later explicit stop supplies its assignment', async () => {
    expect(await guard.stop('realm', 'child')).toEqual({ neverStarted: true, applied: true })
    expect(await guard.stop('realm', 'child', 1, 'N1')).toEqual({ neverStarted: true, applied: true })
    await expect(guard.admit(request)).rejects.toThrow('cancelled')
    await pool.query("UPDATE scheduler_tasks SET attempt=2 WHERE task_id='child'")
    await expect(guard.admit({ ...request, schedulerAttempt: 2 })).rejects.toThrow('cancelled')
  })
  it('upgrades an existing unscoped cancellation tombstone without making it executable', async () => {
    await pool.query("INSERT INTO subagent_start_guard(realm,child_id,attempt,node_id,cancelled) VALUES('realm','child',0,'',true)")
    await guard.init()
    expect((await pool.query('SELECT cancel_all FROM subagent_start_guard')).rows[0].cancel_all).toBe(true)
    expect(await guard.stop('realm', 'child', 1, 'N1')).toEqual({ neverStarted: true, applied: true })
    await expect(guard.admit(request)).rejects.toThrow('cancelled')
  })
  it('does not destroy a started attempt identity when cancellation omits the assignment', async () => {
    await guard.admit(request)
    expect(await guard.stop('realm', 'child')).toEqual({ neverStarted: false, applied: true })
    expect((await pool.query('SELECT attempt,start_request,cancel_all FROM subagent_start_guard')).rows[0])
      .toMatchObject({ attempt: 1, start_request: request, cancel_all: true })
    await pool.query("UPDATE scheduler_tasks SET attempt=2 WHERE task_id='child'")
    await expect(guard.admit({ ...request, schedulerAttempt: 2 })).rejects.toThrow('cancelled')
  })
  it('does not let a delayed stop cancel a later assignment', async () => {
    await guard.admit(request)
    await pool.query("UPDATE scheduler_tasks SET attempt=2 WHERE task_id='child'")
    const next = { ...request, schedulerAttempt: 2 }
    await guard.admit(next)
    expect(await guard.stop('realm', 'child', 1, 'N1')).toEqual({ neverStarted: false, applied: false })
    await expect(guard.assertMayRun(next)).resolves.toBeUndefined()
  })
})
