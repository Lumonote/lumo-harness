import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createAuthProxy, listenAuthProxy, closeAuthProxy, type AuthProxyOptions } from '../src/proxy.ts'
import { routeSessionTransport } from '../src/session-routing.ts'
import type { AuthenticatedSessionTransport, SessionTransportConfig } from '../src/session-transport.ts'
import { GovernanceApiError, type GovernanceAuthClient } from '../src/client.ts'
import type { SessionExecutionRuntime } from '../../../shared/session-execution.ts'

const group = process.env.LUMO_AUTH_PROXY_TEST === '1' ? describe : describe.skip
const alice = { realm: 'r', user_id: 'alice', roles: ['operator'], username: 'alice', display_name: 'Alice', session_expires_at: '2099-01-01' }
const ref = `session-${'a'.repeat(32)}`
const headers = { cookie: 'lumo_auth_session=valid-login', 'x-lumo-auth-request': '1', 'content-type': 'application/json' }

group('two HTTP replicas with pinned Session routing', () => {
  const servers: Server[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map(closeAuthProxy)) })

  async function fixture() {
    const routes: Record<string, string> = {}
    const nodes = {
      'node-a': { realm: 'r', node_id: 'node-a', project_id: 'p', process_id: 'a-process', endpoint: '', fence: 1, expires_at: '2099-01-01' },
      'node-b': { realm: 'r', node_id: 'node-b', project_id: 'p', process_id: 'b-process', endpoint: '', fence: 1, expires_at: '2099-01-01' },
    }
    const owner = { session_ref: ref, realm: 'r', owner_user_id: 'alice', project_id: 'p', node_id: 'node-b', parent_session_ref: '', state: 'active', created_at: '2026-11-07' }
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://authority.example') return fetch(input, init)
      if (url.pathname.startsWith('/v1/session-owners/')) return new Response(JSON.stringify({ owner }))
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!) as keyof typeof nodes
      return new Response(JSON.stringify({ node: nodes[id] }))
    }
    const sourceSession = vi.fn(async (credential: string) => { if (credential !== 'valid-login') throw new GovernanceApiError(401, 'invalid_session', 'invalid'); return alice })
    const targetSession = vi.fn(async (credential: string) => { if (credential !== 'valid-login') throw new GovernanceApiError(401, 'invalid_session', 'invalid'); return alice })
    const sourceProject = vi.fn(async () => {})
    const targetProject = vi.fn(async () => {})
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const execute = vi.fn<AuthenticatedSessionTransport['execute']>(async () => ({ accepted: true }))
    const stream = vi.fn<AuthenticatedSessionTransport['stream']>(async () => (async function* () { yield { text: 'first' }; yield { text: 'second' } })())
    const local = (node: keyof typeof nodes): AuthenticatedSessionTransport => ({
      execute: node === 'node-b' ? execute : vi.fn(async () => { throw new Error('wrong owner node') }), stream,
      runtime: { processId: nodes[node].process_id, check: vi.fn(async () => {}) } as unknown as SessionExecutionRuntime,
    })
    const sourceLocal = local('node-a'), targetLocal = local('node-b')
    const options = (session: typeof sourceSession, authorizeSessionProject: typeof sourceProject, sessionTransport: AuthenticatedSessionTransport): AuthProxyOptions => ({
      host: '127.0.0.1', port: 0, secureCookie: false, clusterMode: true, realm: 'r', projectId: 'p',
      identityAssertionSecret: 'a'.repeat(32), upstreamPort: 1, serverRuntimeToken: 'service-secret',
      client: { session, authorizeSessionProject } as unknown as GovernanceAuthClient, logger, sessionTransport,
    })
    const sourceOptions = options(sourceSession, sourceProject, sourceLocal)
    const targetOptions = options(targetSession, targetProject, targetLocal)
    for (const [id, value] of [['node-a', sourceOptions], ['node-b', targetOptions]] as const) {
      const server = createAuthProxy(value)
      servers.push(server)
      routes[id] = `http://127.0.0.1:${await listenAuthProxy(server, '127.0.0.1', 0)}`
      nodes[id].endpoint = routes[id]!
    }
    const config = (nodeId: string): SessionTransportConfig => ({ authorityUrl: 'https://authority.example', nodeId, projectId: 'p', workspaceRoot: '/srv/sessions', provider: 'mock', model: 'mock', routing: { routes, transportSecurity: 'development' } })
    sourceOptions.sessionTransport = routeSessionTransport(sourceLocal, config('node-a'), 'r', 'service-secret', sourceProject, fetcher)
    targetOptions.sessionTransport = routeSessionTransport(targetLocal, config('node-b'), 'r', 'service-secret', targetProject, fetcher)
    const call = (action: string) => fetch(routes['node-a'] + '/lumo/sessions/' + action, { method: 'POST', headers, body: JSON.stringify({ sessionId: ref }) })
    return { call, execute, stream, sourceSession, targetSession, targetProject, nodes, logger }
  }

  it('re-authenticates on the owning replica and streams over both HTTP boundaries', async () => {
    const f = await fixture()
    const response = await f.call('cancel')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: true })
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls[0]?.[0]).toEqual(alice)
    expect(f.sourceSession.mock.calls.length).toBeGreaterThan(0)
    expect(f.targetSession.mock.calls.length).toBeGreaterThan(0)
    expect(f.targetSession.mock.calls.every(([credential]) => credential === 'valid-login')).toBe(true)
    expect(f.targetProject).toHaveBeenCalled()
    const stream = await f.call('follow')
    expect(stream.status).toBe(200)
    expect(await stream.text()).toBe('{"text":"first"}\n{"text":"second"}\n')
  })

  it('refuses a stale target process and hides downstream error text and credentials', async () => {
    const f = await fixture()
    f.nodes['node-b'].process_id = 'stale-process'
    expect((await f.call('cancel')).status).toBe(503)
    expect(f.execute).not.toHaveBeenCalled()
    f.nodes['node-b'].process_id = 'b-process'
    f.execute.mockRejectedValueOnce(new Error('downstream valid-login service-secret'))
    const response = await f.call('cancel')
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"session_execution_unavailable"}')
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toMatch(/valid-login|service-secret/)
  })

  it('stops forwarding frames when target-side login authorization is revoked', async () => {
    const f = await fixture()
    let next!: () => void
    let signal: AbortSignal | undefined
    f.stream.mockImplementationOnce(async (_principal, _action, _request, active) => {
      signal = active
      return (async function* () {
        yield { text: 'first' }
        await new Promise<void>(resolve => { next = resolve })
        yield { text: 'secret-after-revocation' }
      })()
    })
    const response = await f.call('follow')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"text":"first"}\n')
    f.targetSession.mockRejectedValueOnce(new Error('revoked'))
    next()
    await expect(reader.read()).rejects.toBeInstanceOf(Error)
    expect(signal?.aborted).toBe(true)
  })
})
