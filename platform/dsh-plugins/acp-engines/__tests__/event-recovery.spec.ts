import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost } from '../src/engine-host.ts'
import { ACP_METHODS } from '../src/acp-protocol.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { EngineRegistry } from '../src/registry.ts'
import { handleAcpRoute } from '../src/routes.ts'

const id = '12345678-1234-1234-1234-123456789abc'
class Response extends EventEmitter {
  status = 0
  chunks: string[] = []
  ended = false
  writeHead(status: number) { this.status = status; return this }
  write(chunk: string) { this.chunks.push(chunk); return true }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.ended = true; this.emit('close'); return this }
}
async function stream(host: EngineHost, after: string, header?: string | string[]) {
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: `/lumo/api/acp/sessions/${id}/events?after=${after}`, headers: header === undefined ? {} : { 'last-event-id': header } })
  const res = new Response()
  await handleAcpRoute(req as IncomingMessage, res as unknown as ServerResponse, `/lumo/api/acp/sessions/${id}/events`, {
    host, asks: new SessionAskBroker(0), identity: { userId: 'u', realm: 'r' }, readBody: async () => Buffer.alloc(0),
  })
  return { req, res }
}
const session = { id, engineId: 'fake', engineSessionId: 'eng', cwd: '/tmp', userId: 'u', state: 'idle', createdAt: '' }
afterEach(() => vi.useRealTimers())

describe('ACP SSE reconnect', () => {
  it('Last-Event-ID takes priority over the original URL cursor', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_id, _user, _after, listener, info) => { info?.({ session, seq: 7, firstSeq: 1 }); listener(7, { type: 'turn.ended', sessionId: id, stopReason: 'end_turn', at: '' }); return unsubscribe })
    const { res } = await stream({ subscribe } as unknown as EngineHost, '1', '6')
    expect(subscribe.mock.calls[0]?.[2]).toBe(6)
    expect(res.chunks.join('')).toContain('event: hello')
    expect(res.chunks.join('')).toContain('id: 7\nevent: session')
    res.end()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it.each(['-1', '1.2', '1e2', '', 'NaN', '9007199254740992', ' 2'])('rejects invalid cursor %j before opening the stream', async cursor => {
    const subscribe = vi.fn()
    const { res } = await stream({ subscribe } as unknown as EngineHost, encodeURIComponent(cursor))
    expect(res.status).toBe(400)
    expect(subscribe).not.toHaveBeenCalled()
  })
  it('rejects an invalid header instead of falling back to the URL', async () => {
    const { res } = await stream({ subscribe: vi.fn() } as unknown as EngineHost, '1', 'nope')
    expect(res.status).toBe(400)
  })
  it('announces a gap before replaying the available tail and sends hello after it', async () => {
    const subscribe = vi.fn((_id, _user, _after, listener, info) => {
      info?.({ session, seq: 8, firstSeq: 7, resetAfter: 6, reason: 'buffer_truncated' })
      listener(7, { type: 'turn.started', sessionId: id, at: '' })
      listener(8, { type: 'turn.ended', sessionId: id, stopReason: 'end_turn', at: '' })
      return () => undefined
    })
    const { res } = await stream({ subscribe } as unknown as EngineHost, '1')
    const output = res.chunks.join('')
    expect(output).toContain('id: 6\nevent: reset')
    expect(output.indexOf('event: reset')).toBeLessThan(output.indexOf('id: 7'))
    expect(output.indexOf('event: hello')).toBeGreaterThan(output.indexOf('id: 8'))
    res.end()
  })
  it('cleans up when synchronous replay closes a session', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_id, _user, _after, listener) => {
      listener(2, { type: 'session.closed', sessionId: id, reason: 'completed', at: '' })
      return unsubscribe
    })
    const { res } = await stream({ subscribe } as unknown as EngineHost, '0')
    expect(res.ended).toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases the subscription and heartbeat on response disconnect', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    const { req, res } = await stream({ subscribe: () => unsubscribe } as unknown as EngineHost, '0')
    expect(vi.getTimerCount()).toBe(1)
    req.emit('close') // Request body completion must not terminate the response stream.
    expect(unsubscribe).not.toHaveBeenCalled()
    res.emit('close')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('EngineHost replay window', () => {
  it('reports truncated and future cursors while retaining ordered replay', async () => {
    const asks = new SessionAskBroker(0)
    const registry = new EngineRegistry([{ id: 'fake', label: 'Fake', protocol: 'acp', provider: 'fake', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true })
    let rpc!: JsonRpcConnection
    const host = new EngineHost({ registry, asks, eventBuffer: 2, connect: () => {
      const [client, server] = memoryTransportPair()
      rpc = new JsonRpcConnection(server)
      rpc.onRequest(ACP_METHODS.initialize, () => ({ protocolVersion: 1 }))
      rpc.onRequest(ACP_METHODS.sessionNew, () => ({ sessionId: 'eng' }))
      return client
    } })
    try {
      const created = await host.createSession({ engineId: 'fake', cwd: '/tmp', realm: 'r', userId: 'u' })
      for (const text of ['a', 'b', 'c']) rpc.notify(ACP_METHODS.sessionUpdate, { sessionId: 'eng', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
      await new Promise(resolve => setTimeout(resolve, 0))
      for (const [cursor, reason] of [[0, 'buffer_truncated'], [99, 'cursor_ahead']] as const) {
        const info = vi.fn(); const listener = vi.fn()
        host.subscribe(created.id, { realm: 'r', userId: 'u' }, cursor, listener, info)?.()
        expect(info).toHaveBeenCalledWith(expect.objectContaining({ seq: 4, firstSeq: 3, resetAfter: 2, reason }))
        expect(listener.mock.calls.map(call => call[0])).toEqual([3, 4])
      }
      const info = vi.fn(); const listener = vi.fn()
      host.subscribe(created.id, { realm: 'r', userId: 'u' }, 3, listener, info)?.()
      expect(info.mock.calls[0]?.[0]).not.toHaveProperty('reason')
      expect(listener.mock.calls.map(call => call[0])).toEqual([4])
      const denied = vi.fn()
      expect(host.subscribe(created.id, { realm: 'r', userId: 'other' }, 0, vi.fn(), denied)).toBeUndefined()
      expect(denied).not.toHaveBeenCalled()
    } finally { host.closeAll() }
  })
})
