import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: 'http://projects.test', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'r1', userId: 'alice', roles: ['member'], projectId: 'p1', deptId: '',
  controlPlaneToken: 'service-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config
const WS = 'a'.repeat(64)

async function invoke(method: string, url: string, body = '') {
  const req = Object.assign(Readable.from(body === '' ? [] : [Buffer.from(body)]), {
    method, url,
    headers: { 'content-type': 'application/json', 'x-lumo-realm': 'forged', 'x-lumo-user': 'root', 'x-lumo-roles': 'platform_admin', authorization: 'Bearer user-supplied' },
  })
  const result = { status: 0, body: null as unknown }
  const res = { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk ? JSON.parse(chunk) : null } }
  await api(config, undefined, undefined, undefined, undefined, req as never, res as never)
  return result
}
afterEach(() => vi.unstubAllGlobals())

describe('memory sync proxy', () => {
  it('forwards pull with trusted identity and only whitelisted query params', async () => {
    const fetcher = vi.fn(async () => Response.json({ items: [], cursor: 0, more: false }))
    vi.stubGlobal('fetch', fetcher)
    expect(await invoke('GET', `/lumo/api/memory-sync/changes?workspace=${WS}&since=3&realm=evil`)).toEqual({ status: 200, body: { items: [], cursor: 0, more: false } })
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`http://projects.test/v1/memory-sync/changes?workspace=${WS}&since=3`)
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer service-token', 'X-Lumo-Realm': 'r1', 'X-Lumo-User': 'alice', 'X-Lumo-Roles': 'member' }))
    expect(JSON.stringify(init.headers)).not.toMatch(/forged|root|platform_admin|user-supplied/u)
  })

  it('forwards push body unchanged', async () => {
    const fetcher = vi.fn(async () => Response.json({ results: [] }))
    vi.stubGlobal('fetch', fetcher)
    const payload = JSON.stringify({ workspace: WS, device: 'd1', changes: [] })
    expect((await invoke('POST', '/lumo/api/memory-sync/push', payload)).status).toBe(200)
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('http://projects.test/v1/memory-sync/push')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(payload)
  })

  it('rejects wrong methods without calling upstream', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect((await invoke('DELETE', '/lumo/api/memory-sync/push')).status).toBe(405)
    expect((await invoke('POST', '/lumo/api/memory-sync/changes')).status).toBe(405)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
