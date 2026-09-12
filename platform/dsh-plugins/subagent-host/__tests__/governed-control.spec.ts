import { expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createSubagentHost } from '../src/server.ts'

async function request(path: string, token = 'service') {
  const stopGoverned = vi.fn()
  const start = vi.fn()
  const server = createSubagentHost({ host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
    tokens: new Map([['realm', 'service']]), callbackOrigins: new Set(), governedOnly: true,
    runs: new Map(), sessionExists: () => false, start, stopGoverned,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } })
  const req = Readable.from([Buffer.from(JSON.stringify({ childId: 'run-1' }))]) as IncomingMessage
  req.method = 'POST'; req.url = path
  req.headers = { 'x-lumo-realm': 'realm', 'x-lumo-seam-token': token }
  let status = 0
  await new Promise<void>(resolve => {
    const res = { writeHead(code: number) { status = code }, end() { resolve() } } as unknown as ServerResponse
    server.emit('request', req, res)
  })
  return { status, start, stopGoverned }
}

it('routes authenticated stop requests to the governed executor', async () => {
  const result = await request('/subagent/stop')
  expect(result.status).toBe(200)
  expect(result.stopGoverned).toHaveBeenCalledWith('realm', 'run-1')
})
it('rejects unauthenticated cancellation and direct start on a pinned Worker', async () => {
  const stopped = await request('/subagent/stop', 'wrong')
  expect(stopped.status).toBe(403)
  expect(stopped.stopGoverned).not.toHaveBeenCalled()
  const started = await request('/subagent/start')
  expect(started.status).toBe(403)
  expect(started.start).not.toHaveBeenCalled()
})
