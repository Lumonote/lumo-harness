import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACP_METHODS } from '../src/acp-protocol.ts'
import { EngineHost, type EngineHostOptions } from '../src/engine-host.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { EngineRegistry } from '../src/registry.ts'
import { SessionIndex } from '../src/session-index.ts'
const scope = { realm: 'r', userId: 'u', projectId: 'p' }
const dirs: string[] = []; const hosts: EngineHost[] = []
function fixture(extra: Partial<EngineHostOptions> = {}, support = true, load?: (rpc: JsonRpcConnection) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lifecycle-')); dirs.push(dir)
  const indexPath = join(dir, 'sessions.json')
  const calls: string[] = []; const connections: JsonRpcConnection[] = []; const closed = vi.fn()
  const asks = new SessionAskBroker(0)
  const registry = new EngineRegistry([{ id: 'fake', label: 'Fake', protocol: 'acp', provider: 'fake', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true })
  const options: EngineHostOptions = { registry, asks, recoveryIndexPath: indexPath, onSessionClosed: closed, connect: () => {
    const [client, server] = memoryTransportPair(); const rpc = new JsonRpcConnection(server); connections.push(rpc)
    rpc.onRequest(ACP_METHODS.initialize, () => { calls.push('init'); return { protocolVersion: 1, agentCapabilities: { loadSession: support } } })
    rpc.onRequest(ACP_METHODS.sessionNew, () => { calls.push('new'); return { sessionId: 'engine-session' } })
    rpc.onRequest(ACP_METHODS.sessionLoad, async () => { calls.push('load'); return load ? load(rpc) : {} })
    rpc.onRequest(ACP_METHODS.sessionPrompt, () => { calls.push('prompt'); return { stopReason: 'end_turn' } })
    return client
  }, ...extra }
  const create = () => { const host = new EngineHost(options); hosts.push(host); return host }
  return { host: create(), create, options, dir, indexPath, calls, closed, asks, connections }
}
afterEach(() => { hosts.splice(0).forEach(h => h.closeAll()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })

describe('ACP recovery lifecycle', () => {
  it('retains recent activity and the visible title after a restart without persisting expanded skill content', async () => {
    const f = fixture(), session = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir })
    expect(f.host.prompt(session.id, scope, [{ type: 'text', text: 'expanded private skill instructions' }], { text: '检查项目布局', attachments: [] })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.host.get(session.id, scope)?.state).toBe('idle'))
    const current = f.host.get(session.id, scope)!
    expect(current.title).toBe('检查项目布局'); expect(Date.parse(current.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(current.createdAt))
    f.host.closeAll()
    expect(f.create().list(scope)[0]).toMatchObject({ title: '检查项目布局', updatedAt: current.updatedAt, state: 'detached' })
    expect(readFileSync(f.indexPath, 'utf8')).not.toContain('expanded private skill instructions')
  })
  it('retains metadata on shutdown, explicitly loads with fresh MCP config, and keeps released history until explicit deletion', async () => {
    const mcpServers = vi.fn(async () => [{ name: 'new-token' }]); const f = fixture({ mcpServers })
    const session = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll()
    const next = f.create()
    expect(next.list(scope)).toEqual([expect.objectContaining({ id: session.id, state: 'detached' })])
    expect(f.calls).toEqual(['init', 'new'])
    const restored = await next.resume(session.id, scope)
    expect(restored).toMatchObject({ id: session.id, engineSessionId: session.engineSessionId, state: 'idle', historyOnly: false })
    expect(f.calls).toEqual(['init', 'new', 'init', 'load']); expect(mcpServers).toHaveBeenCalledTimes(2)
    expect(next.close(session.id, scope)).toBe(true); expect(f.create().list(scope)).toHaveLength(1)
    expect(next.delete(session.id, scope)).toBe(true); expect(f.create().list(scope)).toEqual([])
  })
  it.each([{ ...scope, realm: 'other' }, { ...scope, userId: 'other' }, { ...scope, projectId: 'other' }, { realm: 'r', userId: 'u' }])('rejects every operation outside %j', async other => {
    const f = fixture(); const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir })
    expect(f.host.list(other)).toEqual([]); expect(f.host.get(s.id, other)).toBeUndefined()
    expect(f.host.subscribe(s.id, other, 0, vi.fn())).toBeUndefined()
    expect(f.host.prompt(s.id, other, 'secret').ok).toBe(false); expect(f.host.cancel(s.id, other).ok).toBe(false)
    expect(f.host.close(s.id, other)).toBe(false); f.host.closeAll()
    await expect(f.host.resume(s.id, other)).rejects.toThrow('不存在'); expect(f.calls).toEqual(['init', 'new'])
    const ask = f.asks.request({ ...scope, lumoSessionId: s.id, engineId: 'fake' }, 'engine-session', { sessionId: 'engine-session', toolCall: { toolCallId: 't' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] })
    expect(f.asks.list(other)).toEqual([]); expect(f.asks.get(ask.ask.id, other)).toBeUndefined()
    expect(f.asks.answer(ask.ask.id, 'yes', other).ok).toBe(false); f.asks.cancelSession(s.id); await ask.response
  })
  it('MCP errors fail creation/loading, revoke credentials, and preserve saved retry entries', async () => {
    const mcpServers = vi.fn(async (): Promise<unknown[]> => { throw new Error('MCP denied') }); const f = fixture({ mcpServers })
    await expect(f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir })).rejects.toThrow('MCP denied')
    expect(f.host.list(scope)).toEqual([]); expect(f.calls).toEqual(['init']); expect(f.closed).toHaveBeenCalled()
    mcpServers.mockResolvedValue([])
    const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll()
    mcpServers.mockRejectedValue(new Error('fresh MCP denied'))
    await expect(f.host.resume(s.id, scope)).rejects.toThrow('fresh MCP denied')
    expect(f.host.list(scope)).toEqual([expect.objectContaining({ state: 'detached' })]); expect(f.calls).not.toContain('load')
    await expect(f.connections.at(-1)!.request('test')).rejects.toThrow('连接已关闭')
  })
  it('requires current loadSession support and never falls back to session/new', async () => {
    const f = fixture(); const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll()
    const unsupported = fixture({ recoveryIndexPath: f.indexPath }, false)
    await expect(unsupported.host.resume(s.id, scope)).rejects.toThrow('不支持恢复')
    expect(unsupported.calls).toEqual(['init']); expect(unsupported.host.list(scope)[0]?.state).toBe('detached')
  })
  it('cancels approval replay and drops historical notifications during restore', async () => {
    let result: unknown
    const f = fixture({}, true, async rpc => {
      rpc.notify(ACP_METHODS.sessionUpdate, { sessionId: 'engine-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old-history' } } })
      result = await rpc.request(ACP_METHODS.requestPermission, { sessionId: 'engine-session', toolCall: { toolCallId: 'old' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] }); return {}
    })
    const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll(); await f.host.resume(s.id, scope)
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } }); expect(f.asks.list(scope)).toEqual([])
    const listener = vi.fn(); f.host.subscribe(s.id, scope, 0, listener)?.()
    expect(listener.mock.calls.map(c => c[1].type)).toEqual(['session.started', 'session.closed', 'session.started'])
    expect(JSON.stringify(listener.mock.calls)).not.toContain('old-history')
  })
  it('reserves restore synchronously and revokes tokens generated after request cancellation', async () => {
    let release!: () => void
    const f = fixture({}, true, () => new Promise(resolve => { release = () => resolve({}) }))
    const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll()
    const pending = f.host.resume(s.id, scope); await expect(f.host.resume(s.id, scope)).rejects.toThrow('正在恢复')
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); release(); await pending
    expect(f.calls.filter(c => c === 'load')).toHaveLength(1)
    let tokenReady!: () => void
    f.options.mcpServers = () => new Promise(resolve => { tokenReady = () => resolve([]) })
    const controller = new AbortController(); const creating = f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }, controller.signal)
    await vi.waitFor(() => expect(tokenReady).toBeTypeOf('function')); controller.abort(); const revokes = f.closed.mock.calls.length
    tokenReady(); await expect(creating).rejects.toThrow('取消'); expect(f.closed.mock.calls.length).toBeGreaterThan(revokes)
    expect(f.host.list(scope)).toHaveLength(1)
  })
  it.each(['close', 'shutdown'] as const)('rejects restoration interrupted by %s and fences late load results', async mode => {
    let release!: () => void
    const f = fixture({}, true, () => new Promise(resolve => { release = () => resolve({}) }))
    const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll()
    const pending = f.host.resume(s.id, scope)
    const rejected = expect(pending).rejects.toThrow('连接已关闭')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    if (mode === 'close') f.host.close(s.id, scope); else f.host.closeAll()
    await rejected
    release(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.host.list(scope)).toHaveLength(1)
    if (mode === 'shutdown') {
      const newer = f.host.resume(s.id, scope)
      await vi.waitFor(() => expect(f.calls.filter(c => c === 'load')).toHaveLength(2))
      release(); await newer
      expect(f.host.get(s.id, scope)?.state).toBe('idle')
    }
  })
  it('blocks a new restore until old cancelled MCP generation has been revoked', async () => {
    const f = fixture(); const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir }); f.host.closeAll()
    let tokenReady!: () => void
    f.options.mcpServers = () => new Promise(resolve => { tokenReady = () => resolve([]) })
    const pending = f.host.resume(s.id, scope)
    await vi.waitFor(() => expect(tokenReady).toBeTypeOf('function')); f.host.closeAll()
    await expect(f.host.resume(s.id, scope)).rejects.toThrow('正在恢复')
    tokenReady(); await expect(pending).rejects.toThrow('取消')
    f.options.mcpServers = async () => []
    await f.host.resume(s.id, scope)
    const revokes = f.closed.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.closed.mock.calls).toHaveLength(revokes); expect(f.host.get(s.id, scope)?.state).toBe('idle')
  })
  it('fails creation and revokes tokens when metadata cannot be committed', async () => {
    const f = fixture(); mkdirSync(f.indexPath)
    await expect(f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir })).rejects.toThrow()
    expect(f.host.list(scope)).toEqual([]); expect(f.closed).toHaveBeenCalled()
    await expect(f.connections[0]!.request('test')).rejects.toThrow('连接已关闭')
  })
  it('retains live control when explicit deletion cannot commit index removal', async () => {
    const f = fixture(); const s = await f.host.createSession({ ...scope, engineId: 'fake', cwd: f.dir })
    rmSync(f.indexPath); mkdirSync(f.indexPath)
    expect(() => f.host.delete(s.id, scope)).toThrow(); expect(f.host.get(s.id, scope)?.state).toBe('idle')
  })
})
describe('metadata-only bounded index', () => {
  it('whitelists fields, sets private permissions and bounds entry count', () => {
    const f = fixture(); const index = new SessionIndex(f.indexPath)
    for (let i = 0; i < 130; i++) index.put({ ...scope, id: randomUUID(), engineId: 'fake', engineSessionId: `e-${i}`, cwd: f.dir, createdAt: new Date().toISOString(), secret: 'must-not-persist', prompt: 'private-prompt' } as Parameters<SessionIndex['put']>[0])
    const raw = readFileSync(f.indexPath, 'utf8')
    expect(raw).not.toContain('must-not-persist'); expect(raw).not.toContain('private-prompt')
    expect(statSync(f.indexPath).mode & 0o777).toBe(0o600); expect(new SessionIndex(f.indexPath).list()).toHaveLength(128)
  })
  it('rejects corrupt or oversized disk indexes', () => {
    const f = fixture(); writeFileSync(f.indexPath, JSON.stringify({ version: 2, sessions: [] }))
    expect(() => new SessionIndex(f.indexPath)).toThrow('格式无效'); writeFileSync(f.indexPath, 'x'.repeat(1024 * 1024 + 1))
    expect(() => new SessionIndex(f.indexPath)).toThrow('过大')
  })
})
