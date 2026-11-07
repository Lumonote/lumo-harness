import { describe, expect, it, vi } from 'vitest'
import { createSessionTransport } from '../src/session-transport.ts'
import { SessionMeterRegistry } from '../../../shared/seam-contracts/meter-attribution.ts'
import { SessionOwnerClient } from '../../../shared/session-owners.ts'
const ref = `session-${'a'.repeat(32)}`
const owner = { session_ref: ref, realm: 'r', owner_user_id: 'alice', project_id: 'p', node_id: 'n', parent_session_ref: '', state: 'active', created_at: '2026-11-06' }
const alice = { realm: 'r', user_id: 'alice', roles: ['operator'], username: 'alice', display_name: 'Alice', session_expires_at: '2099-01-01' }
function harness(fact = owner) {
  const grants: { policy?: { bindings(p: { requestId: string }): unknown[] } } = {}
  const dispose = vi.fn(async () => {})
  const createPeer = vi.fn(({ principal }) => ({ principal, dispose, signal: new AbortController().signal }))
  const invoke = vi.fn(async request => {
    expect(request.peer.principal.kind).toBe('lumo-user')
    expect(grants.policy?.bindings(request.peer.principal)).toHaveLength(1)
    return { cursor: 2 }
  })
  const stream = vi.fn(async () => (async function* () { yield { cursor: 2 } })())
  const ctx = {
    get: (key: string) => ({ connection: { createPeer }, typertGateway: { invoke, stream }, remoteAccess: { registerPolicy: (_k: string, policy: never) => { grants.policy = policy; return () => {} } },
      meteringScope: new SessionMeterRegistry(), sessionPersistence: { stat: vi.fn(async () => undefined) }, sessionQuery: {}, agents: {} } as Record<string, unknown>)[key],
    on: vi.fn(), effect: vi.fn(), agents: { get: vi.fn(() => undefined), create: vi.fn() }, sessions: { get: vi.fn() },
  }
  const authorize = vi.fn(async () => {})
  const fetcher = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(JSON.stringify({ owner: fact }), { status: 200 }))
  const transport = createSessionTransport(ctx as never, { authorityUrl: 'http://authority', nodeId: 'n', projectId: 'p', workspaceRoot: '/tmp/lumo-owned-tests', provider: 'p', model: 'm' }, 'secret', authorize, fetcher as typeof fetch)
  return { ctx, transport, createPeer, invoke, stream, dispose, authorize, fetcher, grants }
}
describe('authenticated Session Gateway transport', () => {
  it('uses current owner fact and a non-owner Peer, then revokes its grants', async () => {
    const h = harness()
    await expect(h.transport.execute(alice, 'state', { sessionId: ref }, new AbortController().signal)).resolves.toEqual({ cursor: 2 })
    expect(h.authorize).toHaveBeenCalledWith(alice)
    const principal = h.createPeer.mock.calls[0]![0].principal
    expect(principal).toEqual(expect.objectContaining({ kind: 'lumo-user', userId: 'alice', realm: 'r' }))
    expect(h.grants.policy!.bindings(principal)).toEqual([])
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.fetcher.mock.calls[0]![0]).toContain(`/v1/session-owners/${ref}?realm=r`)
  })
  it.each([{ ...owner, owner_user_id: 'bob' }, { ...owner, realm: 'other' }, { ...owner, project_id: 'other' }, { ...owner, node_id: 'other' }, { ...owner, state: 'reserved' }])('denies a foreign or uncommitted owner before dispatch', async fact => {
    const h = harness(fact)
    await expect(h.transport.execute(alice, 'prompt', { sessionId: ref }, new AbortController().signal)).rejects.toThrow()
    expect(h.invoke).not.toHaveBeenCalled()
    expect(h.createPeer).not.toHaveBeenCalled()
  })
  it('does not expose owner-claim, caller-chosen creation identity, fork, tools, or host operations', async () => {
    const h = harness()
    for (const [action, request] of [['create', { sessionId: ref }], ['create', { cwd: '/private' }], ['create', { parentSessionId: ref }], ['fork', { sessionId: ref }], ['openWorkspacePath', { path: '/' }], ['attachment', { sessionId: ref }]] as const) {
      await expect(h.transport.execute(alice, action, request, new AbortController().signal)).rejects.toThrow()
    }
    expect(h.invoke).not.toHaveBeenCalled()
    expect(h.ctx.agents.create).not.toHaveBeenCalled()
  })
  it('denies forged child addresses and unscoped session calls', async () => {
    const h = harness()
    for (const request of [{}, { address: { kind: 'subagent', childSessionId: ref } }, { sessionId: ref, address: { kind: 'session', sessionId: ref } }]) {
      await expect(h.transport.execute(alice, 'state', request, new AbortController().signal)).rejects.toThrow()
    }
    expect(h.fetcher).not.toHaveBeenCalled()
  })
  it('releases Peer on stream completion and refuses unauthorized methods', async () => {
    const h = harness()
    const source = await h.transport.stream(alice, 'observeState', { sessionId: ref }, new AbortController().signal)
    expect(h.dispose).not.toHaveBeenCalled()
    for await (const _ of source) { /* consume */ }
    expect(h.dispose).toHaveBeenCalledOnce()
    await expect(h.transport.stream(alice, '$events', {}, new AbortController().signal)).rejects.toThrow()
  })
  it('fails closed on current project revocation and unprepared live agents', async () => {
    const h = harness()
    h.authorize.mockRejectedValueOnce(new Error('revoked'))
    await expect(h.transport.execute(alice, 'state', { sessionId: ref }, new AbortController().signal)).rejects.toThrow('revoked')
    h.ctx.agents.get.mockReturnValueOnce({} as never)
    await expect(h.transport.execute(alice, 'state', { sessionId: ref }, new AbortController().signal)).rejects.toThrow('predates')
    expect(h.invoke).not.toHaveBeenCalled()
  })
  it('lists only the current project while retaining the authority pagination cursor', async () => {
    const h = harness()
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ owners: [owner, { ...owner, session_ref: `session-${'b'.repeat(32)}`, project_id: 'other' }], next_cursor: 'authority-cursor' })))
    await expect(h.transport.execute(alice, 'list', {}, new AbortController().signal)).resolves.toEqual({ owners: [owner], next_cursor: 'authority-cursor' })
    expect(h.createPeer).not.toHaveBeenCalled()
  })
})
describe('owner client trust boundary', () => {
  it('does not send credentials through redirects or accept a changed reservation scope', async () => {
    const fetcher = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(JSON.stringify({ owner: { ...owner, state: 'reserved', owner_user_id: 'attacker' }, creation_token: 'a'.repeat(64) })))
    const client = new SessionOwnerClient('http://owner', 'secret', fetcher as typeof fetch)
    await expect(client.reserve({ realm: 'r', owner_user_id: 'alice', project_id: 'p', node_id: 'n', parent_session_ref: '' })).rejects.toThrow('scope mismatch')
    expect(fetcher.mock.calls[0]![1]).toEqual(expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer secret' }) }))
    expect(() => new SessionOwnerClient('http://user:pass@owner', 'secret')).toThrow()
  })
})
