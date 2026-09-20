import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const base = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  sessionControlUrl: 'http://session-control.test',
  realm: 'realm-a', userId: 'operator-a', roles: ['realm_admin'], projectId: 'project-a', deptId: '',
  controlPlaneToken: 'test-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as unknown as Config

function request(method: string, url: string, body?: unknown) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return Object.assign(Readable.from(chunks), { method, url, headers: {} })
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

async function forward(config: Config, method: string, url: string, payload: unknown = {}, body?: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const { res, result } = response()
  await api(config, undefined, undefined, undefined, undefined, request(method, url, body) as never, res)
  return { fetchMock, result }
}

describe('session control proxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('forwards the console read face', async () => {
    const { fetchMock, result } = await forward(base, 'GET', '/lumo/api/sessions/session-1/control', { session_ref: 'session-1', registered: false })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ session_ref: 'session-1', registered: false })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://session-control.test/v1/sessions/session-1/control',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  // The timeline is a distinct path one segment longer. A control route that
  // matched too greedily would swallow it and answer a cursor read with a state
  // snapshot -- same status, wrong shape, and the console would render an empty
  // timeline as "no one ever touched this session".
  it('leaves the timeline route unshadowed and keeps its cursor', async () => {
    const { fetchMock, result } = await forward(base, 'GET', '/lumo/api/sessions/session-1/control/events?after=7&limit=25', { events: [], next_after: 0 })
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://session-control.test/v1/sessions/session-1/control/events?after=7&limit=25',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  // This is the reason the proxy exists at all. The control plane's own comment
  // says identity is "what the caller claims + what OPA decides" -- so whoever
  // forwards the body is the one making the claim. The browser is not a trusted
  // source (cluster-management.md), and the signed assertion resolved from the
  // auth proxy is. A body that declares its own realm must lose to it.
  it('overrides a body that declares its own realm, role or actor', async () => {
    const { fetchMock } = await forward(base, 'POST', '/lumo/api/sessions/session-1/control',
      { outcome: 'applied' },
      { command: 'pause', realm: 'realm-other', role: 'platform_admin', actor: 'somebody-else', reason: 'why not' })

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(JSON.parse(init.body)).toEqual({
      command: 'pause', reason: 'why not',
      realm: 'realm-a', role: 'realm_admin', actor: 'operator-a',
    })
  })

  // `roles: ['editor']` is a governance role the control plane's closed role set
  // (platform_admin / realm_admin / admin / approver / operator) does not know.
  // Forwarding it would come back as "角色未被授予该指令", which reads like "you
  // lack the permission" -- but the truth is this surface has no notion of that
  // role, and the two are fixed by different people.
  it('refuses an identity the control plane has no role for, without calling upstream', async () => {
    const { fetchMock, result } = await forward({ ...base, roles: ['editor'] } as Config, 'POST', '/lumo/api/sessions/session-1/control', {}, { command: 'pause' })
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ error: 'no_control_role' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A deployment without this service must say so. Dialing a default localhost
  // port would surface as "the control plane is unreachable" and send the reader
  // to the network instead of to the deployment.
  it('reports an unconfigured control plane instead of dialing a default port', async () => {
    const { fetchMock, result } = await forward({ ...base, sessionControlUrl: '' } as Config, 'GET', '/lumo/api/sessions/session-1/control', {})
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ error: 'session-control 服务未配置' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses identifiers the proxy does not accept', async () => {
    for (const url of [`/lumo/api/sessions/${'a'.repeat(129)}/control`, '/lumo/api/sessions/bad%20id/control', '/lumo/api/sessions/session-1/control/events'.replace('session-1', 'bad%20id')]) {
      const { fetchMock, result } = await forward(base, 'GET', url, {})
      expect(result.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('rejects methods other than GET and POST', async () => {
    const { fetchMock, result } = await forward(base, 'DELETE', '/lumo/api/sessions/session-1/control', {})
    expect(result.status).toBe(405)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
