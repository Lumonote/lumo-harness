import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost } from '../src/engine-host.ts'
import { SqliteConversationStore } from '../src/sqlite-conversation-store.ts'
import { EngineRegistry } from '../src/registry.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { handleAcpRoute } from '../src/routes.ts'

const scope = { realm: 'review', userId: 'owner', projectId: 'project' }, cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'lumo-host-review-')), store = new SqliteConversationStore(join(cwd, 'history.sqlite'))
  const asks = new SessionAskBroker(0), peers: JsonRpcConnection[] = [], endings: Array<(result: unknown) => void> = []
  const host = new EngineHost({ asks, conversationStore: store, recoveryIndexPath: join(cwd, 'recovery.json'),
    registry: new EngineRegistry([{ id: 'review', label: 'Review', protocol: 'acp', provider: 'review', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true }),
    connect: () => {
      const [client, server] = memoryTransportPair(), peer = new JsonRpcConnection(server); peers.push(peer)
      peer.onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      peer.onRequest('session/new', () => ({ sessionId: 'engine' }))
      peer.onRequest('session/load', () => ({}))
      peer.onRequest('session/prompt', () => new Promise(resolve => endings.push(resolve)))
      return client
    },
  })
  cleanups.push(() => { store.close(); rmSync(cwd, { force: true, recursive: true }) }, () => host.closeAll())
  const create = () => host.createSession({ ...scope, engineId: 'review', cwd })
  const permission = (peer: JsonRpcConnection) => peer.request('session/request_permission', { sessionId: 'engine', toolCall: { toolCallId: 'late', title: 'Write file' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] }, 0)
  return { cwd, store, host, peers, endings, asks, create, permission }
}
describe('independent host reliability review', () => {
  it('does not create an idle-session approval after a journal acceptance rollback', async () => {
    const f = fixture(), session = await f.create()
    vi.spyOn(f.store, 'append').mockImplementationOnce(() => { throw new Error('temporary disk failure') })
    expect(f.host.prompt(session.id, scope, 'not accepted', undefined, { clientMessageId: 'failed' })).toMatchObject({ ok: false })
    expect(f.host.get(session.id, scope)?.state).toBe('idle')
    const outcome = f.permission(f.peers[0]!)
    void outcome.catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.asks.list(scope)).toHaveLength(0)
    await expect(outcome).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })
  it('keeps the workspace reserved until a running prompt has actually stopped', async () => {
    const f = fixture(), first = await f.create(), second = await f.create()
    f.host.prompt(first.id, scope, 'ongoing command')
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    try { f.host.release(first.id, scope) } catch { /* A refusal while running is a valid safe outcome. */ }
    expect(f.host.workspaceBusy(f.cwd)).toBe(true)
    expect(f.host.prompt(second.id, scope, 'conflicting command')).toMatchObject({ ok: false })
  })
  it('does not resurrect deleted history when a pending permission response settles afterwards', async () => {
    const f = fixture(), session = await f.create()
    f.host.prompt(session.id, scope, 'work')
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    const pending = f.permission(f.peers[0]!)
    void pending.catch(() => undefined)
    await vi.waitFor(() => expect(f.asks.list(scope)).toHaveLength(1))
    f.endings[0]!({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.state).toBe('idle'))
    expect(f.host.delete(session.id, scope)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.host.get(session.id, scope)).toBeUndefined()
    expect(f.store.get(session.id)).toBeUndefined()
  })
  it('recovers an output chunk after a transient append failure before releasing its process', async () => {
    const f = fixture(), session = await f.create(), append = f.store.append.bind(f.store)
    f.host.prompt(session.id, scope, 'work')
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    let failed = false
    vi.spyOn(f.store, 'append').mockImplementation((summary, events, receipt) => {
      if (!failed && events.some(e => e.event.type === 'message.chunk' && e.event.role === 'agent')) { failed = true; throw new Error('temporary output write failure') }
      append(summary, events, receipt)
    })
    f.peers[0]!.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'must survive' } } })
    await vi.waitFor(() => expect(failed).toBe(true))
    f.endings[0]!({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.state).toBe('idle'))
    f.host.release(session.id, scope)
    expect(f.host.history(session.id, scope)?.events.some(e => e.event.type === 'message.chunk' && e.event.text === 'must survive')).toBe(true)
  })
  it('publishes an authoritative detached snapshot after closing a live SSE stream', async () => {
    const f = fixture(), session = await f.create()
    class Response extends EventEmitter {
      chunks: string[] = []; ended = false
      writeHead() { return this }
      write(value: string) { this.chunks.push(value); return true }
      end() { this.ended = true; this.emit('close'); return this }
    }
    const url = `/lumo/api/acp/sessions/${session.id}/events`, res = new Response()
    await handleAcpRoute({ method: 'GET', url, headers: {} } as IncomingMessage, res as unknown as ServerResponse, url, { host: f.host, asks: f.asks, identity: scope, readBody: async () => Buffer.alloc(0) })
    f.host.release(session.id, scope)
    expect(res.ended).toBe(true)
    const hellos = res.chunks.filter(chunk => chunk.startsWith('event: hello')).map(chunk => JSON.parse(chunk.split('data: ')[1]!))
    expect(hellos[0].session.state).toBe('idle')
    expect(hellos.at(-1).session).toMatchObject({ state: 'detached', historyOnly: true })
  })
  it('withdraws pending approvals when their originating turn has already ended', async () => {
    const f = fixture(), session = await f.create()
    f.host.prompt(session.id, scope, 'work')
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    const pending = f.permission(f.peers[0]!); void pending.catch(() => undefined)
    await vi.waitFor(() => expect(f.asks.list(scope, { status: 'pending' })).toHaveLength(1))
    f.endings[0]!({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.state).toBe('idle'))
    expect(f.asks.list(scope, { status: 'pending' })).toHaveLength(0)
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })
  it('clears the storage failure marker after retrying a disconnected session pending journal', async () => {
    const f = fixture(), session = await f.create()
    f.host.prompt(session.id, scope, 'work')
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    const writing = vi.spyOn(f.store, 'append').mockImplementation(() => { throw new Error('disk temporarily unavailable') })
    f.peers[0]!.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pending output' } } })
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.storageError).toBeTruthy())
    f.peers[0]!.close()
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.historyOnly).toBe(true))
    writing.mockRestore(); f.host.release(session.id, scope)
    expect(f.host.history(session.id, scope)?.events.some(e => e.event.type === 'message.chunk' && e.event.text === 'pending output')).toBe(true)
    expect(f.host.get(session.id, scope)?.storageError).toBeUndefined()
    expect(f.host.get(session.id, scope)?.historyIncomplete).not.toBe(true)
  })
})
