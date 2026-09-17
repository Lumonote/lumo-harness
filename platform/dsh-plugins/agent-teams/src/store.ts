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
 * dsh 的 storage hub 已经把这件事抽象掉了：`ctx.storage.kv.open(descriptor)` 拿到的
 * `KvUnit` 是一张 key→JSON 的表，**介质由后端决定** ——
 * 单机下后端是 `@deepseek-ai/dsh-storage-sqlite`，集群下是 `@lumo/storage`（PG）。
 * 于是本插件只有一份读写代码，两形态零分叉。
 *
 * ## 写序
 *
 * `KvUnit` 契约明说「the unit does NOT serialize concurrent writes — write ordering
 * is the caller's responsibility」。所以本模块**刻意不做**写序：串行化是调用方
 * （`AgentTeamsService.mutate`）的职责，它按团队 id 挂写链。
 *
 * 这一点曾经搞错过 —— 链条一度长在 `StorageHubTeamStore` 里，于是只有走 storage hub
 * 的装配受保护，内存兜底存储退化成无保护的读-改-写，两个成员并行写回会丢结果。
 * 存储适配器只管介质，不替调用方排写序。
 */

import type { TeamState } from './model.ts'
import { TeamError } from './model.ts'

/** 存储单元名。须匹配 dsh 的 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`。 */
export const TEAM_UNIT_NAME = 'lumo_agent_teams'
/** 存储单元格式版本。改 `TeamState` 结构时递增。 */
export const TEAM_UNIT_VERSION = 1
/** 团队记录所在的表名。 */
export const TEAM_TABLE = 'teams'

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
  /** 释放底层介质。幂等。 */
  close(): Promise<void>
}

/** 存储单元的最小门面（dsh `KvUnit` 的结构等价子集）。 */
export interface KvUnitLike {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  close(): Promise<void>
}

/** storage hub 的最小门面（dsh `ctx.storage` 的结构等价子集）。 */
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
    return {
      id: requireString(task['id'], `tasks[${index}].id`, teamId),
      subject: requireString(task['subject'], `tasks[${index}].subject`, teamId),
      ...typeof task['description'] === 'string' ? { description: task['description'] } : {},
      status: status as TeamState['tasks'][number]['status'],
      ...typeof task['assignee'] === 'string' ? { assignee: task['assignee'] } : {},
      dependencies: dependencies.filter((dep): dep is string => typeof dep === 'string'),
      ...typeof task['output'] === 'string' ? { output: task['output'] } : {},
      attempt: typeof task['attempt'] === 'number' ? task['attempt'] : 0,
      createdAt: typeof task['createdAt'] === 'number' ? task['createdAt'] : 0,
      updatedAt: typeof task['updatedAt'] === 'number' ? task['updatedAt'] : 0,
    }
  })
  return {
    id: requireString(raw['id'], 'id', teamId),
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

  init(): Promise<void> {
    return Promise.resolve()
  }

  list(): Promise<TeamState[]> {
    return Promise.resolve([...this.teams.values()])
  }

  load(id: string): Promise<TeamState | undefined> {
    return Promise.resolve(this.teams.get(id))
  }

  async save(team: TeamState): Promise<void> {
    assertTeamId(team.id)
    this.teams.set(team.id, team)
  }

  remove(id: string): Promise<void> {
    this.teams.delete(id)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.teams.clear()
    return Promise.resolve()
  }
}

/**
 * 走 dsh storage hub 的存储。
 *
 * 单机形态后端是 sqlite，集群形态后端是 PG —— 这里看不到区别，这正是目的。
 * 本类只做介质适配（读/写/列/删），**不负责写序**：并发读-改-写的串行化由
 * `AgentTeamsService` 按团队 id 统一保证，好让内存兜底存储享有同一份保证。
 */
export class StorageHubTeamStore implements AgentTeamStore {
  private unit: KvUnitLike | undefined
  private opening: Promise<KvUnitLike> | undefined

  constructor(private readonly storage: StorageFacetLike) {}

  private async open(): Promise<KvUnitLike> {
    if (this.unit !== undefined) return this.unit
    this.opening ??= this.storage.kv.open({
      name: TEAM_UNIT_NAME,
      version: TEAM_UNIT_VERSION,
      tables: [TEAM_TABLE],
      hasGlobal: false,
      layout: 'per-record',
    }).then((unit) => {
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
    return Object.entries(records).map(([id, value]) => parseTeamState(value, id))
  }

  async load(id: string): Promise<TeamState | undefined> {
    const records = await this.table()
    const value = records[id]
    return value === undefined ? undefined : parseTeamState(value, id)
  }

  async save(team: TeamState): Promise<void> {
    assertTeamId(team.id)
    const unit = await this.open()
    await unit.putRecord(TEAM_TABLE, team.id, team)
  }

  async remove(id: string): Promise<void> {
    const unit = await this.open()
    await unit.deleteRecord(TEAM_TABLE, id)
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
export function createTeamStore(storage: StorageFacetLike | undefined): {
  store: AgentTeamStore
  durable: boolean
} {
  return storage === undefined
    ? { store: new MemoryTeamStore(), durable: false }
    : { store: new StorageHubTeamStore(storage), durable: true }
}
