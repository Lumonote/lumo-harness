import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import bundles from '../tsdown.config.ts'
import { DualPluginGateway, LocalDecider, McpBridge } from '../../dual-plugins/src/index.ts'

it('runs the emitted relay artifact through initialize, list, call and session revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo-relay-artifact-'))
  const plugin = bundles.flatMap(bundle => bundle.plugins).find(value => value.name === 'lumo-mcp-relay')
  if (!plugin || !('generateBundle' in plugin)) throw new Error('Host bundle does not emit the MCP relay')
  let artifact = ''
  plugin.generateBundle.call({ emitFile(asset) {
    artifact = join(root, asset.fileName); writeFileSync(artifact, asset.source); return asset.fileName
  } })
  const gateway = new DualPluginGateway({ decider: new LocalDecider() }), bridge = new McpBridge(gateway)
  gateway.register({ manifestVersion: 1, id: 'fixture', title: 'Fixture', pages: [], tools: [{
    name: 'fixture_context', description: 'Read current context', action: 'fixture:read', risk: 'low',
    parameters: { type: 'object', properties: {} }, channels: ['acp'],
  }] }, { fixture_context: (_args, context) => ({ realm: context.caller.realm, project: context.caller.projectId }) })
  const [server] = await bridge.serversFor({ realm: 'fixture', userId: 'user', projectId: 'project', sessionRef: 'session' })
  const child = spawn(server!.command, [artifact], { env: Object.fromEntries(server!.env.map(item => [item.name, item.value])), stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', value => { stderr += String(value) })
  let nextId = 0
  const rpc = (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++nextId
    const done = () => { clearTimeout(timer); lines.off('line', receive); child.off('error', failed) }
    const failed = (error: Error) => { done(); reject(error) }
    const receive = (line: string) => {
      try { const message = JSON.parse(line); if (message.id === id) { done(); resolve(message) } }
      catch (error) { failed(error as Error) }
    }
    const timer = setTimeout(() => failed(new Error(`Relay timed out: ${stderr}`)), 5000)
    lines.on('line', receive); child.once('error', failed)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    expect(await rpc('initialize')).toMatchObject({ result: { serverInfo: { name: 'lumo-plugins' } } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    expect(await rpc('tools/list')).toMatchObject({ result: { tools: [{ name: 'fixture_context' }] } })
    expect(await rpc('tools/call', { name: 'fixture_context', arguments: {} })).toMatchObject({ result: { isError: false, structuredContent: { realm: 'fixture', project: 'project' } } })
    bridge.revokeSession('session')
    expect(await rpc('tools/list')).toMatchObject({ error: { code: -32603, message: expect.stringContaining('401') } })
  } finally {
    lines.close(); bridge.close()
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
