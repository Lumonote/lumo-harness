import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeviceActionsClient } from '../src/device-actions.ts'
import { handleEnvironmentRoute } from '../src/environment-api.ts'

async function call(path: string, headers: IncomingMessage['headers'] = { host: '127.0.0.1:3080' }, method = 'GET', raw = '{}') {
  const environment = vi.fn(async () => ({ status: 200, body: { available: true } }))
  const req = { headers, method } as IncomingMessage
  let status = 0, body: unknown
  const res = { writeHead(code: number) { status = code }, end(raw: string) { body = JSON.parse(raw) } } as ServerResponse
  const handled = await handleEnvironmentRoute(req, res, `/lumo/api/environment${path}`, { client: { environment } as unknown as DeviceActionsClient, readBody: async () => Buffer.from(raw) })
  return { environment, status, body, handled }
}
describe('local environment bridge boundary', () => {
  it.each([{ host: 'remote.example.com' }, { host: '127.0.0.1:3080', origin: 'https://remote.example.com' }, { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' }])('rejects nonlocal / cross-origin callers %s', async headers => {
    const out = await call('/device/activate', headers, 'POST')
    expect(out.status).toBe(403); expect(out.environment).not.toHaveBeenCalled()
  })
  it('relays only explicit device actions from the authenticated local origin', async () => {
    const out = await call('/device/pause', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, 'POST')
    expect(out.status).toBe(200); expect(out.environment).toHaveBeenCalledWith('POST', '/device/pause', {})
    const invalid = await call('/device/shell', undefined, 'POST')
    expect(invalid.status).toBe(404); expect(invalid.environment).not.toHaveBeenCalled()
  })
  it('rejects activation with GET and oversized or invalid bodies', async () => {
    expect((await call('/device/activate')).status).toBe(405)
    expect((await call('/device/activate', undefined, 'POST', 'invalid')).status).toBe(400)
    expect((await call('/device/activate', undefined, 'POST', JSON.stringify({ code: 'a'.repeat(20_000) }))).status).toBe(400)
  })
})
