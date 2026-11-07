/**
 * @lumo/agent-teams 的团队状态存储。
 *
 * ## 为什么走 dsh 的 storage hub，而不是自己写 sqlite + PG 两套
 *
 * 单机形态（桌面）只允许 SQLite，集群形态只允许 PostgreSQL —— 这是部署形态的硬
 * 约束（`dsh-node/src/index.ts` 的 local 分支注释写着「SQLite only. No PostgreSQL,
 * Redis, MinIO, RocketMQ or Nacos」）。若本插件自己适配两种介质，就会长出两套
 * 读写路径、两套迁移、两套测试。
 *
 * dsh 的 storage hub 已经把这件事抽象掉了：先从 `ctx.storage.backend`
 * 按部署配置取后端，再用其 `kv.open(descriptor)` 拿到 key→JSON 的表。
 * 单机下后端是 `@deepseek-ai/dsh-storage-sqlite`，集群下是 `@lumo/storage`（PG）。
 * 于是本插件只有一份读写代码，两形态零分叉。
 *
 * ## 写序
 *
 * `AgentTeamsService` 的团队写链负责同实例排序；存储 CAS 负责跨实例原子提交。
 * PG 必须提供 `compareAndSetRecord`，防止多个节点用旧快照相互覆盖。
 * SQLite 在共享的单元对象上串行比较与写入，只承诺单进程语义。
 * 删除写入墓碑，阻止迟到快照复活团队，也阻止重用已删除的团队 id。
 */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { TeamState } from './model.ts'
import { TeamError } from './model.ts'

/** 存储单元名。须匹配 dsh 的 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`。 */
export const TEAM_UNIT_NAME = 'lumo_agent_teams'
/** 物理布局版本；可选 JSON 字段不改变布局，旧记录不会被自动认领。 */
export const TEAM_UNIT_VERSION = 1
/** 团队记录所在的表名。 */
export const TEAM_TABLE = 'teams'

/** Shared by the runtime and explicit legacy migration. */
export function teamStorageKey(realm: string, id: string): string {
  assertTeamId(id)
  return teamStoragePrefix(realm) + id
}

function teamStoragePrefix(realm: string): string {
  if (realm.trim() === '') throw new TeamError('团队租户不能为空', 'BAD_STATE')
  return `r_${createHash('sha256').update(realm).digest('hex')}_`
}

/**
 * 团队 id 的合法形态。
 *
 * `per-record` 布局下 key 会变成路径段，后端要求 `[a-zA-Z0-9_-]+`。在这里先闸住，
 * 好过让一个含 `/` 的 id 在写盘时才炸 —— 那时团队已经建了一半。
 */
export const TEAM_ID_RE = /^[a-zA-Z0-9_-]+$/

/** 团队状态存储。 */
export interface AgentTeamStore {
  /** 打开底层单元。幂等。 */
  init(): Promise<void>
  /** 列出全部团队。 */
  list(): Promise<TeamState[]>
  /** 读取一个团队；不存在返回 undefined。 */
  load(id: string): Promise<TeamState | undefined>
  /** 整体覆盖写一个团队。 */
  save(team: TeamState): Promise<void>
  /** 删除一个团队。幂等。 */
  remove(id: string): Promise<void>
  /** 原子条件提交；expected 缺省为仅创建，next 缺省为删除并保留墓碑。 */
  compareAndSet(id: string, expected: TeamState | undefined, next: TeamState | undefined): Promise<boolean>
  /** 释放底层介质。幂等。 */
  close(): Promise<void>
}

/** 存储单元的最小门面（dsh `KvUnit` 的结构等价子集）。 */
export interface KvUnitLike {
  getRecord?(table: string, key: string): Promise<unknown>
  compareAndSetRecord?(table: string, key: string, expected: unknown, next: unknown): Promise<boolean>
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  close(): Promise<void>
}

/** 已选中存储后端的 kv 门面（不是 `ctx.storage` 本身）。 */
export interface StorageFacetLike {
  kv: {
    open(descriptor: {
      name: string
      version: number
      tables: readonly string[]
      hasGlobal: boolean
      layout?: 'single' | 'per-record'
    }): Promise<KvUnitLike>
  }
}

/** 记录结构不合法。读路径遇到脏数据必须响亮，不能把半条团队喂进任务板。 */
export class TeamRecordError extends Error {
  constructor(message: string, readonly teamId: string) {
    super(message)
    this.name = 'TeamRecordError'
  }
}

const TASK_STATUSES = new Set(['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'])
const MEMBER_STATUSES = new Set(['idle', 'working', 'removed'])
const TOPOLOGY_SET = new Set(['planner-worker', 'pipeline', 'deliberation'])

function requireString(value: unknown, field: string, teamId: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TeamRecordError(`团队 ${teamId} 的 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`, teamId)
  }
  return value
}

/**
 * 把存储里读到的 JSON 校验成 `TeamState`。
 *
 * 只校验**结构性**不变量（类型、必需字段、枚举闭集），不重跑 `assertDependencyGraph`：
 * 依赖图校验是写入路径的职责，读路径只负责不把非团队对象当成团队。
 */
export function parseTeamState(value: unknown, teamId: string): TeamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TeamRecordError(`团队 ${teamId} 的记录不是对象`, teamId)
  }
  const raw = value as Record<string, unknown>
  const topology = requireString(raw['topology'], 'topology', teamId)
  if (!TOPOLOGY_SET.has(topology)) {
    throw new TeamRecordError(`团队 ${teamId} 的 topology 不在闭集内：${topology}`, teamId)
  }
  if (!Array.isArray(raw['members']) || !Array.isArray(raw['tasks'])) {
    throw new TeamRecordError(`团队 ${teamId} 的 members/tasks 必须是数组`, teamId)
  }
  const members = raw['members'].map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TeamRecordError(`团队 ${teamId} 的 members[${index}] 不是对象`, teamId)
    }
    const member = entry as Record<string, unknown>
    const status = requireString(member['status'], `members[${index}].status`, teamId)
    if (!MEMBER_STATUSES.has(status)) {
      throw new TeamRecordError(`团队 ${teamId} 的 members[${index}].status 非法：${status}`, teamId)
    }
    return {
      name: requireString(member['name'], `members[${index}].name`, teamId),
      ...typeof member['role'] === 'string' ? { role: member['role'] } : {},
      provider: requireString(member['provider'], `members[${index}].provider`, teamId),
      ...typeof member['model'] === 'string' ? { model: member['model'] } : {},
      // 这个解析就是「重载」那一段：少了它，ownerUserId 会被写进介质、却在读回来的
      // 那一刻被无声丢掉，症状是「重启后智能体全变成未绑定」——而写入侧看起来一切正常。
      // `team_owner_roundtrip` 那条用例钉的就是这里。
      ...typeof member['ownerUserId'] === 'string' ? { ownerUserId: member['ownerUserId'] } : {},
      status: status as TeamState['members'][number]['status'],
      joinedAt: typeof member['joinedAt'] === 'number' ? member['joinedAt'] : 0,
    }
  })
  const tasks = raw['tasks'].map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TeamRecordError(`团队 ${teamId} 的 tasks[${index}] 不是对象`, teamId)
    }
    const task = entry as Record<string, unknown>
    const status = requireString(task['status'], `tasks[${index}].status`, teamId)
    if (!TASK_STATUSES.has(status)) {
      throw new TeamRecordError(`团队 ${teamId} 的 tasks[${index}].status 非法：${status}`, teamId)
    }
    const dependencies = Array.isArray(task['dependencies']) ? task['dependencies'] : []
    // 证据与 dependencies 同形，且同样「脏数据不该让整行读不出来」：非字符串与空白条目
    // 一律丢弃（`acceptanceVerdict` 也只认非空白，两侧口径一致）。
    const evidence = Array.isArray(task['evidence'])
      ? task['evidence'].filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : []
    return {
      id: requireString(task['id'], `tasks[${index}].id`, teamId),
      subject: requireString(task['subject'], `tasks[${index}].subject`, teamId),
      ...typeof task['description'] === 'string' ? { description: task['description'] } : {},
      // 这一段解析漏掉哪个字段，那个字段就会被写进介质、又在读回来的那一刻被无声丢掉。
      // acceptance 漏掉的症状最隐蔽：任务板看起来完全正常，只是重启后所有任务都变成
      // 「没有验收条件」，于是验收全线 fail-closed —— 而写入侧一切正常。
      // `store.spec.ts` 的 acceptance 往返用例钉的就是这里。
      ...typeof task['acceptance'] === 'string' ? { acceptance: task['acceptance'] } : {},
      // 只认显式 `true`：旧行没有这个键，脏数据里的字符串 `"true"` / `1` 都不是它。
      // 漏解析的症状与 `acceptance` 同族但更隐蔽——重启后延续性任务静默退回 spawn，
      // 一切看起来正常，只是每次少了一截上下文。
      ...task['continuesContext'] === true ? { continuesContext: true } : {},
      status: status as TeamState['tasks'][number]['status'],
      ...typeof task['assignee'] === 'string' ? { assignee: task['assignee'] } : {},
      dependencies: dependencies.filter((dep): dep is string => typeof dep === 'string'),
      ...typeof task['output'] === 'string' ? { output: task['output'] } : {},
      // 漏掉这一段，证据会被读成「没有证据」，于是**每一条交付都要人审**。fail-closed 的
      // 方向没错，但成因会被误判成「成员没交证据」，而真正的问题在读侧——这类错位最难查。
      ...evidence.length === 0 ? {} : { evidence },
      attempt: typeof task['attempt'] === 'number' ? task['attempt'] : 0,
      createdAt: typeof task['createdAt'] === 'number' ? task['createdAt'] : 0,
      updatedAt: typeof task['updatedAt'] === 'number' ? task['updatedAt'] : 0,
    }
  })
  return {
    id: requireString(raw['id'], 'id', teamId),
    ...raw['realm'] === undefined ? {} : { realm: requireString(raw['realm'], 'realm', teamId) },
    ...raw['ownerUserId'] === undefined ? {} : { ownerUserId: requireString(raw['ownerUserId'], 'ownerUserId', teamId) },
    ...raw['revision'] === undefined ? {} : { revision: requireString(raw['revision'], 'revision', teamId) },
    name: requireString(raw['name'], 'name', teamId),
    ...typeof raw['description'] === 'string' ? { description: raw['description'] } : {},
    topology: topology as TeamState['topology'],
    captainSessionId: requireString(raw['captainSessionId'], 'captainSessionId', teamId),
    members,
    tasks,
    taskSeq: typeof raw['taskSeq'] === 'number' ? raw['taskSeq'] : tasks.length,
    createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : 0,
  }
}

/** 校验团队 id 可安全用作存储键。 */
export function assertTeamId(id: string): void {
  if (!TEAM_ID_RE.test(id)) {
    throw new TeamError(
      `团队 id ${JSON.stringify(id)} 不合法：只允许 [A-Za-z0-9_-]，因为 per-record 布局下它要当路径段`,
      'BAD_STATE',
    )
  }
}

/** 进程内存储。测试用，也是 storage 未挂载时的兜底（能力降级，不是静默丢失）。 */
export class MemoryTeamStore implements AgentTeamStore {
  private readonly teams = new Map<string, TeamState>()
  private readonly deleted = new Set<string>()

  init(): Promise<void> {
    return Promise.resolve()
  }

  list(): Promise<TeamState[]> {
    return Promise.resolve(structuredClone([...this.teams.values()]))
  }

  load(id: string): Promise<TeamState | undefined> {
    return Promise.resolve(structuredClone(this.teams.get(id)))
  }

  async save(team: TeamState): Promise<void> {
    assertTeamId(team.id)
    if (this.deleted.has(team.id)) throw new TeamError('已删除的团队 id 不可复用', 'DUPLICATE_TEAM')
    this.teams.set(team.id, structuredClone(team))
  }

  remove(id: string): Promise<void> {
    this.teams.delete(id)
    this.deleted.add(id)
    return Promise.resolve()
  }

  async compareAndSet(id: string, expected: TeamState | undefined, next: TeamState | undefined): Promise<boolean> {
    assertTeamId(id)
    if (this.deleted.has(id) || !isDeepStrictEqual(this.teams.get(id), expected)) return false
    if (next === undefined) {
      this.teams.delete(id)
      this.deleted.add(id)
    } else {
      if (next.id !== id) throw new TeamError('团队 id 不可变更', 'BAD_STATE')
      this.teams.set(id, structuredClone(next))
    }
    return true
  }

  close(): Promise<void> {
    this.teams.clear()
    this.deleted.clear()
    return Promise.resolve()
  }
}

/**
 * 走 dsh storage hub 的存储。
 *
 * 单机形态后端是 sqlite，集群形态后端是 PG —— 这里看不到区别，这正是目的。
 * 本类提供带租户命名空间的读写和原子 CAS。PG 使用后端条件语句；SQLite
 * 在单元对象上串行比较与写入。服务层写链只承担同实例排序。
 */
export class StorageHubTeamStore implements AgentTeamStore {
  private unit: KvUnitLike | undefined
  private opening: Promise<KvUnitLike> | undefined
  private readonly originals = new WeakMap<TeamState, unknown>()
  private readonly prefix: string

  constructor(private readonly storage: StorageFacetLike, private readonly scope?: { realm: string; requireAtomic?: boolean }) {
    this.prefix = scope === undefined ? '' : teamStoragePrefix(scope.realm)
  }

  private key(id: string): string {
    assertTeamId(id)
    return this.prefix + id
  }

  private decode(raw: unknown, id: string): TeamState | undefined {
    if (raw === undefined || isTombstone(raw)) return undefined
    const team = parseTeamState(raw, id)
    if (team.id !== id || (this.scope !== undefined && team.realm !== this.scope.realm)) {
      throw new TeamRecordError(`团队 ${id} 的存储键或租户不匹配`, id)
    }
    this.originals.set(team, structuredClone(raw))
    return team
  }

  private assertScope(team: TeamState): void {
    if (this.scope !== undefined && team.realm !== this.scope.realm) {
      throw new TeamError('团队不属于当前租户', 'FORBIDDEN')
    }
  }

  private async open(): Promise<KvUnitLike> {
    if (this.unit !== undefined) return this.unit
    this.opening ??= this.storage.kv.open({
      name: TEAM_UNIT_NAME,
      version: TEAM_UNIT_VERSION,
      tables: [TEAM_TABLE],
      hasGlobal: false,
      layout: 'per-record',
    }).then((unit) => {
      if (this.scope?.requireAtomic && unit.compareAndSetRecord === undefined) {
        void unit.close()
        throw new TeamError('集群团队存储必须支持原子条件写入', 'BAD_STATE')
      }
      this.unit = unit
      return unit
    })
    return this.opening
  }

  async init(): Promise<void> {
    await this.open()
  }

  private async table(): Promise<Record<string, unknown>> {
    const unit = await this.open()
    const { tables } = await unit.loadAll()
    return tables[TEAM_TABLE] ?? {}
  }

  async list(): Promise<TeamState[]> {
    const records = await this.table()
    return Object.entries(records)
      .filter(([key]) => key.startsWith(this.prefix))
      .map(([key, value]) => this.decode(value, key.slice(this.prefix.length)))
      .filter((team): team is TeamState => team !== undefined)
  }

  async load(id: string): Promise<TeamState | undefined> {
    const unit = await this.open()
    const key = this.key(id)
    const value = unit.getRecord === undefined ? (await this.table())[key] : await unit.getRecord(TEAM_TABLE, key)
    return this.decode(value, id)
  }

  async save(team: TeamState): Promise<void> {
    assertTeamId(team.id)
    this.assertScope(team)
    const unit = await this.open()
    await unit.putRecord(TEAM_TABLE, this.key(team.id), team)
  }

  async remove(id: string): Promise<void> {
    const unit = await this.open()
    await unit.putRecord(TEAM_TABLE, this.key(id), tombstone(id, this.scope?.realm))
  }

  async compareAndSet(id: string, expected: TeamState | undefined, next: TeamState | undefined): Promise<boolean> {
    const unit = await this.open()
    const key = this.key(id)
    if (next !== undefined) {
      if (next.id !== id) throw new TeamError('团队 id 不可变更', 'BAD_STATE')
      this.assertScope(next)
    }
    // 比较介质原值，不能拿白名单解析后的状态比较；否则旧记录的扩展字段会造成永久冲突。
    const before = expected === undefined ? undefined : this.originals.get(expected) ?? expected
    const after = next ?? tombstone(id, this.scope?.realm)
    if (unit.compareAndSetRecord !== undefined) return unit.compareAndSetRecord(TEAM_TABLE, key, before, after)
    // SQLite 只用于单进程装配；所有适配器共享同一打开单元的写链。
    return localCompare(unit, async () => {
      const raw = (await unit.loadAll()).tables[TEAM_TABLE]?.[key]
      if (!isDeepStrictEqual(raw, before)) return false
      await unit.putRecord(TEAM_TABLE, key, after)
      return true
    })
  }

  async close(): Promise<void> {
    const unit = this.unit ?? await this.opening?.catch(() => undefined)
    this.unit = undefined
    this.opening = undefined
    await unit?.close()
  }
}

/**
 * 按可用能力选存储：有 storage hub 就用它（单机 sqlite / 集群 PG 自适应），
 * 否则回落内存。
 *
 * 回落是**显式**的：调用方拿到 `durable: false` 应当记一条警告 —— 团队会随进程
 * 消失，这是能力降级，不是正常形态。
 *
 * 字段名用 `durable` 而不是 `persistent`：与 `TeamCourier.durable`、
 * `AgentTeamsCapabilities.durableStore` 同一套词汇，免得两个近义词在装配层来回翻译。
 */
export function createTeamStore(storage: StorageFacetLike | undefined, scope?: { realm: string; requireAtomic?: boolean }): {
  store: AgentTeamStore
  durable: boolean
} {
  return storage === undefined
    ? { store: new MemoryTeamStore(), durable: false }
    : { store: new StorageHubTeamStore(storage, scope), durable: true }
}

function tombstone(id: string, realm?: string): unknown {
  return { kind: 'lumo-team-deleted', id, realm, revision: randomUUID(), deletedAt: Date.now() }
}

function isTombstone(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'lumo-team-deleted'
}

const localWrites = new WeakMap<KvUnitLike, Promise<unknown>>()
function localCompare<T>(unit: KvUnitLike, run: () => Promise<T>): Promise<T> {
  const previous = localWrites.get(unit) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.then(() => undefined, () => undefined)
  localWrites.set(unit, settled)
  void settled.then(() => { if (localWrites.get(unit) === settled) localWrites.delete(unit) })
  return next
}
