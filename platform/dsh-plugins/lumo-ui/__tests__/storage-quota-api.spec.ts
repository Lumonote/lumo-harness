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
it('proxies quota scope with trusted identity and exact CAS body', async()=>{
 const fetchMock=vi.fn().mockResolvedValueOnce(new Response('{"quota":{"revision":2}}',{status:200})).mockResolvedValueOnce(new Response('{"error":"conflict"}',{status:409}));vi.stubGlobal('fetch',fetchMock)
 expect((await invoke('GET','/lumo/api/storage/quota?project_id=p')).status).toBe(200)
 const body={expected_revision:1,limit_bytes:0}
 expect(await invoke('PUT','/lumo/api/storage/quota?project_id=p',body)).toEqual({status:409,body:{error:'conflict'}})
 expect(fetchMock.mock.calls[0]![0]).toBe('http://governance.test/v1/storage/quota?project_id=p')
 expect(fetchMock.mock.calls[1]![1]).toMatchObject({method:'PUT',body:JSON.stringify(body),headers:{'X-Lumo-Realm':'realm-a','X-Lumo-User':'alice'}})
})
it('denies quota management while cluster is not ready',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);expect((await invoke('PUT','/lumo/api/storage/quota',{expected_revision:1,limit_bytes:null},{...config,clusterStatus:'not_ready'})).status).toBe(403);expect(f).not.toHaveBeenCalled()})
