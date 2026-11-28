import { agentProfile, scopedAgents, type AgentProfile } from './agent-directory.ts'
import { sameScope, type SessionScope } from './session-scope.ts'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ROOM_LIMITS, RoomError, roomConfig, turnInput, planRoomTurn, type RoleRoom, type RoomSummary, type StepState } from './role-room-model.ts'

const MAX_BYTES = 32 * 1024 * 1024
const states: StepState[] = ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted']
const validText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const roomMetadata = (raw: RoleRoom) => {
  if ((raw.archived !== undefined && typeof raw.archived !== 'boolean') || (raw.pinned !== undefined && typeof raw.pinned !== 'boolean')
    || (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 0))
    || (raw.updatedAt !== undefined && !Number.isFinite(Date.parse(raw.updatedAt)))) throw new Error('话题元数据无效')
  if (raw.handoff && (!/^[A-Za-z0-9_-]{1,80}$/u.test(raw.handoff.roomId) || !validText(raw.handoff.summary, ROOM_LIMITS.summary)
    || !raw.handoff.summary.trim() || !Number.isFinite(Date.parse(raw.handoff.createdAt)))) throw new Error('话题续接信息无效')
  return { ...(raw.archived !== undefined ? { archived: raw.archived } : {}), ...(raw.pinned !== undefined ? { pinned: raw.pinned } : {}),
    revision: raw.revision ?? 0, updatedAt: raw.updatedAt ?? raw.turns?.at(-1)?.createdAt ?? raw.createdAt,
    ...(raw.handoff ? { handoff: structuredClone(raw.handoff) } : {}) }
}
export const decodeRoom = (raw: RoleRoom): RoleRoom => {
  const config = roomConfig(raw)
  if (!isAbsolute(config.cwd) || !validText(raw.realm, 256) || !raw.realm || !validText(raw.userId, 256) || !raw.userId
    || (raw.projectId !== undefined && (!validText(raw.projectId, 256) || !raw.projectId))
    || !validText(raw.createdAt, 64) || !Number.isFinite(Date.parse(raw.createdAt)) || !Array.isArray(raw.turns) || raw.turns.length > ROOM_LIMITS.turns) throw new Error('角色协作记录无效')
  const room: RoleRoom = { ...config, realm: raw.realm, userId: raw.userId, ...(raw.projectId === undefined ? {} : { projectId: raw.projectId }), createdAt: raw.createdAt, turns: [], ...roomMetadata(raw) }
  room.roles.forEach((role, i) => {
    const id = raw.roles[i]?.sessionId
    if (id !== undefined) {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) throw new Error('角色会话标识无效')
      role.sessionId = id
    }
  })
  room.turns = raw.turns.map(t => {
    const input = turnInput(t), planned = planRoomTurn(room, input)
    if (!states.includes(t.state) || !validText(t.createdAt, 64) || !Number.isFinite(Date.parse(t.createdAt))
      || !Array.isArray(t.steps) || t.steps.length !== planned.length || (t.error !== undefined && !validText(t.error, 2000))) throw new Error('协作回合记录无效')
    const steps = t.steps.map((s, i) => {
      if (s.roleId !== planned[i]!.roleId || s.purpose !== planned[i]!.purpose || !states.includes(s.state)
        || !validText(s.text, ROOM_LIMITS.output) || (s.error !== undefined && !validText(s.error, 2000))) throw new Error('角色回复记录无效')
      return { ...planned[i]!, state: s.state, text: s.text, ...(s.truncated ? { truncated: true } : {}), ...(s.error ? { error: s.error } : {}) }
    })
    return { ...input, state: t.state, createdAt: t.createdAt, steps, ...(t.error ? { error: t.error } : {}) }
  })
  if (new Set(room.turns.map(t => t.id)).size !== room.turns.length) throw new Error('协作回合标识重复')
  return room
}

type RoomHeader = Omit<RoleRoom, 'turns'>
interface Entry { header: RoomHeader; preview: string; blob?: string }
const summarize = ({ header: r, preview }: Entry): RoomSummary => ({ id: r.id, name: r.name, cwd: r.cwd, busy: false,
  archived: r.archived ?? false, pinned: r.pinned ?? false, revision: r.revision ?? 0, updatedAt: r.updatedAt ?? r.createdAt,
  ...(r.appearance ? { appearance: structuredClone(r.appearance) } : {}), engineIds: r.roles.map(role => role.engineId), preview })
const entryOf = (room: RoleRoom, blob?: string): Entry => {
  const { turns, ...header } = room
  return { header, preview: turns.at(-1)?.text.slice(0, 120) ?? '', ...(blob ? { blob } : {}) }
}
function atomic(file: string, data: unknown): void {
  const body = JSON.stringify(data)
  if (Buffer.byteLength(body) > MAX_BYTES) throw new RoomError('协作记录已达存储上限')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temp, body, { mode: 0o600, flag: 'wx' }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}
function interrupted(room: RoleRoom): RoleRoom {
  for (const turn of room.turns) {
    if (turn.state !== 'running' && turn.state !== 'pending') continue
    turn.state = 'interrupted'; turn.error = '运行时已重启，请核对引擎执行结果；本轮不会自动重发。'
    turn.steps.forEach(s => { if (s.state === 'running' || s.state === 'pending') s.state = 'interrupted' })
  }
  return room
}

/** A compact index points to immutable per-topic snapshots; publishing the index commits all changes. */
export class RoleRoomStore {
  private agents: AgentProfile[] = []
  private entries = new Map<string, Entry>()
  private memory = new Map<string, RoleRoom>()
  constructor(private readonly file?: string) {
    if (!file) return
    try {
      if (statSync(file).size > MAX_BYTES) throw new Error('角色协作记录过大')
      const data = JSON.parse(readFileSync(file, 'utf8')) as { version: number; rooms: unknown[]; agents?: AgentProfile[] }
      if (![1, 2].includes(data.version) || !Array.isArray(data.rooms) || data.rooms.length > 10000) throw new Error('角色协作文件无效')
      if (data.agents !== undefined && (!Array.isArray(data.agents) || data.agents.length > 64)) throw new Error('Agent 通讯录无效')
      this.agents = (data.agents ?? []).map(a => {
        if (!validText(a.realm, 256) || !a.realm || !validText(a.userId, 256) || !a.userId || (a.projectId !== undefined && (!validText(a.projectId, 256) || !a.projectId))) throw new Error('Agent 身份无效')
        return agentProfile(a, { realm: a.realm, userId: a.userId, ...(a.projectId ? { projectId: a.projectId } : {}) })
      })
      if (new Set(this.agents.map(a => a.id)).size !== this.agents.length) throw new Error('Agent 标识重复')
      for (const value of data.rooms) {
        let entry: Entry
        if (data.version === 1) {
          const room = interrupted(decodeRoom(value as RoleRoom)); entry = entryOf(room); this.memory.set(room.id, room)
        } else {
          const raw = value as Entry
          if (!raw || typeof raw.blob !== 'string' || !/^[a-f0-9-]{36}\.json$/u.test(raw.blob) || !validText(raw.preview, 120)) throw new Error('话题索引无效')
          const { turns: _, ...header } = decodeRoom({ ...raw.header, turns: [] })
          entry = { header, preview: raw.preview, blob: raw.blob }
        }
        if (this.entries.has(entry.header.id)) throw new Error('协作房间标识重复')
        this.entries.set(entry.header.id, entry)
      }
      chmodSync(file, 0o600)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  listAgents(scope: SessionScope): AgentProfile[] { return structuredClone(scopedAgents(this.agents, scope)) }
  saveAgent(value: unknown, scope: SessionScope): AgentProfile {
    const agent = agentProfile(value, scope), previous = this.agents.find(p => p.id === agent.id)
    if (previous && !sameScope(previous, scope)) throw new RoomError('Agent 标识冲突')
    const next = [...this.agents.filter(p => p.id !== agent.id), agent]
    if (next.length > 64) throw new RoomError('Agent 通讯录已达 64 项上限')
    this.commit(new Map(this.entries), new Map(), next); return structuredClone(agent)
  }
  removeAgent(id: string, scope: SessionScope): void {
    if (!this.agents.some(a => a.id === id && sameScope(a, scope))) throw new RoomError('Agent 不存在', 404)
    this.commit(new Map(this.entries), new Map(), this.agents.filter(a => a.id !== id))
  }
  summaries(scope: SessionScope, options: { includeArchived?: boolean; q?: string } = {}): RoomSummary[] {
    const query = options.q?.trim().toLocaleLowerCase().slice(0, 200)
    return [...this.entries.values()].filter(e => sameScope(e.header, scope) && (options.includeArchived || !e.header.archived))
      .filter(e => !query || [e.header.name, e.preview].some(s => s.toLocaleLowerCase().includes(query))
        || this.get(e.header.id)?.turns.some(t => t.text.toLocaleLowerCase().includes(query) || t.steps.some(s => s.text.toLocaleLowerCase().includes(query))))
      .map(summarize).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }
  sessionOwner(id: string, scope: SessionScope): RoleRoom | undefined {
    const e = [...this.entries.values()].find(e => sameScope(e.header, scope) && e.header.roles.some(r => r.sessionId === id))
    return e && this.get(e.header.id)
  }
  list(): RoleRoom[] { return [...this.entries.keys()].map(id => this.get(id)!) }
  get(id: string): RoleRoom | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    const cached = this.memory.get(id)
    if (cached) return structuredClone(cached)
    if (!this.file || !entry.blob) throw new Error('话题正文缺失')
    const path = join(`${this.file}.rooms`, entry.blob)
    if (statSync(path).size > MAX_BYTES) throw new Error('话题正文过大')
    const room = interrupted(decodeRoom(JSON.parse(readFileSync(path, 'utf8')) as RoleRoom))
    if (room.id !== id || !sameScope(room, entry.header) || room.revision !== entry.header.revision) throw new Error('话题正文与索引不匹配')
    return room
  }
  put(room: RoleRoom): void { this.putMany([room]) }
  putMany(rooms: RoleRoom[]): void {
    const next = new Map(this.entries), changed = new Map<string, RoleRoom>()
    for (const room of rooms) { const copy = structuredClone(room); next.set(room.id, entryOf(copy)); changed.set(room.id, copy) }
    this.commit(next, changed)
  }
  remove(id: string): void { const next = new Map(this.entries); next.delete(id); this.commit(next, new Map()) }
  private commit(next: Map<string, Entry>, changed: Map<string, RoleRoom>, agents = this.agents): void {
    if (next.size > 10000) throw new RoomError('话题数量已达上限，请导出并删除不再需要的历史')
    const active = new Map<string, number>()
    for (const { header: r } of next.values()) if (!r.archived) {
      const key = JSON.stringify([r.realm, r.userId, r.projectId ?? null]), count = (active.get(key) ?? 0) + 1
      if (count > ROOM_LIMITS.rooms) throw new RoomError('活动话题已达上限，请先归档已结束的话题')
      active.set(key, count)
    }
    const pending: string[] = []
    if (this.file) {
      try {
        for (const [id, entry] of next) {
          if (!changed.has(id) && entry.blob) continue
          const room = changed.get(id) ?? this.memory.get(id)
          if (!room) throw new Error('话题正文缺失')
          const blob = `${randomUUID()}.json`, path = join(`${this.file}.rooms`, blob)
          atomic(path, room); pending.push(path); next.set(id, entryOf(room, blob))
        }
        atomic(this.file, { version: 2, rooms: [...next.values()], agents })
      } catch (error) { pending.forEach(path => rmSync(path, { force: true })); throw error }
      const retained = new Set([...next.values()].map(e => e.blob))
      // Failure to remove a superseded snapshot must not invalidate an already committed index.
      for (const entry of this.entries.values()) if (entry.blob && !retained.has(entry.blob)) {
        try { rmSync(join(`${this.file}.rooms`, entry.blob), { force: true }) } catch { /* Retry on later maintenance. */ }
      }
      this.memory.clear()
    } else {
      for (const [id, room] of changed) this.memory.set(id, room)
      for (const id of this.memory.keys()) if (!next.has(id)) this.memory.delete(id)
    }
    this.entries = next; this.agents = agents
  }
}
