import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'
const config: Config = {
 schedulerUrl: '', projectsUrl: 'http://projects.test', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '', realm: 'realm-a', userId: 'alice', roles: ['realm_admin'], projectId: '', deptId: '', controlPlaneToken: 'service-token', identityAssertionSecret: '', timeoutMs: 5000,
 deploymentMode: 'cluster', storageBackend: 'postgres', middleware: [], clusterStatus: 'ready', plugins: [], sessionControlUrl: '', desktopHandoffFile: '', skillhubCatalogFile: '', skillhubInstallFile: '', skillhubRoot: '', skillhubCommand: '', skillhubApiBase: '', skillhubSnapshotFile: '',
}
async function invoke(method: string, url: string, body?: unknown, settings = config) {
 const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { 'x-lumo-realm': 'forged', 'x-lumo-user': 'forged', 'x-lumo-roles': 'platform_admin' } })
 const result = { status: 0, body: undefined as unknown }
 await api(settings, undefined, undefined, undefined, undefined, req as never, { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk === undefined ? undefined : JSON.parse(chunk) } } as never)
 return result
}
afterEach(() => vi.unstubAllGlobals())
it('routes the project directory before dynamic project IDs with allowlisted filters', async () => {
 const fetch = vi.fn().mockResolvedValue(new Response('{"projects":[]}')); vi.stubGlobal('fetch', fetch)
 await invoke('GET', '/lumo/api/projects/directory?q=hello&q=second&status=active&role=owner&sort=name&limit=20&offset=5&realm=forged')
 expect(fetch.mock.calls[0]![0]).toBe('http://projects.test/v1/projects/directory?q=hello&q=second&status=active&role=owner&sort=name&limit=20&offset=5')
 expect(fetch.mock.calls[0]![1].headers).toMatchObject({ 'X-Lumo-Realm': 'realm-a', 'X-Lumo-User': 'alice' })
})
it('blocks nonadministrators and not-ready clusters before sensitive requests', async () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
 for (const path of ['/security', '/sessions', '/security-events']) expect((await invoke('GET', `/lumo/api/users/bob${path}`, undefined, { ...config, roles: ['viewer'] })).status).toBe(403)
 expect((await invoke('DELETE', '/lumo/api/users/bob/sessions/s-1', { reason: 'lost' }, { ...config, clusterStatus: 'not_ready' })).status).toBe(403)
 expect(fetch).not.toHaveBeenCalled()
})
it('forwards session pagination and revocation reasons with trusted identity', async () => {
 const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"revoked":1}'))); vi.stubGlobal('fetch', fetch)
 await invoke('GET', '/lumo/api/users/bob/sessions?limit=25&offset=50&realm=forged'); expect(fetch.mock.calls[0]![0]).toBe('http://governance.test/v1/users/bob/sessions?limit=25&offset=50')
 await invoke('DELETE', '/lumo/api/users/bob/sessions/session-1', { reason: '设备遗失' }); expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'DELETE', body: '{"reason":"设备遗失"}', headers: { 'X-Lumo-User': 'alice', 'content-type': 'application/json' } })
})
it('preserves progress CAS failure and excludes spoofed identity from workforce queries', async () => {
 const fetch = vi.fn().mockResolvedValueOnce(new Response('{"items":[]}')).mockResolvedValueOnce(new Response('{"error":"progress_changed"}', { status: 409 })); vi.stubGlobal('fetch', fetch)
 await invoke('GET', '/lumo/api/workforce/progress?scope=mine&cursor=abc&limit=50&user_id=forged&realm=other'); expect(fetch.mock.calls[0]![0]).toBe('http://governance.test/v1/workforce/progress?scope=mine&limit=50&cursor=abc')
 const body = { run_id: 'r-1', expected_revision: 3, status: 'blocked', percent: 20, summary: 'waiting', next_step: 'review', blocked_reason: 'need attachment' }
 expect(await invoke('PUT', '/lumo/api/tasks/t-1/progress', body)).toEqual({ status: 409, body: { error: 'progress_changed' } }); expect(fetch.mock.calls[1]![1].body).toBe(JSON.stringify(body))
})
it('rejects traversal and unsupported mutations', async () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
 expect((await invoke('DELETE', '/lumo/api/users/bob/security')).status).toBe(405)
 expect((await invoke('GET', '/lumo/api/users/bob/sessions/invalid%2Fsession')).status).toBe(400)
 expect((await invoke('PUT', '/lumo/api/tasks/bad%2Ftask/progress', {})).status).toBe(400)
 expect((await invoke('POST', '/lumo/api/workforce/progress', {})).status).toBe(405)
 expect((await invoke('PATCH', '/lumo/api/projects/directory', {})).status).toBe(405); expect(fetch).not.toHaveBeenCalled()
})
it('forwards bounded workforce filters and duplicate values for server validation', async () => {
 const fetch = vi.fn().mockResolvedValue(new Response('{"items":[]}')); vi.stubGlobal('fetch', fetch)
 await invoke('GET', '/lumo/api/workforce/progress?q=Alice&q=Bob&risk=blocked&worker_kind=agent&scope=all&realm=forged')
 expect(fetch.mock.calls[0]![0]).toBe('http://governance.test/v1/workforce/progress?scope=all&q=Alice&q=Bob&risk=blocked&worker_kind=agent')
})
it('reads an authorized task outside the currently loaded directory page', async () => {
 const fetch = vi.fn().mockResolvedValue(new Response('{"id":"t-2"}')); vi.stubGlobal('fetch', fetch)
 expect(await invoke('GET', '/lumo/api/delegations/t-2?realm=forged')).toEqual({ status: 200, body: { id: 't-2' } }); expect(fetch.mock.calls[0]![0]).toBe('http://governance.test/v1/delegations/t-2')
})
