import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'
import { flowRunHeaders } from '../src/flow-run-api.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: 'http://flows.test', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'editor-a', roles: ['editor'], projectId: 'project-a', deptId: '',
  controlPlaneToken: 'test-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config

function request(method = 'POST', url = '/lumo/api/flows/flow-ops/runs/42/replay') {
  return Object.assign(Readable.from([]), { method, url, headers: {} })
}

function response(): { res: import('node:http').ServerResponse; result: { status: number; body: unknown } } {
  const result = { status: 0, body: undefined as unknown }
  const res = {
    setHeader: () => undefined,
    writeHead: (status: number) => { result.status = status; return res },
    end: (chunk?: string) => { result.body = chunk === undefined ? undefined : JSON.parse(chunk); return res },
  }
  return { res: res as unknown as import('node:http').ServerResponse, result }
}

describe('failed flow run replay proxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forwards only a validated flow/run pair to the flows service', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'queued', replay_trigger_id: 43, already_queued: false }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const { res, result } = response()

    await api(config, undefined, undefined, undefined, undefined, request() as never, res)

    expect(result.status).toBe(202)
    expect(result.body).toEqual({ status: 'queued', replay_trigger_id: 43, already_queued: false })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://flows.test/v1/flows/flow-ops/runs/42/replay',
      expect.objectContaining({ method: 'POST' }),
    )
  })
  it('forwards authenticated manual result reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 42, status: 'running', nodes: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { res, result } = response()
    await api(config, undefined, undefined, undefined, undefined, request('GET', '/lumo/api/flows/flow-ops/runs/42/result') as never, res)
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith('http://flows.test/v1/flows/flow-ops/runs/42/result', expect.objectContaining({ headers: expect.objectContaining({ 'X-Lumo-User': 'editor-a', 'X-Lumo-Realm': 'realm-a' }) }))
  })
  it.each(['0', '-1', '1.2', '9223372036854775808'])('rejects invalid result id %s without forwarding', async id => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const { res, result } = response()
    await api(config, undefined, undefined, undefined, undefined, request('GET', `/lumo/api/flows/flow-ops/runs/${id}/result`) as never, res)
    expect(result.status).toBe(400); expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves durable run receipts while rewriting the Location to the same-origin API', () => {
    expect(flowRunHeaders('/v1/flows/flow-ops/run', new Headers({ 'X-Lumo-Flow-Run': '42', Location: 'https://untrusted.test/' }))).toEqual({ 'X-Lumo-Flow-Run': '42', Location: '/lumo/api/flows/flow-ops/runs/42/result' })
    expect(flowRunHeaders('/v1/flows/flow-ops/run', new Headers({ 'X-Lumo-Flow-Run': '-42' }))).toEqual({})
  })

  it('returns the durable receipt headers through the full POST BFF', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: 42, status: 'running' }), { status: 202, headers: { 'X-Lumo-Flow-Run': '42', Location: '/v1/flows/flow-ops/runs/42/result' } })))
    const { res, result } = response()
    res.setHeader = vi.fn()
    await api(config, undefined, undefined, undefined, undefined, request('POST', '/lumo/api/flows/flow-ops/run') as never, res)
    expect(result.status).toBe(202)
    expect(res.setHeader).toHaveBeenCalledWith('X-Lumo-Flow-Run', '42')
    expect(res.setHeader).toHaveBeenCalledWith('Location', '/lumo/api/flows/flow-ops/runs/42/result')
  })

})
