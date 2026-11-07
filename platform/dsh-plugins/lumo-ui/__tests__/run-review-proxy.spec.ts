import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
  realm: 'r1', userId: 'requester', roles: ['manager'], projectId: 'p1', deptId: '',
  controlPlaneToken: 'service-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config
const path = '/lumo/api/tasks/producer/runs/producer%3Aattempt%3A1/review-tasks'
async function invoke(options: { method?: string; path?: string; key?: unknown; body?: string } = {}) {
  const req = Object.assign(Readable.from([Buffer.from(options.body ?? '{"reviewer_worker_id":"agent:reviewer"}')]), {
    method: options.method ?? 'POST', url: options.path ?? path,
    headers: { 'content-type': 'application/json', 'idempotency-key': options.key,
      'x-lumo-realm': 'forged', 'x-lumo-user': 'forged', 'x-lumo-roles': 'platform_admin' },
  })
  const result = { status: 0, body: null as unknown }
  const res = { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk ? JSON.parse(chunk) : null } }
  await api(config, undefined, undefined, undefined, undefined, req as never, res as never)
  return result
}
afterEach(() => vi.unstubAllGlobals())

describe('independent Run review creation proxy', () => {
  it.each([200, 201])('forwards the fixed review target, trusted caller and exact key: HTTP %i', async status => {
    const response = { task: { id: 'review-task' }, run: { id: 'review-run' } }
    const fetcher = vi.fn(async () => Response.json(response, { status }))
    vi.stubGlobal('fetch', fetcher)
    expect(await invoke({ key: 'ui-review:stable' })).toEqual({ status, body: response })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('http://governance.test/v1/tasks/producer/runs/producer%3Aattempt%3A1/review-tasks', expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({
        'Idempotency-Key': 'ui-review:stable', Authorization: 'Bearer service-token',
        'X-Lumo-Realm': 'r1', 'X-Lumo-User': 'requester', 'X-Lumo-Roles': 'manager',
      }),
    }))
    expect(JSON.parse(Buffer.from(fetcher.mock.calls[0]![1]!.body as Buffer).toString())).toEqual({ reviewer_worker_id: 'agent:reviewer' })
  })

  it.each([undefined, '', 'bad key', 'a'.repeat(201), ['key1', 'key2']])('rejects missing or invalid keys before upstream I/O: %j', async key => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await invoke({ key })).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    '{}', '{', '[]', '{"reviewer_worker_id":"user:person"}', '{"reviewer_worker_id":"agent:"}',
    '{"reviewer_worker_id":"agent:bad/path"}', '{"reviewer_worker_id":"agent:reviewer","roles":["admin"]}',
    '{"reviewer_worker_id":"agent:reviewer","manifest_digest":"forged"}',
  ])('rejects unknown fields and non-Agent reviewer selection: %s', async body => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await invoke({ body, key: 'valid' })).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the review body within the governance endpoint bound', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await invoke({ key: 'valid', body: ' '.repeat(16 << 10) + '{}' })).status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    `/lumo/api/tasks/${'t'.repeat(129)}/runs/run/review-tasks`,
    '/lumo/api/tasks/producer/runs/bad%2Frun/review-tasks',
    '/lumo/api/tasks/producer/runs/bad%20run/review-tasks',
  ])('rejects invalid task or run identifiers: %s', async target => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await invoke({ path: target, key: 'valid' })).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires the exact POST route', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect((await invoke({ method: 'GET', key: 'valid' })).status).toBe(405)
    expect((await invoke({ path: `${path}/extra`, key: 'valid' })).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([path, '/lumo/api/delegations/producer/status'])('preserves current review and completion conflicts without bypass: %s', async target => {
    const failure = { error: 'conflict', message: 'independent review required: current output manifest has no accepted review' }
    const fetcher = vi.fn(async () => Response.json(failure, { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const result = await invoke({ path: target, key: 'valid', ...(target.endsWith('/status') ? { body: '{"event":"complete"}' } : {}) })
    expect(result).toEqual({ status: 409, body: failure })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
