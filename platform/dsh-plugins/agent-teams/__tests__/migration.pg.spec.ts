import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PgStorageBackend, PgKvUnit } from '../../storage/src/index.ts'
import { freshSchemaDsn } from '../../storage/__tests__/pg-schema.ts'
import { createTeam, addTasks } from '../src/model.ts'
import { legacyTeamHash, legacyTeamInventory, migrateLegacyTeams } from '../src/migration.ts'
import { StorageHubTeamStore, TEAM_UNIT_NAME, TEAM_TABLE, teamStorageKey } from '../src/store.ts'

const pgTest = process.env.LUMO_TEST_PG_DSN ? it : it.skip
const execute = promisify(execFile)

describe('旧团队显式归属迁移（真实 PG）', () => {
  const closers: Array<() => Promise<unknown>> = []
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(closers.splice(0).map(close => close())) })
  async function fixture() {
    const dsn = await freshSchemaDsn(process.env.LUMO_TEST_PG_DSN!, 'team_migration')
    const backend = new PgStorageBackend(dsn)
    closers.push(() => backend.close())
    const unit = await backend.kv.open({ name: TEAM_UNIT_NAME, version: 1, tables: [TEAM_TABLE], hasGlobal: false }) as PgKvUnit
    const team = { ...addTasks(createTeam({ id: 'old', name: '旧团队', topology: 'pipeline', captainSessionId: 'captain', now: 1 }), [{ subject: '历史任务' }], 1).team,
      extension: { preserve: true } }
    await unit.putRecord(TEAM_TABLE, 'old', team)
    const mapping = { id: 'old', realm: 'a', ownerUserId: 'owner', captainSessionId: 'captain', sourceHash: legacyTeamHash(team) }
    return { backend, unit, team, mapping, dsn }
  }

  pgTest('默认预览不移动记录；显式应用同时留下源墓碑与可读目标，重开后重试幂等', async () => {
    const { backend, unit, team, mapping, dsn } = await fixture()
    expect(await legacyTeamInventory(unit)).toMatchObject([{ id: 'old', activeTasks: 0, sourceHash: mapping.sourceHash }])
    expect(JSON.stringify(await legacyTeamInventory(unit))).not.toContain('历史任务')
    expect(await migrateLegacyTeams(unit, [mapping])).toMatchObject({ applied: false, teams: [{ status: 'ready' }] })
    expect(await unit.getRecord(TEAM_TABLE, 'old')).toEqual(team)
    await expect(migrateLegacyTeams(unit, [mapping], { apply: true })).rejects.toThrow('停止')
    await migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true })
    expect(await unit.getRecord(TEAM_TABLE, 'old')).toMatchObject({ kind: 'lumo-team-deleted', migration: mapping })
    expect(await unit.getRecord(TEAM_TABLE, teamStorageKey('a', 'old'))).toMatchObject({ realm: 'a', ownerUserId: 'owner', extension: { preserve: true } })
    await backend.close()
    const reopened = new PgStorageBackend(dsn)
    closers.push(() => reopened.close())
    const again = await reopened.kv.open({ name: TEAM_UNIT_NAME, version: 1, tables: [TEAM_TABLE], hasGlobal: false }) as PgKvUnit
    expect(await migrateLegacyTeams(again, [mapping], { apply: true, writersStopped: true })).toMatchObject({ teams: [{ status: 'already-migrated' }] })
    await again.close()
    const store = new StorageHubTeamStore(reopened as never, { realm: 'a', requireAtomic: true })
    expect(await store.load('old')).toMatchObject({ id: 'old', realm: 'a', ownerUserId: 'owner' })
    await store.close()
  })

  pgTest('身份、指纹、在途执行或目标墓碑冲突均拒绝，不覆盖任何记录', async () => {
    const { unit, mapping, team } = await fixture()
    for (const invalid of [ { ...mapping, captainSessionId: 'forged' }, { ...mapping, sourceHash: '0'.repeat(64) },
      { ...mapping, realm: '' }, { ...mapping, ownerUserId: '' } ]) {
      await expect(migrateLegacyTeams(unit, [invalid], { apply: true, writersStopped: true })).rejects.toThrow()
      expect(await unit.getRecord(TEAM_TABLE, 'old')).toEqual(team)
    }
    const active = { ...team, tasks: team.tasks.map(task => ({ ...task, status: 'claimed' })) }
    await unit.putRecord(TEAM_TABLE, 'old', active)
    await expect(migrateLegacyTeams(unit, [{ ...mapping, sourceHash: legacyTeamHash(active) }])).rejects.toThrow('在途任务')
    await unit.putRecord(TEAM_TABLE, 'old', team)
    await unit.putRecord(TEAM_TABLE, teamStorageKey('a', 'old'), { kind: 'lumo-team-deleted' })
    await expect(migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true })).rejects.toThrow('拒绝覆盖')
  })

  pgTest('两个不同归属并发迁移只有一个成功，旧快照改变时不生成目标', async () => {
    const { unit, mapping, team } = await fixture()
    const outcomes = await Promise.allSettled([
      migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true }),
      migrateLegacyTeams(unit, [{ ...mapping, realm: 'b' }], { apply: true, writersStopped: true }),
    ])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const records = (await unit.loadAll()).tables[TEAM_TABLE]!
    expect(Object.values(records).filter(value => (value as { id?: string }).id === 'old' && !(value as { kind?: string }).kind)).toHaveLength(1)
    await unit.putRecord(TEAM_TABLE, 'late', { ...team, id: 'late' })
    const move = unit.moveRecordIfUnchanged.bind(unit)
    vi.spyOn(unit, 'moveRecordIfUnchanged').mockImplementationOnce(async (...args) => {
      await unit.putRecord(TEAM_TABLE, 'late', { ...team, id: 'late', name: 'changed' })
      return move(...args)
    })
    await expect(migrateLegacyTeams(unit, [{ ...mapping, id: 'late', sourceHash: legacyTeamHash({ ...team, id: 'late' }) }], { apply: true, writersStopped: true })).rejects.toThrow('并发冲突')
    expect(await unit.getRecord(TEAM_TABLE, teamStorageKey('a', 'late'))).toBeUndefined()
  })

  pgTest('后续映射不合法时整个预检拒绝，首条尚未写入', async () => {
    const { unit, mapping, team } = await fixture()
    await expect(migrateLegacyTeams(unit, [mapping, { ...mapping, id: 'missing' }], { apply: true, writersStopped: true })).rejects.toThrow('不存在')
    expect(await unit.getRecord(TEAM_TABLE, 'old')).toEqual(team)
  })

  pgTest('重试核对目标归属，合法删除后不会复活，伪造或丢失的目标不能视为迁移完成', async () => {
    const { unit, mapping, dsn } = await fixture()
    await migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true })
    const key = teamStorageKey(mapping.realm, mapping.id)
    const target = await unit.getRecord(TEAM_TABLE, key) as Record<string, unknown>
    for (const invalid of [ { ...target, ownerUserId: 'other' }, { ...target, captainSessionId: 'other' },
      { kind: 'lumo-team-deleted', id: 'other', realm: mapping.realm, revision: 'x' } ]) {
      await unit.putRecord(TEAM_TABLE, key, invalid)
      await expect(migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true })).rejects.toThrow('其他映射')
    }
    await unit.deleteRecord(TEAM_TABLE, key)
    await expect(migrateLegacyTeams(unit, [mapping])).rejects.toThrow('其他映射')
    await unit.putRecord(TEAM_TABLE, key, target)
    const backend = new PgStorageBackend(dsn)
    closers.push(() => backend.close())
    const store = new StorageHubTeamStore(backend as never, { realm: mapping.realm, requireAtomic: true })
    await store.remove(mapping.id)
    expect(await migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true })).toMatchObject({ teams: [{ status: 'already-migrated' }] })
    expect(await store.load(mapping.id)).toBeUndefined()
    await store.close()
  })

  pgTest('源墓碑写入失败时目标插入也回滚，目标抢占时保持源不变', async () => {
    const { unit, team, mapping, dsn } = await fixture()
    const { default: pg } = await import('../../storage/node_modules/pg/lib/index.js')
    const client = new pg.Client({ connectionString: dsn })
    await client.connect()
    try {
      await client.query(`ALTER TABLE u_lumo_agent_teams_teams ADD CONSTRAINT reject_marker
        CHECK (value::jsonb->>'kind' IS DISTINCT FROM 'lumo-team-deleted')`)
      await expect(migrateLegacyTeams(unit, [mapping], { apply: true, writersStopped: true })).rejects.toThrow()
      expect(await unit.getRecord(TEAM_TABLE, 'old')).toEqual(team)
      expect(await unit.getRecord(TEAM_TABLE, teamStorageKey('a', 'old'))).toBeUndefined()
      await client.query('ALTER TABLE u_lumo_agent_teams_teams DROP CONSTRAINT reject_marker')
      const occupied = { ...team, name: 'new owner' }
      await unit.putRecord(TEAM_TABLE, teamStorageKey('a', 'old'), occupied)
      expect(await unit.moveRecordIfUnchanged(TEAM_TABLE, 'old', teamStorageKey('a', 'old'), team, { kind: 'marker' }, team)).toBe(false)
      expect(await unit.getRecord(TEAM_TABLE, 'old')).toEqual(team)
      expect(await unit.getRecord(TEAM_TABLE, teamStorageKey('a', 'old'))).toEqual(occupied)
    } finally { await client.end() }
  })

  pgTest('真实命令默认预览，应用与重复执行可跨独立进程完成', async () => {
    const { unit, mapping, dsn } = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'lumo-team-migration-'))
    closers.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'mapping.json')
    await writeFile(path, JSON.stringify([mapping]), { mode: 0o600 })
    const run = (...args: string[]) => execute(process.execPath, ['tools/migrate-agent-teams.mjs', ...args], {
      env: { ...process.env, LUMO_TEAM_MIGRATION_DSN: dsn }, timeout: 15_000,
    })
    expect(JSON.parse((await run('--inventory')).stdout).teams).toHaveLength(1)
    expect(JSON.parse((await run('--mapping', path)).stdout).applied).toBe(false)
    expect(await unit.getRecord(TEAM_TABLE, teamStorageKey('a', 'old'))).toBeUndefined()
    expect(JSON.parse((await run('--mapping', path, '--apply', '--writers-stopped')).stdout).teams[0].status).toBe('migrated')
    expect(JSON.parse((await run('--mapping', path, '--apply', '--writers-stopped')).stdout).teams[0].status).toBe('already-migrated')
  })
})
