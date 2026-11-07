import { createHash, randomUUID } from 'node:crypto'
import { assertTeamId, parseTeamState, TEAM_TABLE, teamStorageKey, type KvUnitLike } from './store.ts'

export interface LegacyTeamMapping {
  id: string
  realm: string
  ownerUserId: string
  captainSessionId: string
  sourceHash: string
}

export interface MigrationUnit extends KvUnitLike {
  moveRecordIfUnchanged(table: string, sourceKey: string, targetKey: string, expected: unknown, sourceNext: unknown, targetNext: unknown): Promise<boolean>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function legacyTeamHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function parseLegacyMappings(input: unknown): LegacyTeamMapping[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) throw new Error('迁移映射需要 1..500 条记录')
  const ids = new Set<string>()
  return input.map(value => {
    if (typeof value !== 'object' || value === null) throw new Error('迁移映射必须是对象')
    const entry = value as Record<string, unknown>
    for (const key of ['id', 'realm', 'ownerUserId', 'captainSessionId', 'sourceHash']) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '' || entry[key].length > 512) throw new Error(`迁移映射缺少或含无效 ${key}`)
    }
    const mapping = entry as unknown as LegacyTeamMapping
    assertTeamId(mapping.id)
    if (!/^[a-f0-9]{64}$/u.test(mapping.sourceHash)) throw new Error('sourceHash 必须是 inventory 中的 SHA256')
    if (ids.has(mapping.id)) throw new Error(`重复的旧团队映射：${mapping.id}`)
    ids.add(mapping.id)
    return { id: mapping.id, realm: mapping.realm, ownerUserId: mapping.ownerUserId, captainSessionId: mapping.captainSessionId, sourceHash: mapping.sourceHash }
  })
}

/** Inventory exposes identity and a stable fingerprint, never task contents. */
export async function legacyTeamInventory(unit: KvUnitLike) {
  const table = (await unit.loadAll()).tables[TEAM_TABLE] ?? {}
  return Object.entries(table).flatMap(([key, raw]) => {
    if (typeof raw !== 'object' || raw === null || (raw as { kind?: string }).kind === 'lumo-team-deleted') return []
    // Scoped keys are deliberately not accepted as legacy inputs.
    if ((raw as { id?: unknown }).id !== key) return []
    const team = parseTeamState(raw, key)
    return [{ id: team.id, name: team.name, captainSessionId: team.captainSessionId,
      realm: team.realm ?? null, ownerUserId: team.ownerUserId ?? null,
      activeTasks: team.tasks.filter(task => task.status === 'claimed' || task.status === 'in_progress').length,
      sourceHash: legacyTeamHash(raw) }]
  })
}

function completedMigration(table: Record<string, unknown>, mapping: LegacyTeamMapping): boolean {
  const source = table[mapping.id] as Record<string, unknown> | undefined
  if (source?.['kind'] !== 'lumo-team-deleted' || source['id'] !== mapping.id
    || canonical(source['migration']) !== canonical(mapping)) return false
  const target = table[teamStorageKey(mapping.realm, mapping.id)] as Record<string, unknown> | undefined
  // A later legitimate deletion remains completed; never recreate its target.
  if (target?.['kind'] === 'lumo-team-deleted') {
    return target['id'] === mapping.id && target['realm'] === mapping.realm
      && typeof target['revision'] === 'string' && target['revision'] !== ''
  }
  if (target === undefined) return false
  try {
    const team = parseTeamState(target, mapping.id)
    return team.id === mapping.id && team.realm === mapping.realm
      && team.ownerUserId === mapping.ownerUserId && team.captainSessionId === mapping.captainSessionId
  } catch { return false }
}

/** Explicit trusted mapping only. All entries are checked before the first write.
 * Each move commits the target and legacy tombstone atomically; the whole batch
 * is resumable, not a transaction across teams. Old writers must be stopped. */
export async function migrateLegacyTeams(unit: MigrationUnit, input: unknown, options: { apply?: boolean; writersStopped?: boolean } = {}) {
  const mappings = parseLegacyMappings(input)
  if (options.apply && !options.writersStopped) throw new Error('实际迁移必须确认旧版本写入与派发已停止')
  const table = (await unit.loadAll()).tables[TEAM_TABLE] ?? {}
  const plans = mappings.map(mapping => {
    const source = table[mapping.id]
    const targetKey = teamStorageKey(mapping.realm, mapping.id)
    const raw = source as Record<string, unknown> | undefined
    if (completedMigration(table, mapping)) {
      return { mapping, targetKey, source, done: true }
    }
    if (source === undefined || raw?.['kind'] === 'lumo-team-deleted') throw new Error(`旧团队 ${mapping.id} 不存在或已被其他映射迁移`)
    const team = parseTeamState(source, mapping.id)
    if (team.id !== mapping.id || team.captainSessionId !== mapping.captainSessionId
      || (team.realm !== undefined && team.realm !== mapping.realm)
      || (team.ownerUserId !== undefined && team.ownerUserId !== mapping.ownerUserId)) throw new Error(`旧团队 ${mapping.id} 的身份与映射冲突`)
    if (legacyTeamHash(source) !== mapping.sourceHash) throw new Error(`旧团队 ${mapping.id} 已变化，需要重新核对 inventory`)
    if (team.tasks.some(task => task.status === 'claimed' || task.status === 'in_progress')) throw new Error(`旧团队 ${mapping.id} 仍有在途任务，先对账排空`)
    if (table[targetKey] !== undefined) throw new Error(`目标团队 ${mapping.id} 已存在或有删除墓碑，拒绝覆盖`)
    return { mapping, targetKey, source, done: false }
  })
  const results = []
  for (const plan of plans) {
    if (!options.apply || plan.done) {
      results.push({ id: plan.mapping.id, realm: plan.mapping.realm, status: plan.done ? 'already-migrated' : 'ready' })
      continue
    }
    const next = { ...(plan.source as Record<string, unknown>), realm: plan.mapping.realm,
      ownerUserId: plan.mapping.ownerUserId, revision: randomUUID() }
    const tombstone = { kind: 'lumo-team-deleted', id: plan.mapping.id, revision: randomUUID(),
      deletedAt: Date.now(), migration: plan.mapping }
    if (!await unit.moveRecordIfUnchanged(TEAM_TABLE, plan.mapping.id, plan.targetKey, plan.source, tombstone, next)) {
      // A competing migration may have committed the same mapping while we waited.
      const latest = (await unit.loadAll()).tables[TEAM_TABLE] ?? {}
      if (!completedMigration(latest, plan.mapping)) {
        throw new Error(`团队 ${plan.mapping.id} 迁移发生并发冲突；已完成条目保留，可核对后重试`)
      }
    }
    results.push({ id: plan.mapping.id, realm: plan.mapping.realm, status: 'migrated' })
  }
  return { applied: options.apply === true, teams: results }
}
