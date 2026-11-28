import type { ServerResponse } from 'node:http'
import type { SessionScope } from './session-scope.ts'
import { RoomError } from './role-room-model.ts'
import type { RoleRooms } from './role-rooms.ts'

export const handleRoleRoomRoute = async (sub: string, method: string, input: unknown, scope: SessionScope, rooms: RoleRooms | undefined, res: ServerResponse, rawUrl?: string): Promise<boolean> => {
  if (sub !== '/agents' && !sub.startsWith('/agents/') && sub !== '/rooms' && !sub.startsWith('/rooms/')) return false
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  if (!rooms) { json(501, { error: '角色协作未启用' }); return true }
  try {
    const params = new URL(rawUrl ?? sub, 'http://localhost').searchParams
    if (sub === '/agents' && method === 'GET') { json(200, { agents: rooms.listAgents(scope), identity: scope }); return true }
    if (sub === '/agents' && method === 'POST') { json(200, { agent: rooms.saveAgent(input, scope), identity: scope }); return true }
    const agentDelete = /^\/agents\/([A-Za-z0-9_-]{1,80})\/delete$/u.exec(sub)
    if (agentDelete && method === 'POST') { rooms.removeAgent(agentDelete[1]!, scope); json(200, { ok: true, identity: scope }); return true }
    if (sub === '/rooms' && method === 'GET') {
      const options = { ...(params.get('includeArchived') === 'true' ? { includeArchived: true } : {}), ...(params.has('q') ? { q: params.get('q')! } : {}) }
      json(200, { rooms: Object.keys(options).length ? rooms.list(scope, options) : rooms.list(scope), identity: scope }); return true
    }
    if (sub === '/rooms' && method === 'POST') { json(201, { room: rooms.create(input, scope), identity: scope }); return true }
    const match = /^\/rooms\/([A-Za-z0-9_-]{1,80})(?:\/(turns|stop|resume|release|delete|model|connect|appearance|metadata|continue|history|events|export|workflow))?$/u.exec(sub)
    if (!match) { json(404, { error: '角色协作路由不存在' }); return true }
    const [, id, action] = match
    if (method === 'GET' && !action) { json(200, { room: rooms.view(id!, scope), identity: scope }); return true }
    if (method === 'GET' && action === 'export') { json(200, { room: rooms.view(id!, scope), identity: scope }); return true }
    if (method === 'GET' && action === 'history') {
      json(200, { ...rooms.history(id!, scope, params.get('before') ?? undefined, params.has('limit') ? Number(params.get('limit')) : undefined), identity: scope }); return true
    }
    if (method === 'GET' && action === 'events') {
      const after = params.has('after') ? Number(params.get('after')) : undefined
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new RoomError('事件游标无效', 400)
      rooms.view(id!, scope)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      let timer: ReturnType<typeof setInterval> | undefined, unsubscribe: (() => void) | undefined, closed = false
      const close = () => { if (closed) return; closed = true; clearInterval(timer); unsubscribe?.(); res.end() }
      res.on('close', close)
      const write = (data: string) => { if (!closed && !res.write(data)) close() }
      unsubscribe = rooms.subscribe(id!, scope, after, event => {
        const payload = event.type === 'room.snapshot' ? { room: event.room, identity: scope } : { ...event.change, identity: scope }
        write(`id: ${event.revision}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`)
      })
      if (closed) unsubscribe()
      else { timer = setInterval(() => write(': heartbeat\n\n'), 15000); timer.unref?.() }
      return true
    }
    if (method !== 'POST' || !action) { json(405, { error: 'method not allowed' }); return true }
    if (action === 'history' || action === 'events' || action === 'export') { json(405, { error: 'method not allowed' }); return true }
    if (action === 'metadata') { json(200, { room: rooms.metadata(id!, input, scope), identity: scope }); return true }
    if (action === 'continue') { json(201, { room: rooms.continueTopic(id!, input, scope), identity: scope }); return true }
    if (action === 'appearance') { json(200, { room: rooms.setAppearance(id!, input, scope), identity: scope }); return true }
    if (action === 'workflow') { json(202, { room: await rooms.workflow(id!, input, scope), identity: scope }); return true }
    if (action === 'connect') {
      const value = input as { roleId?: unknown }
      if (typeof value?.roleId !== 'string') throw new RoomError('需要角色', 400)
      json(200, { room: await rooms.connectRole(id!, value.roleId, scope), identity: scope }); return true
    }
    if (action === 'model') {
      const value = input as { roleId?: unknown; modelId?: unknown }
      if (typeof value?.roleId !== 'string' || typeof value?.modelId !== 'string') throw new RoomError('需要角色与模型', 400)
      json(200, { room: await rooms.setModel(id!, value.roleId, value.modelId, scope), identity: scope }); return true
    }
    const room = action === 'turns' ? rooms.send(id!, input, scope) : action === 'stop' ? rooms.stop(id!, scope)
      : action === 'resume' ? await rooms.resume(id!, scope) : rooms.release(id!, scope, action === 'delete')
    json(action === 'turns' ? 202 : 200, { room, identity: scope })
  } catch (error) { json(error instanceof RoomError ? error.status : 422, { error: error instanceof Error ? error.message : String(error) }) }
  return true
}
