import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'
import { encodeIdentityAssertion, signIdentityAssertion } from '../src/identity.ts'

const config: Config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'owner', roles: ['viewer'], projectId: '', deptId: '',
  controlPlaneToken: 'test-service-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'cluster', storageBackend: 'postgres', middleware: [], clusterStatus: 'ready', plugins: [],
  sessionControlUrl: '', desktopHandoffFile: '', skillhubCatalogFile: '', skillhubInstallFile: '', skillhubRoot: '',
  skillhubCommand: '', skillhubApiBase: '', skillhubSnapshotFile: '',
}
const budget = { projectId: 'p-1', unit: 'tokens', total: 1000, remaining: 800, softLimit: 900, overdraft: 100, revision: 3, state: 'within' }
const mutation = { mode: 'adjust', total: 1500, softLimit: 1000, overdraft: 100, expectedRevision: 3 }
function service() { return { readProjectBudget: vi.fn().mockResolvedValue(budget), configureProjectBudget: vi.fn().mockResolvedValue({ ...budget, total: 1500, remaining: 1300, revision: 4 }) } }
async function invoke(method: string, options: { body?: unknown; raw?: string; budgets?: ReturnType<typeof service>; config?: Config; headers?: Record<string,string>; path?: string } = {}) {
  const raw = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body))
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url: options.path ?? '/lumo/api/projects/p-1/budget', headers: { 'x-lumo-user': 'forged', 'x-lumo-realm': 'forged', ...options.headers } })
  const result = { status: 0, body: undefined as unknown }
  const res = { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk === undefined ? undefined : JSON.parse(chunk) } }
  await api(options.config ?? config, undefined, undefined, undefined, undefined, req as never, res as never, undefined, undefined, undefined, undefined, undefined, options.budgets)
  return result
}

describe('project budget API', () => {
  it('reads with trusted identity rather than incoming headers', async () => {
    const budgets = service()
    expect(await invoke('GET', { budgets })).toEqual({ status: 200, body: budget })
    expect(budgets.readProjectBudget).toHaveBeenCalledExactlyOnceWith({ realm: 'realm-a', actorUserId: 'owner', projectId: 'p-1' })
  })

  it('writes with signed identity and forwards only configuration fields', async () => {
    const budgets = service()
    const secret = 'project-budget-identity-secret-32-bytes'
    const assertion = encodeIdentityAssertion({ aud: 'lumo-ui', exp: Math.floor(Date.now() / 1000) + 60, realm: 'signed-realm', userId: 'signed-owner', roles: ['viewer'] })
    expect((await invoke('POST', { budgets, config: { ...config, identityAssertionSecret: secret }, headers: { 'x-lumo-identity': assertion, 'x-lumo-identity-signature': signIdentityAssertion(assertion, secret) }, body: { ...mutation, realm: 'forged', actorUserId: 'forged', projectId: 'forged', audit: 'forged' } })).status).toBe(200)
    expect(budgets.configureProjectBudget).toHaveBeenCalledExactlyOnceWith({ ...mutation, realm: 'signed-realm', actorUserId: 'signed-owner', projectId: 'p-1', confirmReset: false })
  })

  it.each([400, 403, 409])('preserves budget validation/authorization/conflict status %i', async status => {
    const budgets = service()
    budgets.configureProjectBudget.mockRejectedValueOnce(Object.assign(new Error('rejected'), { status }))
    expect(await invoke('POST', { budgets, body: mutation })).toEqual({ status, body: { error: 'rejected' } })
  })

  it('rejects malformed, fractional and unsafe inputs before writing', async () => {
    const budgets = service()
    for (const body of [null, [], {}, { ...mutation, total: '100' }, { ...mutation, overdraft: -1 }, { ...mutation, expectedRevision: 1.5 }, { ...mutation, total: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect((await invoke('POST', { budgets, body })).status).toBe(400)
    }
    expect((await invoke('POST', { budgets, raw: '{' })).status).toBe(400)
    expect(budgets.configureProjectBudget).not.toHaveBeenCalled()
  })

  it('rejects unavailable services, methods, IDs and unready cluster writes', async () => {
    const budgets = service()
    expect((await invoke('GET')).status).toBe(501)
    expect((await invoke('GET', { budgets, config: { ...config, deploymentMode: 'local' } })).status).toBe(501)
    expect((await invoke('DELETE', { budgets })).status).toBe(405)
    expect((await invoke('GET', { budgets, path: '/lumo/api/projects/p%2F1/budget' })).status).toBe(400)
    expect((await invoke('POST', { budgets, body: mutation, config: { ...config, clusterStatus: 'not_ready' } })).status).toBe(403)
    expect(budgets.configureProjectBudget).not.toHaveBeenCalled()
  })

  it('fails authentication before accessing the budget service', async () => {
    const budgets = service()
    expect((await invoke('GET', { budgets, config: { ...config, identityAssertionSecret: 'budget-signed-identity-secret-at-least-32' } })).status).toBe(401)
    expect(budgets.readProjectBudget).not.toHaveBeenCalled()
  })

  it('maps service failures to unavailable rather than successful budgets', async () => {
    const budgets = service()
    budgets.readProjectBudget.mockRejectedValueOnce(new Error('database offline'))
    expect((await invoke('GET', { budgets })).status).toBe(503)
  })
})
