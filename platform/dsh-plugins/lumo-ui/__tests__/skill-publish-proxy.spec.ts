import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
  realm: 'realm-a', userId: 'operator-a', roles: ['realm_admin'], projectId: 'project-a', deptId: '',
  controlPlaneToken: 'test-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'cluster', storageBackend: 'postgres', middleware: [], clusterStatus: 'ready', plugins: [],
} as Config

function request() {
  return Object.assign(Readable.from([]), { method: 'POST', url: '/lumo/api/governance/skills/review/versions/1.2.0/publish', headers: {} })
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

describe('governed skill runtime-snapshot publication proxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forwards only a validated skill/version pair to governance', async () => {
    const published = { id: 'review', current_version: '1.2.0', published_version: '1.2.0', published_digest: 'sha256:abc' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(published), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { res, result } = response()

    await api(config, undefined, undefined, undefined, request() as never, res)

    expect(result.status).toBe(200)
    expect(result.body).toEqual(published)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://governance.test/v1/skills/review/versions/1.2.0/publish',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
