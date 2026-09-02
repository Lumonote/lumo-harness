import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: 'http://registry.test',
  realm: 'realm-a', userId: 'operator-a', roles: ['realm_admin'], projectId: 'project-a', deptId: '',
  controlPlaneToken: 'test-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'cluster', storageBackend: 'postgres', middleware: [], clusterStatus: 'ready', plugins: [],
} as Config

function request() {
  return Object.assign(Readable.from([]), { method: 'GET', url: '/lumo/api/registry/rollouts/release-flow?node_id=node-a.1', headers: {} })
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

describe('rollout cohort selection proxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forwards a validated node id to the registry selection endpoint', async () => {
    const body = { rollout: { name: 'release-flow', version: '1.2.0', percent: 25 }, selection: { node_id: 'node-a.1', version: '1.1.0', cohort: 'holdback' } }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { res, result } = response()

    await api(config, undefined, undefined, undefined, request() as never, res)

    expect(result.status).toBe(200)
    expect(result.body).toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://registry.test/v1/rollouts/stable/release-flow?node_id=node-a.1',
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
