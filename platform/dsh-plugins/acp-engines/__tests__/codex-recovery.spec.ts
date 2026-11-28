import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACP_METHODS } from '../src/acp-protocol.ts'
import { bridgeCodexToAcp, CODEX_METHODS } from '../src/codex-bridge.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'

const connections: JsonRpcConnection[] = []
afterEach(() => connections.splice(0).forEach(connection => connection.close()))
function setup() {
  const [transport, server] = memoryTransportPair()
  const peer = new JsonRpcConnection(server, 0)
  const acp = new JsonRpcConnection(bridgeCodexToAcp(transport), 0)
  connections.push(peer, acp)
  return { peer, acp }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('Codex turn cancellation', () => {
  it('replays an early Stop exactly once after the turn id arrives', async () => {
    const { peer, acp } = setup()
    let started!: (value: unknown) => void
    peer.onRequest(CODEX_METHODS.turnStart, () => new Promise(resolve => { started = resolve }))
    const interrupt = vi.fn(() => { peer.notify(CODEX_METHODS.turnCompleted, { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } }); return {} })
    peer.onRequest(CODEX_METHODS.turnInterrupt, interrupt)
    const pending = acp.request(ACP_METHODS.sessionPrompt, { sessionId: 'thread', prompt: [] })
    void pending.catch(() => {})
    await flush()
    acp.notify(ACP_METHODS.sessionCancel, { sessionId: 'thread' })
    acp.notify(ACP_METHODS.sessionCancel, { sessionId: 'thread' })
    await flush()
    expect(interrupt).not.toHaveBeenCalled()
    started({ turn: { id: 'turn' } })
    await flush()
    expect(interrupt).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', turnId: 'turn' })
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    acp.notify(ACP_METHODS.sessionCancel, { sessionId: 'thread' })
    await flush()
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('releases the waiter after start fails so the session can retry', async () => {
    const { peer, acp } = setup()
    peer.onRequest(CODEX_METHODS.turnStart, () => { throw new Error('start failed') })
    await expect(acp.request(ACP_METHODS.sessionPrompt, { sessionId: 'thread', prompt: [] })).rejects.toThrow('start failed')
    await expect(acp.request(ACP_METHODS.sessionPrompt, { sessionId: 'thread', prompt: [] })).rejects.toThrow('start failed')
  })

  it.each(['before', 'after'])('isolates stale completions arriving %s the next start response', async staleAt => {
    const { peer, acp } = setup()
    let start!: (value: unknown) => void
    peer.onRequest(CODEX_METHODS.turnStart, () => new Promise(resolve => { start = resolve }))
    const interrupt = vi.fn(() => ({}))
    peer.onRequest(CODEX_METHODS.turnInterrupt, interrupt)
    const prompt = () => acp.request(ACP_METHODS.sessionPrompt, { sessionId: 'thread', prompt: [] })
    const completed = (id: string) => peer.notify(CODEX_METHODS.turnCompleted, { threadId: 'thread', turn: { id, status: 'completed' } })
    const first = prompt()
    await flush()
    completed('turn-1')
    await flush()
    await expect(prompt()).rejects.toThrow('进行中的回合')
    start({ turn: { id: 'turn-1' } })
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' })

    let settled = false
    const second = prompt().finally(() => { settled = true })
    await flush()
    if (staleAt === 'before') completed('turn-1')
    await flush()
    start({ turn: { id: 'turn-2' } })
    await flush()
    if (staleAt === 'after') completed('turn-1')
    await flush()
    expect(settled).toBe(false)
    acp.notify(ACP_METHODS.sessionCancel, { sessionId: 'thread' })
    await flush()
    expect(interrupt).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', turnId: 'turn-2' })
    completed('turn-2')
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' })
  })
})

describe('Codex scoped MCP configuration', () => {
  it.each([ACP_METHODS.sessionNew, ACP_METHODS.sessionLoad])('forwards current relay credentials on %s', async method => {
    const { peer, acp } = setup()
    const handler = vi.fn(() => ({ thread: { id: 'thread' } }))
    peer.onRequest(method === ACP_METHODS.sessionNew ? CODEX_METHODS.threadStart : CODEX_METHODS.threadResume, handler)
    await acp.request(method, { sessionId: 'thread', cwd: '/project', mcpServers: [{ name: 'lumo', command: '/bin/node', args: ['relay.mjs'], env: [{ name: 'RELAY_TOKEN', value: 'new-token' }] }] })
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ config: { 'mcp_servers.lumo': { command: '/bin/node', args: ['relay.mjs'], env: { RELAY_TOKEN: 'new-token' } } } }))
  })

  it('rejects duplicate and ambiguous MCP names instead of overwriting credentials', async () => {
    const { peer, acp } = setup()
    const handler = vi.fn(() => ({ thread: { id: 'thread' } }))
    peer.onRequest(CODEX_METHODS.threadStart, handler)
    const server = { name: 'lumo', command: '/bin/node', args: [], env: [] }
    for (const mcpServers of [[server, server], [{ ...server, name: 'lumo.other' }]]) {
      await expect(acp.request(ACP_METHODS.sessionNew, { cwd: '/project', mcpServers })).rejects.toThrow(/MCP/)
    }
    expect(handler).not.toHaveBeenCalled()
  })
})
