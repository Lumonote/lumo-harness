import { randomUUID } from 'node:crypto'
import { RoomEvents, type RoomEvent } from './role-room-events.ts'
import type { AgentSkills } from './prompt-context.ts'
import { projectFileBlocks } from './project-files.ts'
import { AttachmentStore } from './attachment-store.ts'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { sameScope, type SessionScope } from './session-scope.ts'
import { ROOM_LIMITS, RoomError, roomConfig, roomAppearance, turnInput, planRoomTurn, roomPrompt, type RoleRoom, type RoomView, type RoomTurn, type RoomSummary } from './role-room-model.ts'
import { RoleRoomStore } from './role-room-store.ts'
import { runRoleTurn, type RoomEngine } from './role-room-turn.ts'

interface ActiveRoom { room: RoleRoom; controller: AbortController; busy: boolean; storageError?: string; releaseWorkspace?: () => void; progressTimer?: ReturnType<typeof setTimeout> }
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000)
const configOf = (r: RoleRoom) => roomConfig(r)
const workspace = (cwd: string) => { try { return realpathSync(cwd) } catch { return cwd } }

/** Coordination owns role metadata only; EngineHost remains the execution and permission authority. */
export class RoleRooms {
  private active = new Map<string, ActiveRoom>()
  private events = new RoomEvents()
  constructor(private readonly host: RoomEngine, private readonly store = new RoleRoomStore(), private readonly attachments = new AttachmentStore(), private readonly skills?: AgentSkills) {}
  listAgents(scope: SessionScope) { return this.store.listAgents(scope) }
  saveAgent(value: unknown, scope: SessionScope) { return this.store.saveAgent(value, scope) }
  removeAgent(id: string, scope: SessionScope) { this.store.removeAgent(id, scope) }
  sessionOwner(id: string, scope: SessionScope) { return [...this.active.values()].map(l => l.room).find(r => sameScope(r, scope) && r.roles.some(role => role.sessionId === id)) ?? this.store.sessionOwner(id, scope) }
  workspaceBusy(cwd: string) { return [...this.active.values()].some(l => l.busy && l.room.cwd === workspace(cwd)) }
  list(scope: SessionScope, options: { includeArchived?: boolean; q?: string } = {}): RoomSummary[] {
    return this.store.summaries(scope, options).map(r => ({ ...r, busy: this.active.get(r.id)?.busy ?? false }))
  }
  history(id: string, scope: SessionScope, before?: string, limit = 12) {
    const room = this.owned(id, scope)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ROOM_LIMITS.turns) throw new RoomError('历史分页大小无效', 400)
    const end = before ? room.turns.findIndex(t => t.id === before) : room.turns.length
    if (end < 0) throw new RoomError('历史游标不存在', 400)
    const start = Math.max(0, end - limit)
    return { turns: structuredClone(room.turns.slice(start, end)), revision: room.revision ?? 0, ...(start ? { nextCursor: room.turns[start]!.id } : {}) }
  }
  subscribe(id: string, scope: SessionScope, after: number | undefined, listener: (event: RoomEvent) => void) {
    return this.events.subscribe(this.view(id, scope), after, listener)
  }
  private sessionState(room: RoleRoom) {
    return { sessionModels: Object.fromEntries(room.roles.flatMap(r => {
      const models = r.sessionId ? this.host.get(r.sessionId, room)?.models : undefined
      return models ? [[r.id, models]] : []
    })), sessionStates: Object.fromEntries(room.roles.map(r => [r.id, r.sessionId ? this.host.get(r.sessionId, room)?.state ?? 'missing' : 'new'])) }
  }
  view(id: string, scope: SessionScope): RoomView {
    const room = this.owned(id, scope), live = this.active.get(id)
    return { ...structuredClone(room), ...this.sessionState(room), busy: live?.busy ?? false,
      ...(live?.storageError ? { error: `群组记录保存失败：${live.storageError}。请核对状态后重试操作。` } : {}) }
  }
  create(value: unknown, scope: SessionScope): RoomView {
    const config = roomConfig(value)
    if (!isAbsolute(config.cwd) || !statSync(config.cwd).isDirectory()) throw new RoomError('需要已有的工作区绝对路径', 400)
    config.cwd = realpathSync(config.cwd)
    const previous = this.store.get(config.id)
    if (previous) {
      if (!sameScope(previous, scope) || JSON.stringify(configOf(previous)) !== JSON.stringify(config)) throw new RoomError('房间标识冲突')
      return this.view(previous.id, scope)
    }
    const now = new Date().toISOString()
    this.store.put({ ...config, ...scope, turns: [], createdAt: now, updatedAt: now, revision: 1 })
    return this.view(config.id, scope)
  }
  setAppearance(id: string, value: unknown, scope: SessionScope): RoomView {
    const room = this.owned(id, scope); this.assertIdle(room)
    const next = { ...room, appearance: roomAppearance(value) }
    this.save(next, true)
    return this.view(id, scope)
  }
  metadata(id: string, value: unknown, scope: SessionScope): RoomView {
    const room = this.owned(id, scope); this.assertIdle(room)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomError('话题信息无效', 400)
    const input = value as { name?: unknown; archived?: unknown; pinned?: unknown }
    if ((input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80))
      || (input.archived !== undefined && typeof input.archived !== 'boolean') || (input.pinned !== undefined && typeof input.pinned !== 'boolean')) throw new RoomError('话题信息无效', 400)
    if (input.archived === true) this.releaseHandles(room, scope)
    const next = { ...room, ...(input.name !== undefined ? { name: (input.name as string).trim() } : {}),
      ...(input.archived !== undefined ? { archived: input.archived as boolean } : {}), ...(input.pinned !== undefined ? { pinned: input.pinned as boolean } : {}) }
    this.save(next, true); return this.view(id, scope)
  }
  continueTopic(id: string, value: unknown, scope: SessionScope): RoomView {
    const source = this.owned(id, scope); this.assertIdle(source)
    const input = value as { id?: unknown; name?: unknown; summary?: unknown } | null
    if (!input || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > ROOM_LIMITS.summary) throw new RoomError('续接摘要不能为空，最多 12000 字符', 400)
    const config = roomConfig({ ...source, id: input.id ?? randomUUID(), name: input.name ?? source.name })
    if (config.id === source.id) throw new RoomError('新话题需要不同标识', 400)
    const previous = this.store.get(config.id)
    if (previous) {
      if (!sameScope(previous, scope) || previous.handoff?.roomId !== id || previous.handoff.summary !== input.summary.trim()
        || JSON.stringify(configOf(previous)) !== JSON.stringify(config)) throw new RoomError('续接话题标识冲突')
      return this.view(previous.id, scope)
    }
    this.releaseHandles(source, scope)
    const now = new Date().toISOString(), next: RoleRoom = { ...config, ...scope, createdAt: now, updatedAt: now, revision: 1, turns: [],
      handoff: { roomId: id, summary: input.summary.trim(), createdAt: now } }
    source.archived = true; this.bump(source)
    this.store.putMany([source, next]); this.events.publish(this.view(id, scope), true)
    return this.view(next.id, scope)
  }
  send(id: string, value: unknown, scope: SessionScope): RoomView {
    const input = turnInput(value), room = this.owned(id, scope)
    const previous = room.turns.find(t => t.id === input.id)
    if (previous) {
      if (JSON.stringify(turnInput(previous)) !== JSON.stringify(input)) throw new RoomError('消息标识已用于不同内容')
      return this.view(id, scope)
    }
    if (input.attachments?.length) {
      try { input.attachments = this.attachments.resolve(input.attachments, scope) }
      catch (error) { throw new RoomError(message(error), 400) }
    }
    if (input.skills?.length && !this.skills) throw new RoomError('Skill 服务未启用', 400)
    try { projectFileBlocks(room.cwd, input.files ?? []) } catch (error) { throw new RoomError(message(error), 400) }
    this.assertIdle(room)
    if (room.archived) throw new RoomError('此话题已归档，请取消归档或继续新话题')
    if (this.host.list(scope).some(s => workspace(s.cwd) === room.cwd && (s.state === 'running' || s.state === 'starting'))) throw new RoomError('此工作区仍有引擎在执行，请等待停止确认或结束对应会话')
    if (room.turns.length >= ROOM_LIMITS.turns) throw new RoomError('此房间已达到 24 轮上限，请使用摘要继续新话题')
    const steps = planRoomTurn(room, input)
    for (const step of steps) {
      const role = room.roles.find(r => r.id === step.roleId)!
      if (!this.host.probeStatic().some(e => e.id === role.engineId && e.available)) throw new RoomError(`「${role.name}」的引擎不可用`)
      if (role.sessionId && !['idle', 'detached'].includes(this.host.get(role.sessionId, scope)?.state ?? 'missing')) throw new RoomError(`「${role.name}」需要恢复或释放会话后再继续`)
    }
    const requiredRoles = room.roles.filter(r => steps.some(step => step.roleId === r.id))
    const reserve = this.host.reserveWorkspace?.(room.cwd, `room:${id}`)
    let live: ActiveRoom
    try {
      this.capacity(requiredRoles, scope)
      this.attachments.retain(`room:${id}:turn:${input.id}`, input.attachments ?? [], scope)
      const turn: RoomTurn = { ...input, state: 'running', steps, createdAt: new Date().toISOString() }
      room.turns.push(turn); this.bump(room); this.store.put(room)
      live = { room, controller: new AbortController(), busy: true, ...(reserve ? { releaseWorkspace: reserve } : {}) }; this.active.set(id, live)
    } catch (error) { reserve?.(); try { this.attachments.releaseOwner(`room:${id}:turn:${input.id}`, scope) } catch { /* Preserve the original acceptance error. */ } throw error }
    const turn = room.turns.at(-1)!
    this.events.publish(this.view(id, scope))
    void this.execute(live, turn)
    return this.view(id, scope)
  }
  async connectRole(id: string, roleId: string, scope: SessionScope): Promise<RoomView> {
    const room = this.owned(id, scope); this.assertIdle(room)
    const role = room.roles.find(r => r.id === roleId)
    if (!role) throw new RoomError('角色不存在', 404)
    this.capacity([role], scope)
    const live: ActiveRoom = { room, controller: new AbortController(), busy: true }; this.active.set(id, live)
    try {
      if (role.sessionId) {
        if (this.host.get(role.sessionId, scope)?.state === 'detached') await this.host.resume(role.sessionId, scope, live.controller.signal)
        else if (!this.host.get(role.sessionId, scope)) throw new RoomError('会话已失效，请结束角色会话后重连')
      } else {
        const session = await this.host.createSession({ realm: room.realm, userId: room.userId, ...(room.projectId ? { projectId: room.projectId } : {}), cwd: room.cwd, engineId: role.engineId, ...(role.modelId ? { modelId: role.modelId } : {}), title: `${room.name} · ${role.name}` }, live.controller.signal)
        role.sessionId = session.id
        this.persist(live)
      }
      if (role.modelId) await this.host.setModel(role.sessionId!, scope, role.modelId)
    } finally { this.finishActivity(live) }
    return this.view(id, scope)
  }
  async setModel(id: string, roleId: string, modelId: string, scope: SessionScope): Promise<RoomView> {
    const room = this.owned(id, scope); this.assertIdle(room)
    const role = room.roles.find(r => r.id === roleId)
    if (!role?.sessionId) throw new RoomError('请先连接此角色的会话')
    const live: ActiveRoom = { room, controller: new AbortController(), busy: true }; this.active.set(id, live)
    try {
      await this.host.setModel(role.sessionId, scope, modelId)
    } finally {
      // The engine may have accepted the change even if its recovery-index write failed.
      const current = this.host.get(role.sessionId, scope)?.modelId
      if (current) role.modelId = current
      try { this.persist(live) } finally { this.finishActivity(live) }
    }
    return this.view(id, scope)
  }
  stop(id: string, scope: SessionScope): RoomView {
    this.owned(id, scope); this.active.get(id)?.controller.abort(); return this.view(id, scope)
  }
  async resume(id: string, scope: SessionScope): Promise<RoomView> {
    const room = this.owned(id, scope); this.assertIdle(room)
    this.capacity(room.roles.filter(r => r.sessionId), scope)
    const live: ActiveRoom = { room, controller: new AbortController(), busy: true }; this.active.set(id, live)
    try {
      for (const role of room.roles) {
        if (live.controller.signal.aborted) throw new RoomError('恢复已停止')
        if (role.sessionId && this.host.get(role.sessionId, scope)?.state === 'detached') {
          await this.host.resume(role.sessionId, scope, live.controller.signal)
          if (role.modelId) await this.host.setModel(role.sessionId, scope, role.modelId)
        }
      }
    } finally { this.finishActivity(live) }
    return this.view(id, scope)
  }
  release(id: string, scope: SessionScope, remove = false): RoomView | { ok: true } {
    const room = this.owned(id, scope); this.assertIdle(room)
    this.releaseHandles(room, scope, remove)
    if (remove) {
      this.store.remove(id); this.attachments.releaseOwner(`room:${id}`, scope)
      for (const turn of room.turns) this.attachments.releaseOwner(`room:${id}:turn:${turn.id}`, scope)
      this.active.delete(id); this.events.remove(id)
      return { ok: true }
    }
    this.active.delete(id); this.save(room, true); return this.view(id, scope)
  }
  private releaseHandles(room: RoleRoom, scope: SessionScope, remove = false): void {
    // Commit each handle so a failed release leaves the remaining controls recoverable.
    for (const role of room.roles) {
      if (!role.sessionId) continue
      const sessionId = role.sessionId
      if (remove && this.host.delete) { this.host.delete(sessionId, scope); this.attachments.releaseOwner(`session:${sessionId}`, scope) }
      else if (this.host.release) this.host.release(sessionId, scope)
      else this.host.close(sessionId, scope)
      if (remove || this.host.get(sessionId, scope)?.state !== 'detached') delete role.sessionId
      this.store.put(room)
    }
  }
  private capacity(roles: RoleRoom['roles'], scope: SessionScope): void {
    const count = roles.filter(r => !r.sessionId || this.host.get(r.sessionId, scope)?.state === 'detached').length
    this.host.ensureCapacity?.(count, scope, roles.flatMap(r => r.sessionId ? [r.sessionId] : []))
  }
  private bump(room: RoleRoom): void { room.revision = (room.revision ?? 0) + 1; room.updatedAt = new Date().toISOString() }
  private notify(room: RoleRoom, refresh = false): void {
    const live = this.active.get(room.id), last = room.turns.at(-1)
    this.events.publish({ ...room, turns: last ? [structuredClone(last)] : [], ...this.sessionState(room), busy: live?.busy ?? false,
      ...(live?.storageError ? { error: `群组记录保存失败：${live.storageError}` } : {}) }, refresh)
  }
  private finishActivity(live: ActiveRoom): void {
    live.busy = false
    this.bump(live.room)
    if (!live.storageError) {
      try { this.store.put(live.room); this.active.delete(live.room.id) }
      catch (error) { live.storageError = message(error); throw error }
      finally { this.notify(live.room, true) }
    } else this.notify(live.room, true)
  }
  private save(room: RoleRoom, refresh = false): void { this.bump(room); this.store.put(room); this.notify(room, refresh) }
  dispose(): void { for (const live of this.active.values()) live.controller.abort() }
  private owned(id: string, scope: SessionScope): RoleRoom {
    const room = this.active.get(id)?.room ?? this.store.get(id)
    if (!room || !sameScope(room, scope)) throw new RoomError('协作房间不存在', 404)
    return room
  }
  private assertIdle(room: RoleRoom): void {
    if (this.active.get(room.id)?.busy) throw new RoomError('此房间正在协作，请先停止或等待完成')
    if ([...this.active.values()].some(l => l.busy && l.room.cwd === room.cwd)) throw new RoomError('此工作区已有协作回合，请等待完成')
    if (this.host.workspaceBusy?.(room.cwd, `room:${room.id}`)) throw new RoomError('此工作区仍有引擎在执行，请等待停止确认或结束对应会话')
    const live = this.active.get(room.id)
    if (live?.storageError) { this.store.put(live.room); this.active.delete(room.id) }
  }
  private persist(live: ActiveRoom): void {
    try { this.bump(live.room); this.store.put(live.room); delete live.storageError; this.notify(live.room, true) }
    catch (error) { live.storageError = message(error); throw error }
  }
  private async execute(live: ActiveRoom, turn: RoomTurn): Promise<void> {
    const { room, controller } = live
    try {
      const skillText = turn.skills?.length ? await this.skills!.load(turn.skills, room.cwd, controller.signal) : ''
      const fileBlocks = projectFileBlocks(room.cwd, turn.files ?? [])
      // Connect every planned member before the first prompt so capacity/setup errors cannot dispatch a partial relay.
      for (const step of turn.steps) {
        if (controller.signal.aborted) throw new RoomError('协作已停止')
        const role = room.roles.find(r => r.id === step.roleId)!
        if (!role.sessionId) {
          const session = await this.host.createSession({ realm: room.realm, userId: room.userId, ...(room.projectId ? { projectId: room.projectId } : {}), cwd: room.cwd, engineId: role.engineId, ...(role.modelId ? { modelId: role.modelId } : {}), title: `${room.name} · ${role.name}` }, controller.signal)
          role.sessionId = session.id
          this.persist(live)
        }
        if (this.host.get(role.sessionId, room)?.state === 'detached') await this.host.resume(role.sessionId, room, controller.signal)
        if (controller.signal.aborted) throw new RoomError('协作已停止')
        if (role.modelId) await this.host.setModel(role.sessionId, room, role.modelId)
      }
      for (const step of turn.steps) {
        const role = room.roles.find(r => r.id === step.roleId)!
        if (controller.signal.aborted) throw new RoomError('协作已停止')
        step.state = 'running'; this.save(room)
        let prompt = this.attachments.prompt(roomPrompt(room, turn, step), turn.attachments ?? [], room, this.host.get(role.sessionId!, room)?.capabilities)
        if (skillText || fileBlocks.length) prompt = [...(typeof prompt === 'string' ? [{ type: 'text' as const, text: prompt }] : prompt), ...(skillText ? [{ type: 'text' as const, text: skillText }] : []), ...fileBlocks]
        this.attachments.retain(`session:${role.sessionId!}`, turn.attachments ?? [], room)
        await runRoleTurn(this.host, role.sessionId!, room, prompt, controller.signal, (text, truncated) => {
          step.text = text; step.truncated = truncated
          if (!live.progressTimer) live.progressTimer = setTimeout(() => { delete live.progressTimer; this.bump(room); this.notify(room) }, 50)
        }, undefined,
          turn.attachments?.length || skillText || fileBlocks.length ? { text: turn.text, attachments: turn.attachments ?? [], ...(turn.skills ? { skills: turn.skills } : {}), ...(turn.files ? { files: turn.files } : {}) } : undefined, `room:${room.id}`)
        step.state = 'completed'; this.save(room)
      }
      turn.state = 'completed'
    } catch (error) {
      turn.state = controller.signal.aborted ? 'cancelled' : 'failed'; turn.error = message(error)
      for (const step of turn.steps) {
        if (step.state === 'running') { step.state = turn.state; step.error = turn.error }
        else if (step.state === 'pending') step.state = 'cancelled'
      }
    } finally {
      clearTimeout(live.progressTimer); live.busy = false; live.releaseWorkspace?.()
      try { this.save(room); this.active.delete(room.id) }
      catch (error) { live.storageError = message(error); turn.state = 'interrupted'; turn.error = `协作记录写入失败：${live.storageError}。请核对引擎结果，不要重复发送。`; this.bump(room); this.notify(room) }
    }
  }
}
