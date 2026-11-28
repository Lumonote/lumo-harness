import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSessionModels } from '../src/session-models.ts'
import { bridgeCodexToAcp } from '../src/codex-bridge.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { modelEngine, modelOptions, modelScope as scope } from './fixtures/model-engine.ts'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()) })
const fixture = () => { const f = modelEngine(); cleanups.push(f.cleanup); return f }

describe('models reported by the actual engine', () => {
  it('prefers ACP configuration over legacy models and parses grouped options', () => {
    const config = modelOptions()
    config.configOptions[0]!.options = [{ group: 'Models', options: [{ value: 'large', name: 'Thorough' }, { value: 'large', name: 'Updated' }, { value: '\n', name: 'invalid' }] }] as never
    const result = readSessionModels({ ...config, models: { currentModelId: 'legacy', availableModels: [{ modelId: 'legacy' }] } })
    expect(result).toEqual({ source: 'config', configId: 'model', currentModelId: 'small', availableModels: [{ id: 'large', name: 'Updated' }] })
    expect(readSessionModels({})).toBeUndefined()
    expect(readSessionModels({ models: { currentModelId: 'old', availableModels: [{ modelId: 'old', name: 'Older engine' }] } })).toMatchObject({ source: 'legacy', availableModels: [{ id: 'old' }] })
  })
  it('applies a chosen model before a first prompt and reapplies it when explicitly restoring', async () => {
    const f = fixture(), session = await f.host.createSession({ ...scope, engineId: 'test', cwd: f.dir, title: 'Named Agent', modelId: 'large' })
    expect(session.modelId).toBe('large')
    expect(f.calls).toEqual([{ method: 'model', params: { sessionId: session.engineSessionId, configId: 'model', value: 'large' } }])
    expect(f.prompts).toEqual([])
    expect(JSON.parse(readFileSync(f.indexPath, 'utf8')).sessions[0]).toMatchObject({ modelId: 'large', title: 'Named Agent' })
    f.host.closeAll()
    const next = f.createHost()
    expect(next.list(scope)[0]).toMatchObject({ modelId: 'large', state: 'detached' })
    expect((await next.resume(session.id, scope)).modelId).toBe('large')
    expect(f.calls.map(c => c.method)).toEqual(['model', 'load', 'model']); expect(f.prompts).toEqual([])
  })
  it('rejects unknown models without retaining a process or sending any prompt', async () => {
    const f = fixture()
    await expect(f.host.createSession({ ...scope, engineId: 'test', cwd: f.dir, modelId: 'invented' })).rejects.toThrow('列表')
    expect(f.host.list(scope)).toEqual([]); expect(f.calls).toEqual([]); expect(f.prompts).toEqual([])
  })
  it('locks prompt and competing configuration until the engine acknowledges the switch', async () => {
    const f = fixture(), s = await f.host.createSession({ ...scope, engineId: 'test', cwd: f.dir })
    let acknowledge!: (value: unknown) => void
    f.peers[0]!.onRequest('session/set_config_option', () => new Promise(resolve => { acknowledge = resolve }))
    const switching = f.host.setModel(s.id, scope, 'large')
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    expect(f.host.prompt(s.id, scope, 'work')).toMatchObject({ ok: false })
    await expect(f.host.setModel(s.id, scope, 'small')).rejects.toThrow('等待')
    await expect(f.host.setModel(s.id, { ...scope, userId: 'other' }, 'large')).rejects.toThrow()
    acknowledge(modelOptions('large')); await switching
    expect(f.host.get(s.id, scope)?.modelId).toBe('large')
    expect(f.host.prompt(s.id, scope, 'work').ok).toBe(true)
  })
  it('does not claim a model switch succeeded when the engine did not confirm it', async () => {
    const f = fixture(), s = await f.host.createSession({ ...scope, engineId: 'test', cwd: f.dir })
    f.peers[0]!.onRequest('session/set_config_option', () => modelOptions('small'))
    await expect(f.host.setModel(s.id, scope, 'large')).rejects.toThrow('未确认')
    expect(f.host.get(s.id, scope)?.modelId).toBe('small')
    expect(f.prompts).toEqual([])
  })
  it('publishes live configuration updates without starting a new turn', async () => {
    const f = fixture(), s = await f.host.createSession({ ...scope, engineId: 'test', cwd: f.dir }), receive = vi.fn()
    const unsubscribe = f.host.subscribe(s.id, scope, 0, receive)!
    f.peers[0]!.notify('session/update', { sessionId: s.engineSessionId, update: { sessionUpdate: 'config_option_update', ...modelOptions('large') } })
    await vi.waitFor(() => expect(f.host.get(s.id, scope)?.modelId).toBe('large'))
    expect(JSON.parse(readFileSync(f.indexPath, 'utf8')).sessions[0].modelId).toBe('large')
    expect(receive).toHaveBeenLastCalledWith(expect.any(Number), expect.objectContaining({ type: 'session.models', models: expect.objectContaining({ currentModelId: 'large' }) }))
    unsubscribe(); expect(f.prompts).toEqual([])
  })
})

describe('Codex native model directory and turn binding', () => {
  const codex = () => {
    const [client, server] = memoryTransportPair(), peer = new JsonRpcConnection(server), acp = new JsonRpcConnection(bridgeCodexToAcp(client))
    cleanups.push(() => { acp.close(); peer.close() })
    peer.onRequest('thread/start', () => ({ thread: { id: 'thread' }, model: 'small' }))
    return { peer, acp }
  }
  it('reads paginated model/list and binds the selected model to turn/start', async () => {
    const { peer, acp } = codex(), list = vi.fn(params => (params as { cursor?: string }).cursor ? { data: [{ model: 'large', displayName: 'Thorough' }] } : { data: [{ model: 'small', displayName: 'Fast' }], nextCursor: 'page2' })
    peer.onRequest('model/list', list)
    const session = await acp.request<{ models: { availableModels: unknown[] } }>('session/new', { cwd: '/work', mcpServers: [] })
    expect(session.models.availableModels).toHaveLength(2); expect(list).toHaveBeenCalledTimes(2)
    await acp.request('session/set_model', { sessionId: 'thread', modelId: 'large' })
    const start = vi.fn(() => { peer.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } }); return { turn: { id: 'turn' } } })
    peer.onRequest('turn/start', start)
    await acp.request('session/prompt', { sessionId: 'thread', prompt: [{ type: 'text', text: 'work' }] })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', model: 'large' }))
    await expect(acp.request('session/set_model', { sessionId: 'thread', modelId: 'invented' })).rejects.toThrow('列表')
  })
  it('leaves old app-servers on their own default without inventing a model catalog', async () => {
    const { acp } = codex()
    const result = await acp.request('session/new', { cwd: '/work', mcpServers: [] })
    expect(result).toEqual({ sessionId: 'thread' })
    await expect(acp.request('session/set_model', { sessionId: 'thread', modelId: 'large' })).rejects.toThrow()
  })
})
