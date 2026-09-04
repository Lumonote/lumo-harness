import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: 'http://flows.test', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'editor-a', roles: ['editor'], projectId: 'project-a', deptId: '',
  controlPlaneToken: 'test-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config

function request() {
  return Object.assign(Readable.from([]), { method: 'POST', url: '/lumo/api/flows/flow-ops/runs/42/replay', headers: {} })
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
})
