import { PassThrough, Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { computerUseHandler, registerComputerUseRoutes, type ComputerUseSnapshot } from '../src/computer-use-api.ts'

const initial: ComputerUseSnapshot = { enabled: false, phase: 'disabled', authorizedSessionId: null, ownerSessionId: null, startedAt: null, lastActivityAt: null, inFlight: 0, events: [] }
function fixture(platform: NodeJS.Platform = 'darwin', release = '23.0.0') {
  const browserPeer = {}
  const admit = vi.fn((): { peer: object } | { rejection: number } => ({ peer: browserPeer }))
  const service = { snapshot: vi.fn(() => initial), enable: vi.fn((sessionId: string) => ({ ...initial, enabled: true, authorizedSessionId: sessionId, phase: 'ready' as const })), stop: vi.fn(() => initial) }
  const cuaStatus = vi.fn()
  const services: Record<string, unknown> = { connection: { browserPeer, admit }, lumoComputerUse: service, webServer: { protocol: 'http:' }, computerUse: { providerName: 'dsh-cua' }, cuaAccess: { status: cuaStatus } }
  const ctx = { get: (name: string) => services[name] }
  const handler = computerUseHandler(ctx, true, platform, release)
  async function call(path = '', method = 'GET', value?: unknown, headers: Record<string, string | undefined> = {}) {
    const raw = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
    const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), { method, url: `/lumo/api/computer-use${path}`, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json', ...headers } }) as IncomingMessage
    return invoke(req)
  }
  async function invoke(req: IncomingMessage) {
    const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
    const res = { setHeader(name: string, value: string) { result.headers[name] = value }, writeHead(status: number) { result.status = status }, end(value: string) { result.body = JSON.parse(value) } } as unknown as ServerResponse
    await handler(req, res)
    return result
  }
  return { services, ctx, service, admit, cuaStatus, call, handler, invoke }
}

describe('local computer controls', () => {
  it('reads passive metadata and does not initialize native access', async () => {
    const test = fixture()
    expect(await test.call()).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' }, body: { ...initial, provider: 'dsh-cua', platform: 'darwin', nativeSupport: true } })
    expect(test.cuaStatus).not.toHaveBeenCalled()
    expect(test.service.enable).not.toHaveBeenCalled()
  })
  it('requires the actual upstream browser peer for reads and writes', async () => {
    const test = fixture()
    for (const admission of [{ rejection: 401 }, { rejection: 403 }, { peer: {} }]) {
      test.admit.mockReturnValue(admission)
      expect((await test.call()).status).toBe(admission.rejection ?? 403)
      expect((await test.call('/enable', 'POST', { sessionId: 'real-session', controlRevision: 0 })).status).toBe(admission.rejection ?? 403)
    }
    expect(test.service.snapshot).not.toHaveBeenCalled()
    expect(test.service.enable).not.toHaveBeenCalled()
    delete test.services['connection']
    expect((await test.call()).status).toBe(503)
  })
  it('requires same-origin JSON even after browser admission', async () => {
    const test = fixture()
    for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await test.call('/enable', 'POST', { sessionId: 'real-session', controlRevision: 0 }, headers)).status).toBe(403)
      expect((await test.call('/stop', 'POST', {}, headers)).status).toBe(403)
    }
    expect((await test.call('/enable', 'POST', { sessionId: 'real-session', controlRevision: 0 }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect(test.service.enable).not.toHaveBeenCalled()
    expect(test.service.stop).not.toHaveBeenCalled()
  })
  it('authorizes one explicit bounded session and accepts no operation arguments', async () => {
    const test = fixture()
    expect((await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 0 })).body).toMatchObject({ enabled: true, authorizedSessionId: 'session-1' })
    expect(test.service.enable).toHaveBeenCalledExactlyOnceWith('session-1')
    for (const input of [{}, { sessionId: '' }, { sessionId: 'bad\0id' }, { sessionId: 'a'.repeat(257) }, { sessionId: 'space id' }, { sessionId: 'session-1', action: 'click' }, [], null]) {
      expect((await test.call('/enable', 'POST', input)).status).toBe(400)
    }
    expect((await test.call('/stop', 'POST', { sessionId: 'session-1' })).status).toBe(400)
    expect((await test.call('/stop', 'POST', {})).status).toBe(200)
    expect(test.service.stop).toHaveBeenCalledOnce()
    expect((await test.call('/enable', 'POST', '{')).status).toBe(400)
    expect((await test.call('/enable', 'POST', 'a'.repeat(1025))).status).toBe(413)
  })
  it('preserves stopping and reports lease conflicts instead of claiming success', async () => {
    const test = fixture()
    test.service.stop.mockReturnValue({ ...initial, phase: 'stopping', ownerSessionId: 'session-1', inFlight: 1 })
    expect((await test.call('/stop', 'POST', {})).body).toMatchObject({ phase: 'stopping', inFlight: 1 })
    test.service.enable.mockImplementation(() => { throw Error('COMPUTER_USE_BUSY') })
    expect(await test.call('/enable', 'POST', { sessionId: 'session-2', controlRevision: 1 })).toMatchObject({ status: 409, body: { error: 'COMPUTER_USE_BUSY' } })
  })
  it('refuses unsupported providers and platforms while preserving stop access', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const test = fixture(platform)
      const providers = platform === 'darwin' ? [undefined, { providerName: 'mcp' }] : [{ providerName: 'dsh-cua' }]
      for (const provider of providers) {
        test.services['computerUse'] = provider
        const controlRevision = ((await test.call()).body as { controlRevision: number }).controlRevision
        expect(await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision })).toMatchObject({ status: 409, body: { error: 'computer_use_provider_unavailable' } })
        expect((await test.call('/stop', 'POST', {})).status).toBe(200)
      }
      expect(test.service.enable).not.toHaveBeenCalled()
    }
    const oldMac = fixture('darwin', '22.6.0')
    expect((await oldMac.call()).body).toMatchObject({ nativeSupport: false })
    expect(await oldMac.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 0 })).toMatchObject({ status: 409, body: { error: 'computer_use_provider_unavailable' } })
    expect(oldMac.service.enable).not.toHaveBeenCalled()
    expect((await oldMac.call('/stop', 'POST', {})).status).toBe(200)
  })
  it('invalidates a delayed enable body when stop completes first, then permits a fresh explicit authorization', async () => {
    const test = fixture()
    expect((await test.call()).body).toMatchObject({ controlRevision: 0 })
    const delayed = Object.assign(new PassThrough(), { method: 'POST', url: '/lumo/api/computer-use/enable', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' } })
    const enabling = test.invoke(delayed as IncomingMessage)
    expect(await test.call('/stop', 'POST', {})).toMatchObject({ status: 200, body: { enabled: false, controlRevision: 1 } })
    delayed.end(JSON.stringify({ sessionId: 'session-1', controlRevision: 0 }))
    expect(await enabling).toMatchObject({ status: 409, body: { error: 'computer_use_control_conflict', controlRevision: 1 } })
    expect(test.service.enable).not.toHaveBeenCalled()
    expect((await test.call()).body).toMatchObject({ enabled: false, controlRevision: 1 })
    expect(await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 1 })).toMatchObject({ status: 200, body: { enabled: true, controlRevision: 2 } })
    expect(test.service.enable).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 1 })).toMatchObject({ status: 409, body: { error: 'computer_use_control_conflict' } })
    expect(test.service.enable).toHaveBeenCalledOnce()
    expect(await test.call('/stop', 'POST', {})).toMatchObject({ status: 200, body: { enabled: false, controlRevision: 3 } })
  })
  it('admits only an available isolated Windows worker and preserves stop during quarantine', async () => {
    const test = fixture('win32')
    test.services['computerUse'] = { providerName: 'lumo-cua-windows' }
    expect((await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 0 })).status).toBe(409)
    test.services['lumoWindowsComputerUse'] = { available: true }
    expect(await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 0 })).toMatchObject({ status: 200, body: { provider: 'lumo-cua-windows', nativeSupport: true } })
    test.services['lumoWindowsComputerUse'] = { available: false }
    expect(await test.call()).toMatchObject({ status: 200, body: { nativeSupport: false } })
    expect((await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 1 })).status).toBe(409)
    expect((await test.call('/stop', 'POST', {})).status).toBe(200)
  })
  it('requires an explicit valid revision and refuses unknown authorization fields', async () => {
    const test = fixture()
    for (const controlRevision of [undefined, -1, 1.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision })).status).toBe(400)
    }
    expect((await test.call('/enable', 'POST', { sessionId: 'session-1', controlRevision: 0, command: 'click' })).status).toBe(400)
    expect(test.service.enable).not.toHaveBeenCalled()
  })
  it('registers its own prefix with local-only policy and removes it on disposal', async () => {
    const test = fixture()
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const effects: Array<() => void> = []
    registerComputerUseRoutes({ ...test.ctx, webServer: { register }, effect: (effect: () => () => void) => { effects.push(effect()) } } as never, false)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ kind: 'prefix', path: '/lumo/api/computer-use' })
    const handler = register.mock.calls[0]![0]!.handler
    const end = vi.fn()
    const writeHead = vi.fn()
    await handler({} as IncomingMessage, { setHeader: vi.fn(), writeHead, end } as unknown as ServerResponse)
    expect(writeHead).toHaveBeenCalledWith(404)
    expect(test.admit).not.toHaveBeenCalled()
    effects.forEach(effect => effect())
    expect(dispose).toHaveBeenCalledOnce()
  })
})
