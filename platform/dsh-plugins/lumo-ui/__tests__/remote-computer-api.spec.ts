import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { remoteComputerHandler, registerRemoteComputerRoutes } from '../src/remote-computer-api.ts'

const id = 'a'.repeat(43), digest = 'sha256:' + 'b'.repeat(64)
function fixture(local = true) {
  const browserPeer = {}
  const admit = vi.fn((): { peer: object } | { rejection: number } => ({ peer: browserPeer }))
  const service = { list: vi.fn(async () => [{ envelope: { request_id: id, digest }, state: 'pending' }]), decide: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
  const services: Record<string, unknown> = { connection: { browserPeer, admit }, lumoRemoteComputerUse: service, webServer: { protocol: 'http:' } }
  const ctx = { get: vi.fn((name: string) => services[name]) }, handler = remoteComputerHandler(ctx, local)
  async function call(suffix = '', method = 'GET', body?: unknown, headers: Record<string, string | undefined> = {}) {
    const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
    const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url: '/lumo/api/remote-computer' + suffix, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json', ...headers } }) as IncomingMessage
    const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
    const res = { setHeader(name: string, value: string) { result.headers[name] = value }, writeHead(status: number) { result.status = status }, end(value: string) { result.body = JSON.parse(value) } } as unknown as ServerResponse
    await handler(req, res)
    return result
  }
  return { services, ctx, service, admit, call }
}

describe('local decisions for remote computer requests', () => {
  it('reads the local request list without granting or executing authority', async () => {
    const f = fixture()
    expect(await f.call()).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: { requests: [{ envelope: { request_id: id, digest }, state: 'pending' }] } })
    expect(f.service.decide).not.toHaveBeenCalled(); expect(f.service.revoke).not.toHaveBeenCalled()
  })

  it('requires the exact admitted browser peer for both reads and mutations', async () => {
    const f = fixture()
    for (const admission of [{ rejection: 401 }, { rejection: 403 }, { peer: {} }]) {
      f.admit.mockReturnValue(admission)
      expect((await f.call()).status).toBe(admission.rejection ?? 403)
      expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: true })).status).toBe(admission.rejection ?? 403)
      expect((await f.call(`/${id}/revoke`, 'POST', { digest })).status).toBe(admission.rejection ?? 403)
    }
    expect(f.service.list).not.toHaveBeenCalled(); expect(f.service.decide).not.toHaveBeenCalled(); expect(f.service.revoke).not.toHaveBeenCalled()
    delete f.services.connection
    expect((await f.call()).status).toBe(503)
  })

  it('is unavailable outside the local desktop without consulting browser credentials', async () => {
    const f = fixture(false)
    expect(await f.call()).toMatchObject({ status: 404, body: { error: 'remote_computer_local_only' } })
    expect(f.ctx.get).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled()
  })

  it('requires exact same-origin JSON after browser admission', async () => {
    const f = fixture()
    for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: true }, headers)).status).toBe(403)
      expect((await f.call(`/${id}/revoke`, 'POST', { digest }, headers)).status).toBe(403)
    }
    expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: true }, { 'content-type': 'text/plain' })).status).toBe(415)
    f.services.webServer = { protocol: undefined }
    expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: true })).status).toBe(403)
    expect(f.service.decide).not.toHaveBeenCalled(); expect(f.service.revoke).not.toHaveBeenCalled()
  })

  it('passes only the current exact digest and explicit approve, deny or revoke decision', async () => {
    const f = fixture()
    expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: true })).status).toBe(200)
    expect(f.service.decide).toHaveBeenNthCalledWith(1, id, { digest, approve: true })
    expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: false }, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200)
    expect(f.service.decide).toHaveBeenNthCalledWith(2, id, { digest, approve: false })
    expect((await f.call(`/${id}/revoke`, 'POST', { digest })).status).toBe(200)
    expect(f.service.revoke).toHaveBeenCalledExactlyOnceWith(id, digest)
    expect(f.service.list).toHaveBeenCalledTimes(3)
  })

  it.each(['owner_user_id', 'session_ref', 'realm', 'project_id', 'node_id', 'capability', 'command', 'url'])('refuses injected %s instead of forwarding authority', async key => {
    const f = fixture()
    expect((await f.call(`/${id}/decide`, 'POST', { digest, approve: true, [key]: 'forged' })).status).toBe(400)
    expect((await f.call(`/${id}/revoke`, 'POST', { digest, [key]: 'forged' })).status).toBe(400)
    expect(f.service.decide).not.toHaveBeenCalled(); expect(f.service.revoke).not.toHaveBeenCalled()
  })

  it.each([{}, null, [], { digest }, { digest, approve: 'true' }, { digest: 'b'.repeat(64), approve: true }, { digest: 'sha256:' + 'B'.repeat(64), approve: true }, { digest: digest + '0', approve: true }])('rejects a malformed decision %j', async input => {
    const f = fixture()
    expect((await f.call(`/${id}/decide`, 'POST', input)).status).toBe(400)
    expect(f.service.decide).not.toHaveBeenCalled()
  })

  it('bounds body parsing, exact endpoint IDs and allowed methods', async () => {
    const f = fixture()
    expect((await f.call(`/${id}/decide`, 'POST', '{')).status).toBe(400)
    expect((await f.call(`/${id}/decide`, 'POST', 'x'.repeat(1025))).status).toBe(413)
    expect((await f.call('/' + 'a'.repeat(42) + '/decide', 'POST', { digest, approve: true })).status).toBe(404)
    expect((await f.call(`/${id}/run`, 'POST', { digest, approve: true })).status).toBe(404)
    expect(await f.call('', 'POST', {})).toMatchObject({ status: 405, headers: { allow: 'GET' } })
    expect(await f.call(`/${id}/decide`, 'GET')).toMatchObject({ status: 405, headers: { allow: 'POST' } })
    expect(f.service.decide).not.toHaveBeenCalled()
  })

  it('reports stale or unknown results once without retrying or leaking internal errors', async () => {
    const f = fixture()
    f.service.decide.mockRejectedValueOnce(Error('stale digest: control-plane-secret'))
    expect(await f.call(`/${id}/decide`, 'POST', { digest, approve: true })).toMatchObject({ status: 409, body: { error: 'remote_computer_decision_uncertain' } })
    expect(f.service.decide).toHaveBeenCalledTimes(1); expect(f.service.list).not.toHaveBeenCalled()
    f.service.list.mockRejectedValueOnce(Error('reply lost after revoke committed'))
    expect(await f.call(`/${id}/revoke`, 'POST', { digest })).toMatchObject({ status: 409, body: { error: 'remote_computer_decision_uncertain' } })
    expect(f.service.revoke).toHaveBeenCalledTimes(1)
    expect((await f.call()).status).toBe(200)
    expect(f.service.revoke).toHaveBeenCalledTimes(1)
  })

  it('registers and disposes the local-only route independently', async () => {
    const f = fixture(), dispose = vi.fn(), register = vi.fn(() => dispose), effects: Array<() => void> = []
    registerRemoteComputerRoutes({ ...f.ctx, webServer: { register }, effect: (effect: () => () => void) => { effects.push(effect()) } } as never, true)
    expect(register.mock.calls[0]![0]).toMatchObject({ kind: 'prefix', path: '/lumo/api/remote-computer' })
    effects.forEach(effect => effect()); expect(dispose).toHaveBeenCalledOnce()
  })
})
