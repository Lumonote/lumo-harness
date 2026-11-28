import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost, type EngineHostOptions } from '../src/engine-host.ts'
import { SqliteConversationStore } from '../src/sqlite-conversation-store.ts'
import { EngineRegistry } from '../src/registry.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { handleAcpRoute } from '../src/routes.ts'
import { handleConversationRoute } from '../src/conversation-routes.ts'
const scope = { realm: 'realm', userId: 'user', projectId: 'project' }
const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()))
function setup(overrides: Partial<EngineHostOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'lumo-journal-'))
  const asks = new SessionAskBroker(0), prompts = vi.fn(), peers: JsonRpcConnection[] = [], resolveTurns: Array<(value: unknown) => void> = []
  const options: EngineHostOptions = { asks, recoveryIndexPath: join(cwd, 'recovery.json'), eventBuffer: 3,
    registry: new EngineRegistry([{ id: 'test', label: 'Test', provider: 'test', protocol: 'acp', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true }),
    connect: () => {
      const [client, server] = memoryTransportPair(), peer = new JsonRpcConnection(server); peers.push(peer)
      peer.onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      peer.onRequest('session/new', () => {
        peer.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compress' }] } })
        return { sessionId: 'engine', modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }] } }
      })
      peer.onRequest('session/load', () => ({}))
      peer.onRequest('session/set_mode', () => ({}))
      peer.onRequest('session/prompt', params => { prompts(params); return new Promise(resolve => resolveTurns.push(resolve)) })
      return client
    }, ...overrides }
  const host = new EngineHost(options)
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }), () => host.closeAll())
  const create = () => host.createSession({ ...scope, engineId: 'test', cwd })
  const end = async () => { resolveTurns.shift()!({ stopReason: 'end_turn' }); await new Promise(resolve => setTimeout(resolve, 0)) }
  return { host, options, cwd, asks, prompts, peers, create, end }
}
describe('Durable conversation execution', () => {
  it('lets a scoped caller check acceptance after a lost response without dispatching again', async () => {
    const f = setup(), session = await f.create()
    f.host.prompt(session.id, scope, 'one execution', undefined, { clientMessageId: 'lost-response' })
    const query = (identity = scope, messageId = 'lost-response') => {
      const response = { status: 0, data: '', writeHead(status: number) { this.status = status }, end(data: string) { this.data = data } }
      const path = `/sessions/${session.id}/receipt`, url = new URL(`http://local${path}?clientMessageId=${messageId}`)
      handleConversationRoute(path, 'GET', {}, identity, f.host, response as unknown as ServerResponse, url)
      return response
    }
    expect(JSON.parse(query().data).receipt.status).toBe('accepted')
    expect(query({ ...scope, userId: 'another' }).status).toBe(404)
    expect(JSON.parse(query(scope, 'never-sent').data)).toEqual({ receipt: null })
    await vi.waitFor(() => expect(f.prompts).toHaveBeenCalledOnce()); await f.end()
    expect(JSON.parse(query().data).receipt.status).toBe('completed')
  })
  it('retains searchable paged history and metadata across release and restart without replaying prompts', async () => {
    const f = setup(), s = await f.create()
    expect(f.host.prompt(s.id, scope, '中文消息', { text: '中文消息', attachments: [] }, { clientMessageId: 'one' })).toEqual({ ok: true })
    await vi.waitFor(() => expect(f.prompts).toHaveBeenCalledOnce()); await f.end()
    f.host.metadata(s.id, scope, { title: '保存的对话', pinned: true, archived: true }); f.host.release(s.id, scope)
    const restored = new EngineHost(f.options); cleanups.push(() => restored.closeAll())
    expect(restored.get(s.id, scope)).toMatchObject({ historyOnly: true, pinned: true, archived: true, title: '保存的对话' })
    const tail = restored.history(s.id, scope, undefined, 2)!
    expect(tail.events).toHaveLength(2); expect(tail.hasMore).toBe(true)
    expect(restored.history(s.id, scope, tail.before, 2)!.events.at(-1)!.seq).toBeLessThan(tail.events[0]!.seq)
    expect(restored.list(scope, '中文消息')).toHaveLength(1)
    expect(restored.history(s.id, { ...scope, userId: 'other' })).toBeUndefined()
    const beforeSeq = tail.seq
    await restored.resume(s.id, scope)
    expect(restored.history(s.id, scope)!.seq).toBeGreaterThan(beforeSeq)
    expect(f.prompts).toHaveBeenCalledOnce()
    expect(restored.delete(s.id, scope)).toBe(true); expect(new EngineHost(f.options).list(scope)).toEqual([])
  })
  it('deduplicates accepted and finished messages, rejecting reuse with different content', async () => {
    const f = setup(), s = await f.create(), options = { clientMessageId: 'same-message' }
    expect(f.host.prompt(s.id, scope, 'once', undefined, options).ok).toBe(true)
    expect(f.host.prompt(s.id, scope, 'once', undefined, options)).toMatchObject({ ok: true, duplicate: true, receipt: { status: 'accepted' } })
    expect(f.host.prompt(s.id, scope, 'changed', undefined, options)).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(f.prompts).toHaveBeenCalledOnce()); await f.end()
    expect(f.host.prompt(s.id, scope, 'once', undefined, options)).toMatchObject({ ok: true, duplicate: true, receipt: { status: 'completed' } })
    expect(f.host.history(s.id, scope)!.events.filter(e => e.event.type === 'message.chunk' && e.event.role === 'user')).toHaveLength(1)
  })
  it('creates a durable cross-engine branch once and carries only the visible handoff into its next turn', async () => {
    const f = setup(), s = await f.create()
    const input = { summary: 'Reviewed a.ts; implement the approved change.', title: 'Next task', clientRequestId: 'branch-one' }
    const [first, duplicate] = await Promise.all([f.host.continue(s.id, scope, input), f.host.continue(s.id, scope, input)])
    expect(first.id).toBe(duplicate.id); expect(first.handoff?.summary).toBe(input.summary); expect(f.prompts).not.toHaveBeenCalled()
    f.host.prompt(first.id, scope, 'Continue', undefined, { clientMessageId: 'next' })
    await vi.waitFor(() => expect(f.prompts).toHaveBeenCalledOnce())
    expect(JSON.stringify(f.prompts.mock.calls[0])).toContain(input.summary)
    expect(f.host.history(first.id, scope)!.events.filter(e => e.event.type === 'message.chunk').map(e => e.event)).toEqual([expect.objectContaining({ text: 'Continue' })])
    await f.end(); f.host.release(first.id, scope)
    const restarted = new EngineHost(f.options); cleanups.push(() => restarted.closeAll())
    expect((await restarted.continue(s.id, scope, input)).id).toBe(first.id)
    await expect(restarted.continue(s.id, scope, { ...input, summary: 'different' })).rejects.toThrow('不同内容')
  })
  it('does not dispatch when atomic journal acceptance fails', async () => {
    const store = new SqliteConversationStore(), f = setup({ conversationStore: store }), s = await f.create()
    vi.spyOn(store, 'append').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(f.host.prompt(s.id, scope, 'must not execute', undefined, { clientMessageId: 'failed' })).toMatchObject({ ok: false, error: expect.stringContaining('disk full') })
    expect(f.prompts).not.toHaveBeenCalled(); expect(f.host.get(s.id, scope)?.state).toBe('idle'); expect(f.host.workspaceBusy(f.cwd)).toBe(false)
    expect(store.receipt(s.id, 'failed')).toBeUndefined()
  })
  it('keeps the physical workspace locked until cancellation is acknowledged by the engine', async () => {
    const f = setup(), s = await f.create(), alias = `${f.cwd}-alias`; symlinkSync(f.cwd, alias); cleanups.push(() => rmSync(alias))
    f.host.prompt(s.id, scope, 'work')
    expect(f.host.workspaceBusy(alias, 'room:another')).toBe(true)
    expect(() => f.host.reserveWorkspace(alias, 'room:another')).toThrow('工作区')
    f.host.cancel(s.id, scope); expect(f.host.workspaceBusy(f.cwd)).toBe(true)
    await vi.waitFor(() => expect(f.prompts).toHaveBeenCalledOnce()); await f.end()
    expect(f.host.workspaceBusy(f.cwd)).toBe(false)
  })
  it('evicts only idle recoverable processes and preserves their history', async () => {
    const f = setup({ maxSessions: 1 }), first = await f.create(), second = await f.create()
    expect(f.host.get(first.id, scope)).toMatchObject({ state: 'detached', historyOnly: true })
    f.host.prompt(second.id, scope, 'running')
    await expect(f.create()).rejects.toThrow('上限')
    expect(f.host.history(first.id, scope)?.events.length).toBeGreaterThan(0)
  })
  it('projects advertised commands and modes plus tool output, paths, diffs and plans', async () => {
    const f = setup({ eventBuffer: 100 }), s = await f.create()
    expect(f.host.get(s.id, scope)?.commands).toEqual([{ name: 'compact', description: 'Compress' }])
    expect((await f.host.setMode(s.id, scope, 'plan')).modes?.currentModeId).toBe('plan')
    const peer = f.peers[0]!
    peer.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'tool_call', toolCallId: 't', rawInput: { command: 'pwd' }, rawOutput: { exitCode: 0 }, locations: [{ path: 'a.ts', line: 2 }], content: [{ type: 'content', content: { type: 'text', text: 'output' } }, { type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' }] } })
    peer.notify('session/update', { sessionId: 'engine', update: { sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'completed' }] } })
    await vi.waitFor(() => expect(f.host.history(s.id, scope)!.events.some(e => e.event.type === 'plan')).toBe(true))
    expect(f.host.history(s.id, scope)!.events.find(e => e.event.type === 'tool.call')?.event).toMatchObject({ output: 'output', input: '{"command":"pwd"}', exitCode: 0, locations: [{ path: 'a.ts', line: 2 }], diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] })
  })
  it('reserves the workspace before asynchronous Skill resolution and releases it on failed load', async () => {
    const f = setup(), s = await f.create(); let rejectSkill!: (reason: Error) => void
    class Response extends EventEmitter { status = 0; writeHead(status: number) { this.status = status; return this }; end() { this.emit('close') } }
    const res = new Response(), req = Object.assign(new EventEmitter(), { method: 'POST', url: `/lumo/api/acp/sessions/${s.id}/prompt`, headers: {} })
    const loading = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectSkill = reject }))
    const pending = handleAcpRoute(req as IncomingMessage, res as unknown as ServerResponse, req.url, { host: f.host, asks: f.asks, identity: scope, readBody: async () => Buffer.from(JSON.stringify({ text: 'work', skills: ['review'], clientMessageId: 'skill' })), skills: { list: async () => ({ skills: [], complete: true }), load: loading } })
    await vi.waitFor(() => expect(loading).toHaveBeenCalledOnce())
    expect(() => f.host.reserveWorkspace(f.cwd, 'room:simultaneous')).toThrow('工作区')
    rejectSkill(new Error('Skill unavailable')); await pending
    expect(res.status).toBe(400); expect(f.host.workspaceBusy(f.cwd)).toBe(false); expect(f.prompts).not.toHaveBeenCalled()
  })
})
