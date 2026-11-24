import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleAsksRoute } from '../src/asks-api.ts'

function fakeRes() {
  const out = { status: 0, body: '' }
  const res = { writeHead: (s: number) => { out.status = s; return res }, end: (b?: string) => { out.body = b ?? '' }, write: () => true } as unknown as ServerResponse
  return { res, out }
}
const deps = { connectorUrl: 'http://connector.invalid', headers: {}, timeoutMs: 10, readBody: async () => Buffer.from('{}') }

describe('handleAsksRoute', () => {
  it('ignores unrelated paths', async () => {
    const { res } = fakeRes()
    expect(await handleAsksRoute({ method: 'GET', url: '/x' } as IncomingMessage, res, '/lumo/api/connectors', deps)).toBe(false)
  })
  it('rejects malformed ask ids before calling upstream', async () => {
    const { res, out } = fakeRes()
    expect(await handleAsksRoute({ method: 'POST', url: '' } as IncomingMessage, res, '/lumo/api/asks/a%20b/answer', deps)).toBe(true)
    expect(out.status).toBe(400)
  })
  it('reports 503 when connector is not configured', async () => {
    const { res, out } = fakeRes()
    await handleAsksRoute({ method: 'GET', url: '/lumo/api/asks' } as IncomingMessage, res, '/lumo/api/asks', { ...deps, connectorUrl: '' })
    expect(out.status).toBe(503)
  })
})
