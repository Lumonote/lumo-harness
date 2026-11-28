import type { AgentSkills } from '../src/prompt-context.ts'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleAcpRoute } from '../src/routes.ts'
import type { EngineHost } from '../src/engine-host.ts'
import type { SessionAskBroker } from '../src/permission-asks.ts'
import type { RoleRooms } from '../src/role-rooms.ts'
const id = '12345678-1234-1234-1234-123456789abc'
const identity = { realm: 'r', userId: 'u', projectId: 'p' }
class Response extends EventEmitter {
  status = 0; data = ''
  writeHead(status: number) { this.status = status; return this }
  write(data: string) { this.data += data; return true }
  end(data = '') { this.data += data; this.emit('close'); return this }
}
function fixture(rooms?: Partial<RoleRooms>, skills?: AgentSkills) {
  const host = { delete: vi.fn(() => true), receipt: vi.fn(() => undefined), preparePrompt: vi.fn(() => ({ signal: new AbortController().signal, cancel: () => {}, release: () => undefined })), list: vi.fn(() => []), createSession: vi.fn(async () => ({ id, state: 'idle' })), get: vi.fn(() => ({ id, state: 'idle', cwd: '/tmp' })), resume: vi.fn(async () => ({ id, state: 'idle' })), setModel: vi.fn(async () => ({ id, state: 'idle' })), prompt: vi.fn(() => ({ ok: true })), cancel: vi.fn(() => ({ ok: true })), close: vi.fn(() => true), subscribe: vi.fn(() => () => undefined) }
  const asks = { list: vi.fn(() => []), answer: vi.fn(() => ({ ok: true })) }
  const call = async (path: string, method = 'POST', payload: unknown = {}) => {
    const req = Object.assign(new EventEmitter(), { method, headers: {}, url: `/lumo/api/acp${path}` }); const res = new Response()
    await handleAcpRoute(req as IncomingMessage, res as unknown as ServerResponse, `/lumo/api/acp${path}`, { host: host as unknown as EngineHost, asks: asks as unknown as SessionAskBroker, rooms: rooms as RoleRooms | undefined, skills, identity, readBody: async () => Buffer.from(JSON.stringify(payload)) })
    return res
  }
  return { host, asks, call }
}
describe('ACP trusted route scope', () => {
  it('lists and loads native skills using the owned session cwd, forwards real instructions and rejects unavailable skills', async () => {
    const skills = { list: vi.fn(async () => ({ complete: true, skills: [{ name: 'review', description: 'review' }] })), load: vi.fn(async () => '<skill_content>actual instructions</skill_content>') }
    const { host, call } = fixture(undefined, skills)
    const listing = await call(`/sessions/${id}/skills`, 'GET')
    expect(JSON.parse(listing.data).skills[0].name).toBe('review')
    expect(skills.list).toHaveBeenCalledWith('/tmp', expect.any(AbortSignal))
    expect((await call(`/sessions/${id}/prompt`, 'POST', { text: 'check', skills: ['review'], cwd: '/forged', projectId: 'forged' })).status).toBe(202)
    expect(skills.load).toHaveBeenCalledWith(['review'], '/tmp', expect.any(AbortSignal))
    expect(host.prompt).toHaveBeenCalledWith(id, identity, [{ type: 'text', text: 'check' }, { type: 'text', text: '<skill_content>actual instructions</skill_content>' }], { text: 'check', attachments: [], skills: ['review'] }, expect.objectContaining({ workspaceOwner: `session:${id}`, digest: expect.any(String) }))
    skills.load.mockRejectedValueOnce(new Error('Skill unavailable'))
    const rejected = await call(`/sessions/${id}/prompt`, 'POST', { text: '', skills: ['missing'] })
    expect(rejected.status).toBe(400); expect(rejected.data).toContain('Skill unavailable'); expect(host.prompt).toHaveBeenCalledTimes(1)
  })

  it('closes a model inspection before success and reports cleanup failure as one error response', async () => {
    const { host, call } = fixture()
    const result = await call('/engines/fake/models', 'POST', { cwd: '/tmp', ...identity, userId: 'spoofed' })
    expect(host.createSession).toHaveBeenCalledWith(expect.objectContaining({ ...identity, title: '读取模型目录' }), expect.any(AbortSignal))
    expect(host.delete).toHaveBeenCalledWith(id, identity); expect(host.prompt).not.toHaveBeenCalled()
    expect(JSON.parse(result.data)).toEqual({ models: null, identity })
    host.delete.mockImplementationOnce(() => { throw new Error('disk failed') })
    const failed = await call('/engines/fake/models', 'POST', { cwd: '/tmp' })
    expect(failed.status).toBe(422); expect(JSON.parse(failed.data).error).toContain('临时会话未能关闭')
  })
  it('permits viewing group members while blocking independent resume, model and prompt mutations', async () => {
    const owner = { id: 'team', name: 'Team', roles: [{ id: 'role', name: 'Member', sessionId: id }] }
    const sessionOwner = vi.fn(() => owner) as unknown as RoleRooms['sessionOwner']
    const { host, call } = fixture({ sessionOwner })
    const attached = await call(`/sessions/${id}/attach`)
    expect(attached.status).toBe(200); expect(JSON.parse(attached.data).session.room).toEqual({ id: 'team', name: 'Team', roleId: 'role', roleName: 'Member' })
    for (const action of ['resume', 'prompt', 'cancel', 'close', 'model']) expect((await call(`/sessions/${id}/${action}`, 'POST', { text: 'work', modelId: 'large' })).status).toBe(409)
    expect(host.resume).not.toHaveBeenCalled(); expect(host.prompt).not.toHaveBeenCalled(); expect(host.close).not.toHaveBeenCalled(); expect(host.setModel).not.toHaveBeenCalled()
  })
  it('blocks an independent prompt while its workspace is owned by an active group turn', async () => {
    const workspaceBusy = vi.fn(() => true), { host, call } = fixture({ sessionOwner: () => undefined, workspaceBusy })
    expect((await call(`/sessions/${id}/prompt`, 'POST', { text: 'work' })).status).toBe(409)
    expect(workspaceBusy).toHaveBeenCalledWith('/tmp'); expect(host.prompt).not.toHaveBeenCalled()
  })
  it('passes the trusted realm/user/project to list, attach, resume, prompt, cancel, close and events', async () => {
    const { host, call } = fixture()
    const listing = await call('/sessions', 'GET'); expect(host.list).toHaveBeenCalledWith(identity, ''); expect(JSON.parse(listing.data).identity).toEqual(identity)
    await call(`/sessions/${id}/attach`); expect(host.get).toHaveBeenCalledWith(id, identity)
    await call(`/sessions/${id}/resume`); expect(host.resume).toHaveBeenCalledWith(id, identity, expect.any(AbortSignal))
    await call(`/sessions/${id}/prompt`, 'POST', { text: 'go', realm: 'evil', userId: 'other', projectId: 'other' }); expect(host.prompt).toHaveBeenCalledWith(id, identity, 'go', { text: 'go', attachments: [] }, expect.objectContaining({ workspaceOwner: `session:${id}`, digest: expect.any(String) }))
    await call(`/sessions/${id}/cancel`); expect(host.cancel).toHaveBeenCalledWith(id, identity)
    await call(`/sessions/${id}/close`); expect(host.close).toHaveBeenCalledWith(id, identity)
    const events = await call(`/sessions/${id}/events`, 'GET'); expect(host.subscribe.mock.calls[0]?.slice(0, 3)).toEqual([id, identity, 0]); events.end()
  })
  it('creates under trusted scope, filters asks and binds answers to the same scope', async () => {
    const { host, asks, call } = fixture()
    await call('/sessions', 'POST', { engineId: 'fake', cwd: '/tmp', realm: 'evil', userId: 'other', projectId: 'other' })
    expect(host.createSession).toHaveBeenCalledWith(expect.objectContaining(identity), expect.any(AbortSignal))
    await call('/asks', 'GET'); expect(asks.list).toHaveBeenCalledWith(identity, {})
    await call('/asks/session:acp-example/answer', 'POST', { value: 'yes' }); expect(asks.answer).toHaveBeenCalledWith('session:acp-example', 'yes', identity)
  })
  it('does not mistake a POST to the events endpoint for a close operation', async () => {
    const { host, call } = fixture(); const res = await call(`/sessions/${id}/events`)
    expect(res.status).toBe(405); expect(host.close).not.toHaveBeenCalled()
  })
})
