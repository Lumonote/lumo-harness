import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'
const config: Config = {
 schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
 realm: 'realm-a', userId: 'alice', roles: ['realm_admin'], projectId: '', deptId: '', controlPlaneToken: 'service-token', identityAssertionSecret: '', timeoutMs: 5000,
 deploymentMode: 'cluster', storageBackend: 'postgres', middleware: [], clusterStatus: 'ready', plugins: [], sessionControlUrl: '', desktopHandoffFile: '', skillhubCatalogFile: '', skillhubInstallFile: '', skillhubRoot: '', skillhubCommand: '', skillhubApiBase: '', skillhubSnapshotFile: '',
}
async function invoke(method: string, url: string, body?: unknown, settings = config) {
 const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { 'x-lumo-realm': 'forged', 'x-lumo-user': 'forged', 'x-lumo-roles': 'platform_admin', authorization: 'Bearer forged' } })
 const result = { status: 0, body: undefined as unknown }
 await api(settings, undefined, undefined, undefined, undefined, req as never, { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk === undefined ? undefined : JSON.parse(chunk) } } as never)
 return result
}
afterEach(() => vi.unstubAllGlobals())
it('uses trusted identity and fixed routes, discards forged query and preserves uncertain execution responses', async () => {
 const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"requests":[]}', { status: 200 })).mockResolvedValueOnce(new Response('{"request":{}}', { status: 200 })).mockResolvedValueOnce(new Response('{"error":"recovery_provider_unavailable","request":{"status":"uncertain"}}', { status: 503 }))
 vi.stubGlobal('fetch', fetchMock)
 await invoke('GET', '/lumo/api/recovery-requests?realm=forged&user_id=forged')
 await invoke('GET', '/lumo/api/recovery-requests/recovery-1?realm=forged')
 const body = { expected_revision: 2, request_digest: 'a'.repeat(64) }
 expect(await invoke('POST', '/lumo/api/recovery-requests/recovery-1/execute', body)).toEqual({ status: 503, body: { error: 'recovery_provider_unavailable', request: { status: 'uncertain' } } })
 expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['http://governance.test/v1/recovery-requests', 'http://governance.test/v1/recovery-requests/recovery-1', 'http://governance.test/v1/recovery-requests/recovery-1/execute'])
 for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer service-token', 'X-Lumo-Realm': 'realm-a', 'X-Lumo-User': 'alice', 'X-Lumo-Roles': 'realm_admin' } })
 expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) })
})
it('refuses encoded paths, unregistered actions, wrong methods and unavailable cluster before upstream mutation', async () => {
 const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
 expect((await invoke('POST', '/lumo/api/recovery-requests/invalid%2frequest/execute', {})).status).toBe(400)
 expect((await invoke('POST', '/lumo/api/recovery-requests/id/destroy', {})).status).toBe(404)
 expect((await invoke('PUT', '/lumo/api/recovery-requests/id', {})).status).toBe(405)
 expect((await invoke('POST', '/lumo/api/recovery-requests/id', {})).status).toBe(405)
 expect((await invoke('GET', '/lumo/api/recovery-requests/id/execute')).status).toBe(405)
 expect((await invoke('POST', '/lumo/api/recovery-requests', {}, { ...config, clusterStatus: 'not_ready' })).status).toBe(403)
 expect(fetchMock).not.toHaveBeenCalled()
})
