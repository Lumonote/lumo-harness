import { describe, expect, it } from 'vitest'
import { DualPluginGateway, LocalDecider, ToolAskBroker, handleDualRoute } from '../src/index.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
const request = { realm: 'r', userId: 'u', projectId: 'p', sessionRef: 's', pluginId: 'demo', tool: 'demo_tool', action: 'demo:write', risk: 'high', decisionId: 'd' }

describe('tool approval ownership', () => {
  it('uses restart-unique IDs and isolates reads and answers by realm, project and user', async () => {
    const asks = new ToolAskBroker(0), other = new ToolAskBroker(0)
    const first = asks.request(request), second = other.request(request)
    expect(first.ask.id).not.toBe(second.ask.id)
    const gateway = new DualPluginGateway({ asks, decider: new LocalDecider() })
    const route = async (identity: { realm: string; userId: string; projectId?: string }, path: string, method = 'GET') => {
      let status = 0, body: any
      const res = { writeHead: (value: number) => { status = value }, end: (value: string) => { body = JSON.parse(value) } }
      await handleDualRoute({ url: path, method } as IncomingMessage, res as unknown as ServerResponse, path.split('?')[0]!, { gateway, identity, readBody: async () => Buffer.from('{"value":"approve_once"}') })
      return { status, body }
    }
    for (const identity of [{ ...request, realm: 'other' }, { ...request, userId: 'other' }, { ...request, projectId: 'other' }, { realm: 'r', userId: 'u' }]) {
      expect((await route(identity, '/lumo/api/dual/asks')).body.asks).toEqual([])
      expect((await route(identity, `/lumo/api/dual/asks/${encodeURIComponent(first.ask.id)}/answer`, 'POST')).status).toBe(404)
    }
    expect((await route(request, '/lumo/api/dual/asks')).body.asks).toHaveLength(1)
    expect((await route(request, `/lumo/api/dual/asks/${encodeURIComponent(first.ask.id)}/answer`, 'POST')).status).toBe(200)
    expect(await first.outcome).toBe('once'); other.cancel(second.ask.id)
  })
})
