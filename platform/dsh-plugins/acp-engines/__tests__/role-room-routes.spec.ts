import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleAcpRoute } from '../src/routes.ts'
import type { EngineHost } from '../src/engine-host.ts'
import type { SessionAskBroker } from '../src/permission-asks.ts'
import { RoomError } from '../src/role-room-model.ts'
import type { RoleRooms } from '../src/role-rooms.ts'

const identity = { realm: 'r', userId: 'u', projectId: 'p' }
class Response extends EventEmitter {
  status = 0; data = ''
  writeHead(status: number) { this.status = status; return this }
  write(data: string) { this.data += data; return true }
  end(data = '') { this.data += data; return this }
}
function fixture() {
  const rooms = { list: vi.fn(() => []), view: vi.fn(() => ({})), create: vi.fn(() => ({})), send: vi.fn(() => ({})), stop: vi.fn(() => ({})), resume: vi.fn(async () => ({})), release: vi.fn(() => ({})),
    setAppearance: vi.fn(() => ({})), listAgents: vi.fn(() => []), saveAgent: vi.fn(() => ({})), removeAgent: vi.fn(), connectRole: vi.fn(async () => ({})), setModel: vi.fn(async () => ({})),
    metadata: vi.fn(() => ({})), continueTopic: vi.fn(() => ({})), history: vi.fn(() => ({ turns: [], revision: 1 })), subscribe: vi.fn((_id, _scope, _after, listener) => { listener({ type: 'room.snapshot', revision: 1, room: { id: 'team' } }); return vi.fn() }) }
  const call = async (path: string, method = 'POST', payload: unknown = {}) => {
    const res = new Response(), req = { method, url: `/lumo/api/acp${path}`, headers: {} }
    await handleAcpRoute(req as IncomingMessage, res as unknown as ServerResponse, new URL(req.url, 'http://localhost').pathname, {
      host: {} as EngineHost, asks: {} as SessionAskBroker, rooms: rooms as unknown as RoleRooms, identity,
      readBody: async () => Buffer.from(JSON.stringify(payload)),
    })
    return res
  }
  return { rooms, call }
}
describe('role room BFF binding', () => {
  it('binds the agent directory and model operations to the trusted scope', async () => {
    const { rooms, call } = fixture(), profile = { id: 'agent', userId: 'spoofed', engineId: 'test' }
    await call('/agents', 'GET'); expect(rooms.listAgents).toHaveBeenCalledWith(identity)
    await call('/agents', 'POST', profile); expect(rooms.saveAgent).toHaveBeenCalledWith(profile, identity)
    await call('/agents/agent/delete'); expect(rooms.removeAgent).toHaveBeenCalledWith('agent', identity)
    await call('/rooms/team/appearance', 'POST', profile); expect(rooms.setAppearance).toHaveBeenCalledWith('team', profile, identity)
    await call('/rooms/team/connect', 'POST', { roleId: 'helper', ...profile }); expect(rooms.connectRole).toHaveBeenCalledWith('team', 'helper', identity)
    await call('/rooms/team/model', 'POST', { roleId: 'helper', modelId: 'large', ...profile }); expect(rooms.setModel).toHaveBeenCalledWith('team', 'helper', 'large', identity)
    expect((await call('/rooms/team/model', 'POST', {})).status).toBe(400)
    expect((await call('/agents/agent/delete', 'GET')).status).toBeGreaterThanOrEqual(400)
    expect(rooms.removeAgent).toHaveBeenCalledTimes(1)
  })
  it('uses trusted scope for creation, dispatch, reads and lifecycle actions', async () => {
    const { rooms, call } = fixture(), payload = { realm: 'evil', userId: 'other', projectId: 'other' }
    await call('/rooms', 'GET'); expect(rooms.list).toHaveBeenCalledWith(identity)
    await call('/rooms', 'POST', payload); expect(rooms.create).toHaveBeenCalledWith(payload, identity)
    await call('/rooms/team', 'GET'); expect(rooms.view).toHaveBeenCalledWith('team', identity)
    const response = await call('/rooms/team/turns', 'POST', payload)
    expect(response.status).toBe(202); expect(rooms.send).toHaveBeenCalledWith('team', payload, identity)
    await call('/rooms/team/stop'); expect(rooms.stop).toHaveBeenCalledWith('team', identity)
    await call('/rooms/team/resume'); expect(rooms.resume).toHaveBeenCalledWith('team', identity)
    await call('/rooms/team/release'); expect(rooms.release).toHaveBeenCalledWith('team', identity, false)
    await call('/rooms/team/delete'); expect(rooms.release).toHaveBeenCalledWith('team', identity, true)
  })
  it('never mutates on a read or malformed route and preserves conflict errors', async () => {
    const { rooms, call } = fixture()
    expect((await call('/rooms/team/delete', 'GET')).status).toBe(405)
    expect((await call('/rooms/team/anything')).status).toBe(404)
    expect(rooms.release).not.toHaveBeenCalled()
    rooms.send.mockImplementation(() => { throw new RoomError('消息标识冲突') })
    const response = await call('/rooms/team/turns'); expect(response.status).toBe(409); expect(response.data).toContain('消息标识冲突')
  })
  it('binds archived search, topic continuation, history pagination, export and stream cursors to the trusted scope', async () => {
    const { rooms, call } = fixture()
    await call('/rooms?includeArchived=true&q=evidence', 'GET')
    expect(rooms.list).toHaveBeenCalledWith(identity, { includeArchived: true, q: 'evidence' })
    const metadata = { name: 'Renamed', archived: true }, handoff = { id: 'next', summary: 'Evidence summary' }
    await call('/rooms/team/metadata', 'POST', metadata); expect(rooms.metadata).toHaveBeenCalledWith('team', metadata, identity)
    expect((await call('/rooms/team/continue', 'POST', handoff)).status).toBe(201)
    expect(rooms.continueTopic).toHaveBeenCalledWith('team', handoff, identity)
    await call('/rooms/team/history?before=t5&limit=3', 'GET'); expect(rooms.history).toHaveBeenCalledWith('team', identity, 't5', 3)
    expect((await call('/rooms/team/export', 'GET')).status).toBe(200)
    const stream = await call('/rooms/team/events?after=0', 'GET')
    expect(stream.status).toBe(200); expect(stream.data).toContain('event: room.snapshot'); expect(stream.data).toContain('id: 1')
    expect(rooms.subscribe).toHaveBeenCalledWith('team', identity, 0, expect.any(Function))
    stream.emit('close')
    expect((await call('/rooms/team/events?after=-1', 'GET')).status).toBe(400)
    expect((await call('/rooms/team/export', 'POST')).status).toBe(405)
  })
})
