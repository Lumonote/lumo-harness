import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'

const DSN = process.env.METERING_TEST_DSN ?? process.env.LUMO_TEST_PG_DSN
const test = DSN ? it : it.skip
async function fixture() {
  const dsn = await schemaDsn(DSN!, 'metering_project_management_test')
  const connection = new URL(dsn)
  const applicationName = `budget-management-${randomUUID()}`
  connection.searchParams.set('application_name', applicationName)
  const meter = new PgMeteringSeam(connection.toString())
  await meter.init()
  // Project-owned tables use their documented minimum public columns. The
  // configuration implementation takes the same parent lock as the Go writer.
  await meter.raw(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,realm TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_members(project_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(project_id,user_id));`)
  const projectId = `p-${randomUUID()}`
  const actor = { realm: 'realm-a', projectId, actorUserId: 'owner' }
  await meter.raw(`INSERT INTO projects(id,realm,status) VALUES($1,'realm-a','active')`, [projectId])
  for (const role of ['owner','editor','viewer']) await meter.raw('INSERT INTO project_members VALUES($1,$2,$3)', [projectId,role,role])
  const change = { ...actor, mode: 'reset' as const, total: 1000, softLimit: 800, overdraft: 100, expectedRevision: 0, confirmReset: true }
  const context = { userId: `u-${projectId}`, deptId: 'd', role: 'viewer', projectId, agentId: 'a', componentId: 'c', feature: 'test', sessionRef: 's' }
  await meter.seedDefaultBudget('user', context.userId, 10000)
  const close = () => meter.close()
  return { meter, actor, change, context, close, dsn, applicationName }
}
describe('project budget administration (real PG)', () => {
  test('initializes only after confirmation, preserves usage on adjustment and records audit', async () => {
    const f = await fixture()
    try {
      expect(await f.meter.readProjectBudget(f.actor)).toMatchObject({ total: null, revision: 0, unit: 'tokens' })
      await expect(f.meter.configureProjectBudget({ ...f.change, confirmReset: false })).rejects.toMatchObject({ status: 400 })
      const initial = await f.meter.configureProjectBudget(f.change)
      await f.meter.commit({ context: f.context, model: 'test', costType: 'llm', tokens: 200, costUsd: 0 })
      const adjusted = await f.meter.configureProjectBudget({ ...f.change, mode: 'adjust', total: 500, softLimit: 400, expectedRevision: initial.revision })
      expect(adjusted).toMatchObject({ total: 500, remaining: 300, revision: 2 })
      expect(await f.meter.raw('SELECT mode,actor_user_id,before_state,after_state FROM project_budget_audit WHERE project_id=$1 ORDER BY id', [f.actor.projectId])).toMatchObject([
        { mode: 'reset', actor_user_id: 'owner', after_state: { total: 1000 } },
        { mode: 'adjust', before_state: { total: 1000, remaining: 800 }, after_state: { remaining: 300 } },
      ])
    } finally { await f.close() }
  })
  test('uses current project realm and membership; archived projects remain readable but cannot change budget', async () => {
    const f = await fixture()
    try {
      for (const actorUserId of ['editor','viewer','stranger']) await expect(f.meter.configureProjectBudget({ ...f.change, actorUserId })).rejects.toMatchObject({ status: 403 })
      await expect(f.meter.configureProjectBudget({ ...f.change, realm: 'another' })).rejects.toMatchObject({ status: 403 })
      await expect(f.meter.readProjectBudget({ ...f.actor, actorUserId: 'stranger' })).rejects.toMatchObject({ status: 403 })
      await f.meter.raw(`UPDATE projects SET status='archived' WHERE id=$1`, [f.actor.projectId])
      await expect(f.meter.configureProjectBudget(f.change)).rejects.toMatchObject({ status: 409 })
      await expect(f.meter.readProjectBudget({ ...f.actor, actorUserId: 'viewer' })).resolves.toMatchObject({ revision: 0 })
    } finally { await f.close() }
  })
  test('allows only one concurrent reset and rejects replay after consumption', async () => {
    const f = await fixture()
    try {
      const writes = await Promise.allSettled([f.meter.configureProjectBudget(f.change), f.meter.configureProjectBudget(f.change)])
      expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1)
      await f.meter.commit({ context: f.context, model: 'test', costType: 'llm', tokens: 250, costUsd: 0 })
      await expect(f.meter.configureProjectBudget(f.change)).rejects.toMatchObject({ status: 409 })
      expect(await f.meter.readProjectBudget(f.actor)).toMatchObject({ remaining: 750, revision: 1 })
    } finally { await f.close() }
  })
  test('legacy seed requires explicit reset and external metering configuration invalidates old drafts', async () => {
    const f = await fixture()
    try {
      await f.meter.seedDefaultBudget('project', f.actor.projectId, 10000)
      const initial = await f.meter.readProjectBudget(f.actor)
      await expect(f.meter.configureProjectBudget({ ...f.change, mode: 'adjust', expectedRevision: initial.revision })).rejects.toMatchObject({ status: 409 })
      await f.meter.setBudget('project', f.actor.projectId, 2000)
      await expect(f.meter.configureProjectBudget({ ...f.change, expectedRevision: initial.revision })).rejects.toMatchObject({ status: 409 })
      expect(await f.meter.readProjectBudget(f.actor)).toMatchObject({ total: 2000, remaining: 2000 })
    } finally { await f.close() }
  })
  test('rejects unsafe totals and immediately enforces adjusted hard limits', async () => {
    const f = await fixture()
    try {
      for (const total of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(f.meter.configureProjectBudget({ ...f.change, total })).rejects.toMatchObject({ status: 400 })
      await expect(f.meter.configureProjectBudget({ ...f.change, softLimit: 1001 })).rejects.toMatchObject({ status: 400 })
      await f.meter.configureProjectBudget(f.change)
      await f.meter.commit({ context: f.context, model: 'test', costType: 'llm', tokens: 200, costUsd: 0 })
      await f.meter.configureProjectBudget({ ...f.change, mode: 'adjust', total: 100, softLimit: 100, overdraft: 0, expectedRevision: 1 })
      expect(await f.meter.reserve(f.context)).toMatchObject({ approved: false, reason: 'denied-project-budget', state: 'hard' })
      expect(await f.meter.balance({ kind: 'project', id: f.actor.projectId })).toBe(-100)
    } finally { await f.close() }
  })
  test('rechecks a revoked owner after waiting for an in-flight membership transaction', async () => {
    const f = await fixture()
    const blocker = new pg.Client({ connectionString: f.dsn })
    await blocker.connect()
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [f.actor.projectId])
      await blocker.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [f.actor.projectId, f.actor.actorUserId])
      pending = f.meter.configureProjectBudget(f.change).then(value => ({ value }), error => ({ error }))
      let waiting = false
      const deadline = Date.now() + 3000
      while (!waiting && Date.now() < deadline) {
        await blocker.query('SELECT pg_stat_clear_snapshot()')
        waiting = (await blocker.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [f.applicationName])).rowCount! > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting, 'budget write must actually wait on the parent lock').toBe(true)
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ error: { status: 403 } })
      expect(await f.meter.raw('SELECT id FROM budget_trees WHERE kind=\'project\' AND id=$1', [f.actor.projectId])).toEqual([])
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await pending
      await blocker.end(); await f.close()
    }
  })
  test('keeps exact balances when unchanged totals are near the safe integer bound', async () => {
    const f = await fixture()
    try {
      await f.meter.configureProjectBudget({ ...f.change, total: Number.MAX_SAFE_INTEGER, softLimit: Number.MAX_SAFE_INTEGER, overdraft: 0 })
      await f.meter.commit({ context: f.context, model: 'test', costType: 'llm', tokens: 1, costUsd: 0 })
      const adjusted = await f.meter.configureProjectBudget({ ...f.change, mode: 'adjust', total: Number.MAX_SAFE_INTEGER, softLimit: Number.MAX_SAFE_INTEGER, overdraft: 0, expectedRevision: 1 })
      expect(adjusted.remaining).toBe(Number.MAX_SAFE_INTEGER - 1)
    } finally { await f.close() }
  })
})
