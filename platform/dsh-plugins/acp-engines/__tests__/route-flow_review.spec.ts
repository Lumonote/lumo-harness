import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost, type SessionEvent, type SessionSummary } from '../src/engine-host.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { EngineRegistry } from '../src/registry.ts'
import { handleAcpRoute, type AcpRouteDeps } from '../src/routes.ts'
import { SqliteConversationStore } from '../src/sqlite-conversation-store.ts'

const scope = { realm: 'review', userId: 'owner', projectId: 'project' }
const id = '12345678-1234-1234-1234-123456789abc'
const summary: SessionSummary = { ...scope, id, engineId: 'review', engineSessionId: 'engine', cwd: '/tmp', state: 'idle', createdAt: '' }
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); vi.restoreAllMocks() })

class Response extends EventEmitter {
  status = 0; chunks: string[] = []; ends = 0
  constructor(readonly accepts: (chunk: string, count: number) => boolean = () => true) { super() }
  writeHead(status: number) { this.status = status; return this }
  write(chunk: string) { this.chunks.push(chunk); return this.accepts(chunk, this.chunks.length) }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.ends++; this.emit('close'); return this }
}
function route(host: EngineHost, res: Response, sessionId = id, action = 'events', input?: unknown, overrides: Partial<AcpRouteDeps> = {}, header?: string) {
  const pathname = `/lumo/api/acp/sessions/${sessionId}/${action}`
  return handleAcpRoute({ method: input === undefined ? 'GET' : 'POST', url: pathname, headers: header ? { 'last-event-id': header } : {} } as IncomingMessage,
    res as unknown as ServerResponse, pathname,
    { host, asks: new SessionAskBroker(0), identity: scope, readBody: async () => Buffer.from(JSON.stringify(input ?? {})), ...overrides })
}
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'lumo-route-review-')), store = new SqliteConversationStore(join(cwd, 'history.sqlite'))
  const asks = new SessionAskBroker(0), peers: JsonRpcConnection[] = [], prompts: unknown[] = [], endings: Array<(value: unknown) => void> = []
  const host = new EngineHost({ asks, conversationStore: store, recoveryIndexPath: join(cwd, 'recovery.json'),
    registry: new EngineRegistry([{ id: 'review', label: 'Review', protocol: 'acp', provider: 'review', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true }),
    connect: () => {
      const [client, server] = memoryTransportPair(), peer = new JsonRpcConnection(server); peers.push(peer)
      peer.onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      peer.onRequest('session/new', () => ({ sessionId: 'engine' }))
      peer.onRequest('session/prompt', params => { prompts.push(params); return new Promise(resolve => endings.push(resolve)) })
      return client
    },
  })
  cleanups.push(() => { store.close(); rmSync(cwd, { force: true, recursive: true }) }, () => host.closeAll())
  return { cwd, store, asks, peers, prompts, endings, host, create: () => host.createSession({ ...scope, engineId: 'review', cwd }) }
}
function delayedSkills() {
  let finish!: (text: string) => void
  const result = new Promise<string>(resolve => { finish = resolve })
  const load = vi.fn((_names: string[], _cwd: string, _signal?: AbortSignal) => result)
  return { load, finish, list: async () => ({ skills: [], complete: true }) }
}
const event = (seq: number): SessionEvent => ({ type: 'message.chunk', sessionId: id, role: 'agent', text: String(seq), at: '' })

describe('bounded session SSE output', () => {
  it.each(['reset', 'replay', 'hello'] as const)('ends and disposes a synchronous %s subscriber as soon as its output fills', async phase => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn(), cancel = vi.fn()
    const subscribe: EngineHost['subscribe'] = (_id, _scope, _after, listener, info) => {
      info?.({ session: summary, seq: 3, firstSeq: 1, ...(phase === 'reset' ? { reason: 'cursor_ahead', resetAfter: 0 } : {}) })
      for (const seq of [1, 2, 3]) listener(seq, event(seq))
      return unsubscribe
    }
    const res = new Response(chunk => !chunk.includes(`event: ${phase === 'replay' ? 'session' : phase}`))
    await route({ subscribe, cancel } as unknown as EngineHost, res)
    expect(res.ends).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(res.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(res.chunks).toHaveLength(phase === 'hello' ? 4 : 1)
    expect(cancel).not.toHaveBeenCalled()
  })
  it('unsubscribes a slow live client without cancelling its engine', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn(), cancel = vi.fn()
    let publish!: (seq: number, event: SessionEvent) => void
    const subscribe: EngineHost['subscribe'] = (_id, _scope, _after, listener, info) => { publish = listener; info?.({ session: summary, seq: 0, firstSeq: 1 }); return unsubscribe }
    const res = new Response(chunk => !chunk.includes('event: session'))
    await route({ subscribe, cancel } as unknown as EngineHost, res)
    expect(vi.getTimerCount()).toBe(1)
    publish(1, event(1)); publish(2, event(2))
    vi.advanceTimersByTime(50_000)
    expect(res.chunks).toHaveLength(2)
    expect(res.ends).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(cancel).not.toHaveBeenCalled()
  })
  it('stops its heartbeat when the heartbeat itself fills the response', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn(), res = new Response(chunk => !chunk.startsWith(': ping'))
    await route({ subscribe: () => unsubscribe } as unknown as EngineHost, res)
    vi.advanceTimersByTime(100_000)
    expect(res.chunks).toEqual([': ping\n\n'])
    expect(res.ends).toBe(1)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ends once if the authoritative closing snapshot fills the response', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    const subscribe: EngineHost['subscribe'] = (_id, _scope, _after, listener, info) => {
      info?.({ session: summary, seq: 1, firstSeq: 1 })
      listener(1, { type: 'session.closed', sessionId: id, reason: 'completed', at: '' })
      return unsubscribe
    }
    const res = new Response(chunk => !chunk.includes('event: hello'))
    await route({ subscribe } as unknown as EngineHost, res)
    expect(res.ends).toBe(1)
    expect(res.chunks).toHaveLength(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('closes an unavailable session even when the gone response fills the buffer', async () => {
    vi.useFakeTimers()
    const res = new Response(() => false)
    await route({ subscribe: () => undefined } as unknown as EngineHost, res)
    expect(res.chunks).toEqual(['event: gone\ndata: {}\n\n'])
    expect(res.ends).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('replays the durable journal after a slow client reconnects beyond released process memory', async () => {
    const f = fixture(), session = await f.create(), cancel = vi.spyOn(f.host, 'cancel')
    f.host.prompt(session.id, scope, 'work')
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1))
    f.peers[0]!.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'durable result' } } })
    f.endings[0]!({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.state).toBe('idle'))
    const slow = new Response((_chunk, count) => count < 2)
    await route(f.host, slow, session.id)
    expect(slow.ends).toBe(1)
    expect(cancel).not.toHaveBeenCalled()
    f.host.release(session.id, scope)
    const after = Number(/^id: (\d+)/u.exec(slow.chunks[0]!)![1])
    const reconnected = new Response()
    await route(f.host, reconnected, session.id, 'events', undefined, {}, String(after))
    const sequences = reconnected.chunks.filter(chunk => chunk.includes('event: session')).map(chunk => Number(/^id: (\d+)/u.exec(chunk)![1]))
    expect(sequences).toEqual(f.host.history(session.id, scope)!.events.filter(entry => entry.seq > after).map(entry => entry.seq))
    expect(reconnected.chunks.join('')).toContain('durable result')
    expect(reconnected.ends).toBe(1)
  })
})

describe('delayed Skill preparation cancellation', () => {
  it('cancels a loader that ignores its signal without creating a prompt or receipt when it resolves later', async () => {
    const f = fixture(), session = await f.create(), second = await f.create(), skills = delayedSkills(), response = new Response()
    const request = route(f.host, response, session.id, 'prompt', { text: 'work', skills: ['review'], clientMessageId: 'cancelled-skill' }, { skills })
    let settled = false
    void request.then(() => { settled = true })
    await vi.waitFor(() => expect(skills.load).toHaveBeenCalledOnce())
    expect(f.host.workspaceBusy(f.cwd)).toBe(true)
    expect(f.host.prompt(second.id, scope, 'conflict')).toMatchObject({ ok: false })
    const cancel = new Response()
    await route(f.host, cancel, session.id, 'cancel', {})
    expect(cancel.status).toBe(200)
    expect(skills.load.mock.calls[0]![2]!.aborted).toBe(true)
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 250 })
    expect(f.host.prompt(second.id, scope, 'next owner')).toMatchObject({ ok: true })
    skills.finish('ignored late result'); await request
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1))
    expect(f.host.workspaceBusy(f.cwd)).toBe(true)
    expect(f.host.get(session.id, scope)?.state).toBe('idle')
    expect(f.host.receipt(session.id, scope, 'cancelled-skill')).toBeUndefined()
    expect(f.host.history(session.id, scope)!.events.some(entry => entry.event.type === 'turn.started')).toBe(false)
    expect(response.status).toBe(400)
  })
  it.each([{ realm: 'other' }, { userId: 'other' }, { projectId: 'other' }])('keeps the owner preparation running after a foreign scope attempts cancellation: %j', async foreign => {
    const f = fixture(), session = await f.create(), skills = delayedSkills(), response = new Response()
    const request = route(f.host, response, session.id, 'prompt', { text: 'work', skills: ['review'], clientMessageId: 'owner-skill' }, { skills })
    await vi.waitFor(() => expect(skills.load).toHaveBeenCalledOnce())
    const rejected = new Response()
    await route(f.host, rejected, session.id, 'cancel', {}, { identity: { ...scope, ...foreign } })
    expect(rejected.status).toBe(409)
    expect(skills.load.mock.calls[0]![2]!.aborted).toBe(false)
    expect(f.host.workspaceBusy(f.cwd)).toBe(true)
    skills.finish('selected Skill'); await request
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1))
    expect(response.status).toBe(202)
    expect(f.host.receipt(session.id, scope, 'owner-skill')?.status).toBe('accepted')
  })
  it('never dispatches a late Skill result after its response disconnected', async () => {
    const f = fixture(), session = await f.create(), skills = delayedSkills(), response = new Response()
    const request = route(f.host, response, session.id, 'prompt', { text: 'work', skills: ['review'], clientMessageId: 'disconnected-skill' }, { skills })
    await vi.waitFor(() => expect(skills.load).toHaveBeenCalledOnce())
    response.emit('close')
    expect(skills.load.mock.calls[0]![2]!.aborted).toBe(true)
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
    skills.finish('ignored disconnected result'); await request
    expect(f.prompts).toHaveLength(0)
    expect(f.host.receipt(session.id, scope, 'disconnected-skill')).toBeUndefined()
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
  })
})
