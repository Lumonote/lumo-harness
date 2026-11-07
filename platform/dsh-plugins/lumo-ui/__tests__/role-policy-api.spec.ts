import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'

const config: Config = {
 schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
 realm: 'realm-a', userId: 'alice', roles: ['realm_admin'], projectId: '', deptId: '', controlPlaneToken: 'service-token', identityAssertionSecret: '', timeoutMs: 5000,
 deploymentMode: 'cluster', storageBackend: 'postgres', middleware: [], clusterStatus: 'ready', plugins: [],
 sessionControlUrl: '', desktopHandoffFile: '', skillhubCatalogFile: '', skillhubInstallFile: '', skillhubRoot: '', skillhubCommand: '', skillhubApiBase: '', skillhubSnapshotFile: '',
}
async function invoke(method: string, url: string, body?: unknown, settings = config) {
 const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { 'x-lumo-realm': 'forged', 'x-lumo-user': 'forged', 'x-lumo-roles': 'platform_admin', authorization: 'Bearer forged' } })
 const result = { status: 0, body: undefined as unknown }
 await api(settings, undefined, undefined, undefined, undefined, req as never, { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk === undefined ? undefined : JSON.parse(chunk) } } as never)
 return result
}
afterEach(() => vi.unstubAllGlobals())
it('proxies the closed role policy routes with trusted identity and preserves CAS failures', async () => {
 const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"actions":[]}', { status: 200 })).mockResolvedValueOnce(new Response('{"revision":4}', { status: 200 })).mockResolvedValueOnce(new Response('{"error":"role_policy_changed"}', { status: 409 })).mockResolvedValueOnce(new Response('{"revision":5}', { status: 200 }))
 vi.stubGlobal('fetch', fetchMock)
 expect((await invoke('GET', '/lumo/api/permission-actions?realm=forged')).status).toBe(200)
 expect((await invoke('GET', '/lumo/api/roles/custom/permissions?realm=forged')).status).toBe(200)
 const body = { expected_revision: 4, permissions: [{ action: 'task:delegate', effect: 'deny' }] }
 expect(await invoke('PUT', '/lumo/api/roles/custom/permissions', body)).toEqual({ status: 409, body: { error: 'role_policy_changed' } })
 expect((await invoke('DELETE', '/lumo/api/roles/custom/permissions', { expected_revision: 4 })).status).toBe(200)
 expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['http://governance.test/v1/permission-actions', 'http://governance.test/v1/roles/custom/permissions', 'http://governance.test/v1/roles/custom/permissions', 'http://governance.test/v1/roles/custom/permissions'])
 for (const [, init] of fetchMock.mock.calls) expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer service-token', 'X-Lumo-Realm': 'realm-a', 'X-Lumo-User': 'alice', 'X-Lumo-Roles': 'realm_admin' } })
 expect(fetchMock.mock.calls[2]![1].body).toBe(JSON.stringify(body))
 expect(fetchMock.mock.calls[3]![1]).toMatchObject({ method: 'DELETE', body: '{"expected_revision":4}' })
})
it('rejects route traversal, unsupported methods and inactive cluster writes before any fetch', async () => {
 const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetchMock)
 expect((await invoke('PUT', '/lumo/api/roles/%2e%2e/parent', {})).status).toBe(404)
 expect((await invoke('PUT', '/lumo/api/roles/invalid%2frole/parent', {})).status).toBe(400)
 expect((await invoke('GET', '/lumo/api/roles/custom/parent')).status).toBe(405)
 expect((await invoke('POST', '/lumo/api/roles/custom/permissions', {})).status).toBe(405)
 expect((await invoke('PUT', '/lumo/api/roles/custom/parent', { expected_revision: 1, parent_role_id: null }, { ...config, clusterStatus: 'not_ready' })).status).toBe(403)
 expect(fetchMock).not.toHaveBeenCalled()
})
