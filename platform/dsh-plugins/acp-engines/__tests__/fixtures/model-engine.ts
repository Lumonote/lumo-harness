import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineHost } from '../../src/engine-host.ts'
import { EngineRegistry } from '../../src/registry.ts'
import { SessionAskBroker } from '../../src/permission-asks.ts'
import { JsonRpcConnection, memoryTransportPair } from '../../src/jsonrpc.ts'

export const modelScope = { realm: 'local', userId: 'owner', projectId: 'project' }
export const modelOptions = (current = 'small') => ({ configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: current,
  options: [{ value: 'small', name: 'Fast' }, { value: 'large', name: 'Thorough' }] }] })
export const modelEngine = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-models-')), indexPath = join(dir, 'sessions.json')
  const peers: JsonRpcConnection[] = [], calls: Array<{ method: string; params: Record<string, unknown> }> = [], prompts: string[] = []
  const hosts: EngineHost[] = []
  const registry = new EngineRegistry([{ id: 'test', label: 'Test Tool', provider: 'test', protocol: 'acp', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true })
  const createHost = () => {
    const host = new EngineHost({ registry, asks: new SessionAskBroker(0), recoveryIndexPath: indexPath, connect: () => {
      const [client, server] = memoryTransportPair(), peer = new JsonRpcConnection(server), id = `engine-${peers.length}`
      peers.push(peer)
      peer.onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      peer.onRequest('session/new', () => ({ sessionId: id, ...modelOptions() }))
      peer.onRequest('session/load', params => { calls.push({ method: 'load', params: params as Record<string, unknown> }); return modelOptions() })
      peer.onRequest('session/set_config_option', params => {
        const p = params as Record<string, unknown>; calls.push({ method: 'model', params: p }); return modelOptions(p.value as string)
      })
      peer.onRequest('session/prompt', params => { prompts.push((params as { sessionId: string }).sessionId); return { stopReason: 'end_turn' } })
      return client
    } })
    hosts.push(host); return host
  }
  return { dir, indexPath, peers, calls, prompts, createHost, host: createHost(), cleanup: () => { hosts.forEach(h => h.closeAll()); rmSync(dir, { recursive: true, force: true }) } }
}
