import { expect, it, vi } from 'vitest'
import { DualPluginGateway, LocalDecider, McpBridge, MCP_TOKEN_HEADER } from '../src/index.ts'

function sharedBridge() {
  const gateway = new DualPluginGateway({ decider: new LocalDecider() })
  gateway.register({ manifestVersion: 1, id: 'fixture', title: 'Fixture', pages: [], tools: [{ name: 'fixture_read', description: 'test', action: 'test:read', risk: 'low', parameters: { type: 'object', properties: {} }, channels: ['acp'] }] }, { fixture_read: () => ({ ok: true }) })
  return new McpBridge(gateway)
}

it('shares one listener across concurrent group members while keeping separate tokens', async () => {
  const bridge = sharedBridge()
  try {
    const configs = await Promise.all(Array.from({ length: 8 }, (_, index) => bridge.serversFor({ realm: 'r', userId: 'u', sessionRef: `s${index}` })))
    const envs = configs.map(([server]) => Object.fromEntries(server!.env.map(item => [item.name, item.value])))
    expect(new Set(envs.map(env => env.LUMO_MCP_URL)).size).toBe(1)
    expect(new Set(envs.map(env => env.LUMO_MCP_TOKEN)).size).toBe(8)
    bridge.revokeSession('s0')
    const invoke = (env: Record<string, string>) => fetch(env.LUMO_MCP_URL!, { method: 'POST', headers: { [MCP_TOKEN_HEADER]: env.LUMO_MCP_TOKEN! }, body: JSON.stringify({ id: 1, method: 'tools/list' }) })
    expect((await invoke(envs[0]!)).status).toBe(401)
    expect((await invoke(envs[1]!)).status).toBe(200)
  } finally { bridge.close() }
})

it('does not issue credentials or leave a listener alive when closed during startup', async () => {
  const bridge = sharedBridge()
  const starting = bridge.serversFor({ realm: 'r', userId: 'u', sessionRef: 's' })
  bridge.close()
  await expect(starting).rejects.toThrow('closed')
  expect(bridge.hasSession({ realm: 'r', userId: 'u', sessionRef: 's' })).toBe(false)
  await expect(bridge.serversFor({ realm: 'r', userId: 'u', sessionRef: 's' })).rejects.toThrow('closed')
})

it('revokes in-flight MCP execution with its session and invalidates its token', async () => {
  const gateway = new DualPluginGateway({ decider: new LocalDecider() }), bridge = new McpBridge(gateway)
  let execution: AbortSignal | undefined
  gateway.register({ manifestVersion: 1, id: 'lifetime', title: 'Lifetime', pages: [], tools: [{ name: 'lifetime_test', description: 'test', action: 'test:read', risk: 'low', parameters: { type: 'object', properties: {} }, channels: ['acp'] }] }, {
    lifetime_test: (_args, context) => { execution = context.signal; return new Promise(() => {}) },
  })
  try {
    const [server] = await bridge.serversFor({ realm: 'r', userId: 'u', sessionRef: 's' })
    expect(bridge.hasSession({ realm: 'r', userId: 'u', sessionRef: 's' })).toBe(true)
    expect(bridge.hasSession({ realm: 'r', userId: 'other', sessionRef: 's' })).toBe(false)
    expect(bridge.hasSession({ realm: 'r', userId: 'u', projectId: 'foreign', sessionRef: 's' })).toBe(false)
    const env = Object.fromEntries(server!.env.map(item => [item.name, item.value]))
    const post = () => fetch(env.LUMO_MCP_URL!, { method: 'POST', headers: { [MCP_TOKEN_HEADER]: env.LUMO_MCP_TOKEN! }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lifetime_test', arguments: {} } }) })
    const pending = post(); await vi.waitFor(() => expect(execution).toBeDefined())
    bridge.revokeSession('s')
    expect(bridge.hasSession({ realm: 'r', userId: 'u', sessionRef: 's' })).toBe(false)
    expect(execution!.aborted).toBe(true)
    expect(await (await pending).json()).toMatchObject({ result: { isError: true } })
    expect((await post()).status).toBe(401)
  } finally { bridge.close() }
})
