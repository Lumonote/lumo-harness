import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: 'http://flows.test', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
  realm: 'r1', userId: 'u1', roles: ['manager'], projectId: 'p1', deptId: '',
  controlPlaneToken: 'service-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config

async function invoke(path: string, key: unknown) {
  const req = Object.assign(Readable.from([Buffer.from('{"input":{}}')]), { method: 'POST', url: path,
    headers: { 'idempotency-key': key, 'x-lumo-user': 'forged', 'x-lumo-realm': 'forged', 'x-lumo-roles': 'platform_admin' } })
  const result = { status: 0, body: null as unknown }
  const res = { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk === undefined ? null : JSON.parse(chunk) } }
  await api(config, undefined, undefined, undefined, undefined, req as never, res as never)
  return result
}

afterEach(() => vi.unstubAllGlobals())

it('forwards creation keys with trusted identity and refuses redirects', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ task: { id: 't' }, run: { id: 'r' } }), { status: 201 }))
  vi.stubGlobal('fetch', fetchMock)
  for (const path of ['/lumo/api/flows/flow-1/run', '/lumo/api/delegations']) {
    expect((await invoke(path, 'ui:retry-1')).status).toBe(201)
  }
  expect(fetchMock).toHaveBeenCalledTimes(2)
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toMatch(/^http:\/\/(flows|governance)\.test\//u)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      'Idempotency-Key': 'ui:retry-1', 'X-Lumo-User': 'u1', 'X-Lumo-Realm': 'r1', 'X-Lumo-Roles': 'manager', Authorization: 'Bearer service-token',
    } })
  }
})

it('rejects malformed or multiple creation keys before upstream I/O', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  for (const path of ['/lumo/api/flows/flow-1/run', '/lumo/api/delegations']) {
    for (const key of ['bad key', 'a'.repeat(201), ['one', 'two']]) expect((await invoke(path, key)).status).toBe(400)
  }
  expect(fetchMock).not.toHaveBeenCalled()
})
