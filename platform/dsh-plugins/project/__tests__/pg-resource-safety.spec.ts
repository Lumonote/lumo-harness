import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { schemaDsn } from '../../session-log/__tests__/pg-schema.ts'
import { ProjectService } from '../src/service.ts'

const DSN = process.env.LUMO_TEST_PG_DSN
const live = DSN ? it : it.skip
const resources: Array<{ close(): Promise<void> }> = []

async function fixture() {
  const dsn = await schemaDsn(DSN!, 'project_service_resource_safety')
  const service = new ProjectService(dsn, 'realm-a')
  resources.push(service)
  await service.init()
  const admin = new pg.Client({ connectionString: dsn })
  await admin.connect()
  resources.push({ close: () => admin.end() })
  const id = randomUUID()
  const project = { projectId: id, realm: 'realm-a', name: id, state: 'active' as const }
  await service.create(project, 'owner')
  return { dsn, service, admin, project, id }
}

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close()
})

describe('TS project shared-table safety (real PostgreSQL)', () => {
  live('Space incarnation is stable on update and its claim survives detach and project deletion', async () => {
    const f = await fixture(), space = randomUUID()
    await f.service.addSpace(space, f.id, 'realm-a', 'Before')
    const first = (await f.admin.query('SELECT incarnation FROM project_spaces WHERE space_id=$1', [space])).rows[0]!.incarnation
    await f.service.addSpace(space, f.id, 'realm-a', 'After')
    expect((await f.admin.query('SELECT incarnation FROM project_spaces WHERE space_id=$1', [space])).rows[0]!.incarnation).toBe(first)
    await f.admin.query('DELETE FROM project_spaces WHERE space_id=$1', [space])
    expect((await f.admin.query('SELECT count(*)::int AS n FROM project_space_claims WHERE realm=$1 AND space_id=$2', ['realm-a', space])).rows[0]!.n).toBe(1)
    await f.service.addSpace(space, f.id, 'realm-a', 'Recreated')
    expect((await f.admin.query('SELECT incarnation FROM project_spaces WHERE space_id=$1', [space])).rows[0]!.incarnation).not.toBe(first)
    await f.admin.query('DELETE FROM projects WHERE id=$1', [f.id])
    expect((await f.admin.query('SELECT count(*)::int AS n FROM project_space_claims WHERE realm=$1 AND space_id=$2', ['realm-a', space])).rows[0]!.n).toBe(1)
  })
  live('duplicate creation cannot grant ownership and cross-realm reads/writes fail closed', async () => {
    const f = await fixture()
    await expect(f.service.create(f.project, 'intruder')).rejects.toThrow('项目 ID 已存在')
    expect(await f.service.roleOf(f.id, 'intruder')).toBeUndefined()
    expect(await f.service.roleOf(f.id, 'owner')).toBe('owner')
    const foreign = new ProjectService(f.dsn, 'realm-b')
    const unbound = new ProjectService(f.dsn)
    resources.push(foreign, unbound)
    for (const other of [foreign, unbound]) {
      expect(await other.dashboard(f.id)).toBeUndefined()
      expect(await other.roleOf(f.id, 'owner')).toBeUndefined()
      await expect(other.archive(f.id)).rejects.toThrow()
      await expect(other.addMember(f.id, 'intruder', 'owner')).rejects.toThrow()
      await expect(other.attachArtifact(f.id, 'skill', 'stolen', '1')).rejects.toThrow()
      await expect(other.addAutomation(randomUUID(), f.id, 'event', 'event', 'flow')).rejects.toThrow()
    }
    await expect(foreign.create({ ...f.project, realm: 'realm-b' }, 'intruder')).rejects.toThrow('项目 ID 已存在')
    await expect(unbound.create(f.project, 'intruder')).rejects.toThrow('Realm')
    expect((await f.service.dashboard(f.id))?.project.state).toBe('active')
  })

  live('global resource IDs cannot overwrite another project or realm', async () => {
    const f = await fixture()
    const otherId = randomUUID()
    await f.service.create({ ...f.project, projectId: otherId, name: otherId }, 'owner')
    const space = randomUUID()
    const automation = randomUUID()
    await f.service.addSpace(space, f.id, 'realm-a', 'Original')
    await f.service.addAutomation(automation, f.id, 'event', 'original', 'flow-1')
    await expect(f.service.addSpace(space, otherId, 'realm-a', 'Overwritten')).rejects.toThrow('其他项目')
    await expect(f.service.addAutomation(automation, otherId, 'cron', '* * * * *', 'flow-2')).rejects.toThrow('其他项目')
    await expect(f.service.addSpace(randomUUID(), f.id, 'realm-b', 'Foreign')).rejects.toThrow('Realm')
    const foreign = new ProjectService(f.dsn, 'realm-b')
    resources.push(foreign)
    const foreignId = randomUUID()
    await foreign.create({ ...f.project, projectId: foreignId, name: foreignId, realm: 'realm-b' }, 'owner')
    await expect(foreign.addSpace(space, foreignId, 'realm-b', 'Foreign')).rejects.toThrow('其他项目')
    await expect(foreign.addAutomation(automation, foreignId, 'event', 'foreign', 'foreign')).rejects.toThrow('其他项目')
    const dashboard = await f.service.dashboard(f.id)
    expect(dashboard?.spaces).toEqual([{ spaceId: space, name: 'Original' }])
    expect(dashboard?.automations).toMatchObject([{ automationId: automation, triggerSpec: 'original', flowRef: 'flow-1', revision: 1 }])
  })

  live('legacy schema initialization adds revision and each legacy automation write invalidates Go CAS drafts', async () => {
    const f = await fixture()
    await f.admin.query('ALTER TABLE project_automations DROP COLUMN revision')
    await f.service.init()
    await f.service.init()
    const automation = randomUUID()
    await f.service.addAutomation(automation, f.id, 'event', 'created', 'flow-1')
    const original = (await f.service.dashboard(f.id))!.automations[0]!
    expect(original.revision).toBe(1)
    await f.admin.query('UPDATE project_automations SET enabled=false WHERE automation_id=$1', [automation])
    await f.service.addAutomation(automation, f.id, 'webhook', 'updated', 'flow-2')
    const stale = await f.admin.query(
      'UPDATE project_automations SET flow_ref=$3,revision=revision+1 WHERE automation_id=$1 AND revision=$2',
      [automation, original.revision, 'stale-go-write'],
    )
    expect(stale.rowCount).toBe(0)
    expect((await f.service.dashboard(f.id))?.automations).toEqual([{
      automationId: automation, triggerKind: 'webhook', triggerSpec: 'updated', flowRef: 'flow-2', enabled: false, revision: 2,
    }])
  })

  live('archived projects reject resource writes while owners retain membership administration', async () => {
    const f = await fixture()
    const space = randomUUID()
    const automation = randomUUID()
    await f.service.addSpace(space, f.id, 'realm-a', 'Original')
    await f.service.addAutomation(automation, f.id, 'event', 'original', 'flow')
    await f.service.archive(f.id)
    await expect(f.service.addSpace(space, f.id, 'realm-a', 'Changed')).rejects.toThrow('归档')
    await expect(f.service.addAutomation(automation, f.id, 'event', 'changed', 'changed')).rejects.toThrow('归档')
    await expect(f.service.attachArtifact(f.id, 'skill', 'changed', '1')).rejects.toThrow('归档')
    await f.service.addMember(f.id, 'viewer', 'viewer')
    const dashboard = await f.service.dashboard(f.id)
    expect(dashboard?.project.state).toBe('archived')
    expect(dashboard?.spaces).toEqual([{ spaceId: space, name: 'Original' }])
    expect(dashboard?.automations[0]?.revision).toBe(1)
    expect(dashboard?.artifacts).toEqual([])
    expect(await f.service.roleOf(f.id, 'viewer')).toBe('viewer')
  })

  live('resource writes recheck archive status after waiting for the shared parent lock', async () => {
    const f = await fixture()
    await f.admin.query('BEGIN')
    await f.admin.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [f.id])
    const pending = f.service.addSpace(randomUUID(), f.id, 'realm-a', 'Late')
    const assertion = expect(pending).rejects.toThrow('归档')
    await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [f.id])
    await f.admin.query('COMMIT')
    await assertion
    expect((await f.service.dashboard(f.id))?.spaces).toEqual([])
  })

  live('concurrent legacy owner downgrades retain one owner', async () => {
    const f = await fixture()
    await f.service.addMember(f.id, 'owner-2', 'owner')
    const results = await Promise.allSettled([
      f.service.addMember(f.id, 'owner', 'viewer'),
      f.service.addMember(f.id, 'owner-2', 'viewer'),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await f.service.dashboard(f.id))?.members.filter(member => member.role === 'owner')).toHaveLength(1)
    await expect(f.service.addMember(f.id, 'invalid', 'invalid' as never)).rejects.toThrow('无效项目角色')
  })
})
