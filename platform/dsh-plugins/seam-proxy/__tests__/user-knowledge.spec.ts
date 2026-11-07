import { afterEach, describe, expect, it, vi } from 'vitest'
import { SeamProxyClient } from '../src/client.ts'
import { Balancer } from '../src/balancer.ts'
import { verifyIdentityAssertion, SEAM_IDENTITY_AUDIENCE } from '../../../shared/seam-contracts/identity.ts'

const secret = 'identity-root-that-is-longer-than-thirty-two-bytes'
const request = { projectId: 'project', text: 'question', topK: 3 }
const signal = new AbortController().signal
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('SeamProxy current-user published knowledge requests', () => {
  it('signs concurrent user requests separately and retains the deployment identity', async () => {
    const received: Array<{ principal: unknown; query: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      received.push({ principal: verifyIdentityAssertion(init.headers as Record<string, string>, { audience: SEAM_IDENTITY_AUDIENCE, secret }), query: JSON.parse(String(init.body)).args[0] })
      return new Response(JSON.stringify({ ok: true, value: [] }))
    }))
    const client = new SeamProxyClient({ endpoints: ['http://seam'], realm: 'r', userId: 'deployment-admin', roles: ['admin'], identityAssertionSecret: secret })
    await Promise.all([
      client.queryKnowledgeAs({ realm: 'r', userId: 'alice', roles: ['viewer'] }, request, signal),
      client.queryKnowledgeAs({ realm: 'r', userId: 'bob', roles: ['editor'] }, request, signal),
    ])
    await client.call('knowledge', 'query', [{ realm: 'r', userId: 'deployment-admin', roles: ['admin'], text: 'ordinary', topK: 1, scope: 'published' }])
    expect(received.map(call => call.principal)).toEqual([
      { realm: 'r', userId: 'alice', roles: ['viewer'] }, { realm: 'r', userId: 'bob', roles: ['editor'] }, { realm: 'r', userId: 'deployment-admin', roles: ['admin'] },
    ])
    expect(received[0]!.query).toMatchObject({ userId: 'alice', roles: ['viewer'], projectId: 'project', scope: 'published', libraryAdmin: false })
    expect(received[1]!.query).toMatchObject({ userId: 'bob', roles: ['editor'], projectId: 'project', scope: 'published', libraryAdmin: false })
  })
  it('rejects unsigned fallback and a different realm before sending a query', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const unsigned = new SeamProxyClient({ endpoints: ['http://seam'], realm: 'r' })
    await expect(unsigned.queryKnowledgeAs({ realm: 'r', userId: 'alice', roles: ['viewer'] }, request, signal)).rejects.toMatchObject({ code: 'forbidden' })
    const signed = new SeamProxyClient({ endpoints: ['http://seam'], realm: 'r', roles: ['admin'], identityAssertionSecret: secret })
    await expect(signed.queryKnowledgeAs({ realm: 'other', userId: 'alice', roles: ['viewer'] }, request, signal)).rejects.toMatchObject({ code: 'forbidden' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cancels a current-user query without changing later caller identity', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })))
    const client = new SeamProxyClient({ endpoints: ['http://seam'], realm: 'r', roles: ['admin'], identityAssertionSecret: secret })
    const abort = new AbortController()
    const pending = client.queryKnowledgeAs({ realm: 'r', userId: 'alice', roles: ['viewer'] }, request, abort.signal)
    abort.abort(new Error('login revoked'))
    await expect(pending).rejects.toThrow('login revoked')
    expect(client.callerRoles()).toEqual(['admin'])
  })
  it('releases a canceled recovery probe without healing or poisoning shared endpoint health', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('upstream unavailable'))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, value: [] })))
    vi.stubGlobal('fetch', fetcher)
    const client = new SeamProxyClient({ endpoints: ['http://seam'], realm: 'r', roles: ['admin'], identityAssertionSecret: secret, failureThreshold: 1, openForMs: 100, maxAttempts: 1 })
    const principal = { realm: 'r', userId: 'alice', roles: ['viewer'] }
    await expect(client.queryKnowledgeAs(principal, request, signal)).rejects.toBeDefined()
    expect(client.health()[0]!.state).toBe('open')
    now += 200
    const abort = new AbortController()
    const pending = client.queryKnowledgeAs(principal, request, abort.signal)
    expect(client.health()[0]!.state).toBe('half-open')
    abort.abort(new Error('login revoked'))
    await expect(pending).rejects.toThrow('login revoked')
    expect(client.health()[0]!.state).toBe('open')
    await expect(client.queryKnowledgeAs(principal, request, signal)).resolves.toEqual([])
    expect(client.health()[0]!.state).toBe('closed')
  })
  it('does not let a stale canceled call release another request recovery probe', () => {
    let now = 1000
    const balancer = new Balancer({ endpoints: ['http://seam'], failureThreshold: 1, openForMs: 100, now: () => now })
    const ordinary = balancer.acquire()!
    balancer.fail(ordinary.url); now += 200
    const first = balancer.acquire()!
    ordinary.release()
    expect(balancer.health()[0]!.state).toBe('half-open')
    first.release()
    const second = balancer.acquire()!
    first.release()
    expect(balancer.health()[0]!.state).toBe('half-open')
    second.release()
    expect(balancer.health()[0]!.state).toBe('open')
  })
})
