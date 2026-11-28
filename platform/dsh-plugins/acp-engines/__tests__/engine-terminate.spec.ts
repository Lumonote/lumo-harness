import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost, type EngineHostOptions, type SessionEvent } from '../src/engine-host.ts'
import { SqliteConversationStore } from '../src/sqlite-conversation-store.ts'
import { EngineRegistry } from '../src/registry.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'

const scope = { realm: 'terminate', userId: 'owner', projectId: 'project' }
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks() })

function fixture(extra: { initialize?: () => unknown; mcpServers?: EngineHostOptions['mcpServers'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'lumo-terminate-'))
  const store = new SqliteConversationStore(join(cwd, 'history.sqlite')), asks = new SessionAskBroker(0)
  const peers: JsonRpcConnection[] = [], endings: Array<(result: unknown) => void> = []
  const closed = vi.fn(), recorded = vi.fn(), cancelled = vi.fn(), created = vi.fn(), loaded = vi.fn()
  const host = new EngineHost({
    asks, conversationStore: store, recoveryIndexPath: join(cwd, 'recovery.json'), onSessionClosed: closed,
    runTree: { apply: recorded }, ...(extra.mcpServers ? { mcpServers: extra.mcpServers } : {}),
    registry: new EngineRegistry([{ id: 'test', label: 'Test', protocol: 'acp', provider: 'test', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true }),
    connect: () => {
      const [client, server] = memoryTransportPair(), peer = new JsonRpcConnection(server); peers.push(peer)
      peer.onRequest('initialize', extra.initialize ?? (() => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } })))
      peer.onRequest('session/new', () => { created(); return { sessionId: 'engine' } })
      peer.onRequest('session/load', () => { loaded(); return {} })
      peer.onRequest('session/prompt', () => new Promise(resolve => endings.push(resolve)))
      peer.onNotification('session/cancel', cancelled)
      return client
    },
  })
  cleanups.push(() => { store.close(); rmSync(cwd, { recursive: true, force: true }) }, () => host.closeAll())
  const create = () => host.createSession({ ...scope, engineId: 'test', cwd })
  const permission = () => {
    const pending = peers[0]!.request('session/request_permission', {
      sessionId: 'engine', toolCall: { toolCallId: 'write', title: 'Write a file' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    }, 0)
    void pending.catch(() => undefined)
    return pending
  }
  return { cwd, store, asks, peers, endings, closed, recorded, cancelled, created, loaded, host, create, permission }
}

describe('explicit session termination', () => {
  it('closes an unresponsive turn, withdraws approval, retains its interrupted receipt and never replays it', async () => {
    const f = fixture(), session = await f.create(), other = await f.create(), events: SessionEvent[] = []
    f.host.subscribe(session.id, scope, 0, (_seq, event) => events.push(event))
    expect(f.host.prompt(session.id, scope, 'apply the change', undefined, { clientMessageId: 'once' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    f.peers[0]!.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'work in progress' } } })
    await vi.waitFor(() => expect(events.some(event => event.type === 'message.chunk' && event.role === 'agent')).toBe(true))
    expect(f.host.cancel(session.id, scope)).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.cancelled).toHaveBeenCalledOnce())
    expect(f.host.get(session.id, scope)?.state).toBe('running')
    expect(f.host.workspaceBusy(f.cwd)).toBe(true)

    const permission = f.permission()
    await vi.waitFor(() => expect(f.asks.list(scope, { status: 'pending' })).toHaveLength(1))
    expect(f.host.terminate(session.id, scope)).toBe(true)
    await expect(permission).rejects.toThrow('连接已关闭')
    expect(f.asks.list(scope, { status: 'pending' })).toHaveLength(0)
    expect(f.asks.list(scope)[0]?.status).toBe('cancelled')
    expect(f.peers[0]!.isClosed).toBe(true)
    expect(f.peers[1]!.isClosed).toBe(false)
    expect(f.host.get(other.id, scope)?.state).toBe('idle')
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
    expect(f.store.get(session.id)?.state).toBe('closed')
    expect(f.host.receipt(session.id, scope, 'once')?.status).toBe('interrupted')
    expect(f.host.get(session.id, scope)).toMatchObject({ state: 'detached', historyOnly: true })

    f.endings[0]!({ stopReason: 'end_turn' })
    expect(f.host.terminate(session.id, scope)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const history = f.host.history(session.id, scope)!.events.map(entry => entry.event)
    expect(history.filter(event => event.type === 'message.chunk').map(event => event.text)).toEqual(['apply the change', 'work in progress'])
    expect(history.filter(event => event.type === 'turn.ended')).toEqual([expect.objectContaining({ stopReason: 'error', error: expect.stringContaining('强制结束') })])
    expect(history.filter(event => event.type === 'session.closed')).toEqual([expect.objectContaining({ reason: 'terminated' })])
    expect(events.filter(event => event.type === 'session.closed')).toHaveLength(1)
    expect(f.recorded.mock.calls.filter(([event]) => event.type === 'node.upsert' && event.node.endedAt)).toHaveLength(1)
    expect(f.closed).toHaveBeenCalledTimes(1)

    await f.host.resume(session.id, scope)
    expect(f.loaded).toHaveBeenCalledTimes(1)
    expect(f.host.prompt(session.id, scope, 'apply the change', undefined, { clientMessageId: 'once' })).toMatchObject({ ok: true, duplicate: true, receipt: { status: 'interrupted' } })
    expect(f.endings).toHaveLength(1)
  })

  it.each([{ ...scope, realm: 'other' }, { ...scope, userId: 'other' }, { ...scope, projectId: 'other' }, { realm: scope.realm, userId: scope.userId }])('rejects termination outside the exact session scope %j', async other => {
    const f = fixture(), session = await f.create(), preparation = f.host.preparePrompt(session.id, scope)
    expect(f.host.terminate(session.id, other)).toBe(false)
    expect(f.host.terminate('missing', scope)).toBe(false)
    expect(preparation.signal.aborted).toBe(false)
    expect(f.host.workspaceBusy(f.cwd)).toBe(true)
    expect(f.peers[0]!.isClosed).toBe(false)
    expect(f.closed).not.toHaveBeenCalled()
    preparation.release()
  })

  it('aborts context preparation and releases its workspace without starting an engine turn', async () => {
    const f = fixture(), session = await f.create(), preparation = f.host.preparePrompt(session.id, scope)
    expect(f.host.terminate(session.id, scope)).toBe(true)
    expect(preparation.signal.aborted).toBe(true)
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
    expect(f.peers[0]!.isClosed).toBe(true)
    expect(f.endings).toHaveLength(0)
    const events = f.host.history(session.id, scope)!.events.map(entry => entry.event)
    expect(events.map(event => event.type)).toEqual(['session.started', 'session.closed'])
    preparation.release()
  })

  it('terminates initialization once and records a closed history entry that cannot be resumed', async () => {
    let initialize!: (value: unknown) => void
    const f = fixture({ initialize: () => new Promise(resolve => { initialize = resolve }) })
    const creating = f.create(), rejected = expect(creating).rejects.toThrow('连接已关闭')
    await vi.waitFor(() => expect(initialize).toBeTypeOf('function'))
    const session = f.host.list(scope)[0]!
    expect(session.state).toBe('starting')
    expect(f.host.terminate(session.id, scope)).toBe(true)
    await rejected
    initialize({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.host.get(session.id, scope)).toMatchObject({ state: 'closed', historyOnly: true })
    expect(f.host.history(session.id, scope)?.events.map(entry => entry.event.type)).toEqual(['session.closed'])
    expect(f.created).not.toHaveBeenCalled()
    expect(f.closed).toHaveBeenCalledTimes(1)
    expect(f.host.terminate(session.id, scope)).toBe(true)
    expect(f.closed).toHaveBeenCalledTimes(1)
    await expect(f.host.resume(session.id, scope)).rejects.toThrow('不存在')
  })

  it('revokes late MCP setup while retaining only one terminal event and no false resumability', async () => {
    let ready!: (value: unknown[]) => void
    const f = fixture({ mcpServers: () => new Promise(resolve => { ready = resolve }) })
    const creating = f.create(), rejected = expect(creating).rejects.toThrow('取消')
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'))
    const session = f.host.list(scope)[0]!
    expect(session.capabilities?.loadSession).toBe(true)
    expect(f.host.terminate(session.id, scope)).toBe(true)
    expect(f.closed).toHaveBeenCalledTimes(1)
    ready([]); await rejected
    // A second credential cleanup covers tokens created after termination; lifecycle events remain unique.
    expect(f.closed).toHaveBeenCalledTimes(2)
    expect(f.recorded.mock.calls.filter(([event]) => event.type === 'node.upsert' && event.node.endedAt)).toHaveLength(1)
    expect(f.host.history(session.id, scope)?.events.map(entry => entry.event.type)).toEqual(['session.closed'])
    expect(f.host.get(session.id, scope)?.state).toBe('closed')
    expect(f.created).not.toHaveBeenCalled()
    await expect(f.host.resume(session.id, scope)).rejects.toThrow('不存在')
  })

  it('still stops on a journal outage and allows an idempotent retry to persist all retained events', async () => {
    const f = fixture(), session = await f.create()
    f.host.prompt(session.id, scope, 'working', undefined, { clientMessageId: 'interrupted' })
    await vi.waitFor(() => expect(f.endings).toHaveLength(1))
    const writing = vi.spyOn(f.store, 'append').mockImplementation(() => { throw new Error('disk temporarily unavailable') })
    expect(f.host.terminate(session.id, scope)).toBe(true)
    expect(f.peers[0]!.isClosed).toBe(true)
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
    expect(f.host.get(session.id, scope)?.storageError).toBeTruthy()
    expect(f.host.history(session.id, scope)?.events.filter(entry => entry.event.type === 'session.closed')).toHaveLength(1)
    writing.mockRestore()
    expect(f.host.terminate(session.id, scope)).toBe(true)
    expect(f.host.get(session.id, scope)?.storageError).toBeUndefined()
    expect(f.host.receipt(session.id, scope, 'interrupted')?.status).toBe('interrupted')
    expect(f.host.history(session.id, scope)?.events.filter(entry => entry.event.type === 'session.closed')).toHaveLength(1)
    expect(f.closed).toHaveBeenCalledTimes(1)
  })
})
