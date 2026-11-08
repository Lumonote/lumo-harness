import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import * as Connection from '../../../../deepseek-harness/packages/client/connection/src/index.ts'
import { provideBrowserCredentials } from '../../../../deepseek-harness/packages/client/connection/tests/browser-credentials.ts'
import { computerUseHandler, type ComputerUseSnapshot } from '../src/computer-use-api.ts'

const authority = '127.0.0.1:3080'
function req(path: string, cookie?: string, method = 'GET', origin = `http://${authority}`): IncomingMessage {
  return Object.assign(Readable.from(method === 'POST' ? [Buffer.from('{"sessionId":"session-1","controlRevision":0}')] : []), {
    method, url: path, headers: { host: authority, origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
  }) as IncomingMessage
}
function response() {
  const result = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = { setHeader(name: string, value: string) { result.headers[name] = value }, writeHead(status: number, headers?: Record<string, string>) { result.status = status; Object.assign(result.headers, headers) }, end(value?: string) { result.body = value ?? '' } } as unknown as ServerResponse
  return { res, result }
}

it('accepts a real signed upstream browser cookie and rejects launch tokens, tampering, and API operator cookies', async () => {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  ctx.provide('webServer', { protocol: 'http:', host: '127.0.0.1', port: 3080, register: () => () => {}, tapIndex: () => () => {} } as never)
  const fiber = ctx.plugin({ inject: [...Connection.inject], apply: Connection.apply })
  try {
    await fiber.await()
    const connection = ctx.get('connection')!
    const snapshot: ComputerUseSnapshot = { enabled: false, phase: 'disabled', authorizedSessionId: null, ownerSessionId: null, startedAt: null, lastActivityAt: null, inFlight: 0, events: [] }
    const enable = vi.fn(() => ({ ...snapshot, phase: 'ready' as const, enabled: true, authorizedSessionId: 'session-1' }))
    ctx.provide('lumoComputerUse', { snapshot: () => snapshot, enable, stop: () => snapshot } as never)
    ctx.provide('computerUse', { providerName: 'dsh-cua' } as never)
    const handler = computerUseHandler(ctx, true, 'darwin', '23.0.0')
    async function check(request: IncomingMessage, status: number) {
      const reply = response()
      await handler(request, reply.res)
      expect(reply.result.status).toBe(status)
    }
    await check(req('/lumo/api/computer-use/enable', undefined, 'POST'), 401)
    const launch = new URL(connection.authenticatedUrl(`http://${authority}`))
    await check(req(`/lumo/api/computer-use/enable${launch.search}`, undefined, 'POST'), 401)
    const exchange = response()
    connection.authorizeIndex(req(`${launch.pathname}${launch.search}`), exchange.res)
    const cookie = exchange.result.headers['set-cookie']?.split(';')[0]
    expect(cookie).toBeTruthy()
    await check(req('/lumo/api/computer-use/enable', `${cookie!}!`, 'POST'), 401)
    await check(req('/lumo/api/computer-use/enable', cookie, 'POST', 'https://attacker.test'), 403)
    const apiLaunch = new URL(connection.authenticatedUrl(`http://${authority}/connect`))
    const apiExchange = response()
    connection.authorizeConnect(req(`${apiLaunch.pathname}${apiLaunch.search}`), apiExchange.res)
    const apiCookie = apiExchange.result.headers['set-cookie']?.split(';')[0]
    expect(apiCookie).toBeTruthy()
    expect(connection.admit(req('/lumo/api/computer-use', apiCookie))).toHaveProperty('peer')
    await check(req('/lumo/api/computer-use/enable', apiCookie, 'POST'), 403)
    expect(enable).not.toHaveBeenCalled()
    await check(req('/lumo/api/computer-use/enable', cookie, 'POST'), 200)
    expect(enable).toHaveBeenCalledExactlyOnceWith('session-1')
  } finally { await fiber.dispose(); await ctx.fiber.dispose() }
})
