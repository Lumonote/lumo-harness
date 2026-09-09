import { createHash } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createCallbackServer, type PendingEntry } from '../src/callback.ts'
import type { CallbackInbox, CallbackRegistration } from '../../../shared/subagent-receipts.ts'
import type { ChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'

const secret = '0123456789abcdef'
const body: ChildResultBody = { runId: 'child', ok: true, stopReason: 'completed', output: [{ type: 'text', text: 'verified result' }] }
const secretHash = createHash('sha256').update(secret).digest('hex')

function inbox() {
  const rows = new Map<string, CallbackRegistration>()
  const key = (realm: string, runId: string) => JSON.stringify([realm, runId])
  const store: CallbackInbox = {
    register: vi.fn(async (realm, runId, entry) => { rows.set(key(realm, runId), structuredClone(entry)) }),
    get: vi.fn(async (realm, runId) => rows.get(key(realm, runId))),
    put: vi.fn(async (realm, receipt) => { rows.set(key(realm, receipt.body.runId), structuredClone(receipt)) }),
  }
  return store
}

// Exercise the real HTTP request handler without needing a listening socket.
function post(server: Server, value: ChildResultBody, token = secret): Promise<{ status: number; body: unknown }> {
  return new Promise(resolve => {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]) as IncomingMessage
    req.method = 'POST'
    req.url = `/subagent/result/child/${token}`
    let status = 0
    const res = {
      headersSent: false,
      writeHead(code: number) { status = code; this.headersSent = true },
      end(raw: string) { resolve({ status, body: JSON.parse(raw) }) },
    } as unknown as ServerResponse
    server.emit('request', req, res)
  })
}

describe('durable child result acknowledgment', () => {
  it('keeps the result pending until Scheduler confirms, then accepts identical replays', async () => {
    const receipts = inbox()
    const settler = vi.fn()
    const pending = new Map<string, PendingEntry>([['child', { secret, attempt: 3, settler }]])
    const reportTerminal = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const server = createCallbackServer({ realm: 'realm', receipts, pending, reportTerminal })

    expect((await post(server, body)).status).toBe(503)
    expect(settler).not.toHaveBeenCalled()
    expect(pending.has('child')).toBe(true)
    expect(await receipts.get('realm', 'child')).toEqual({ secretHash, body, attempt: 3 })

    expect((await post(server, body)).status).toBe(200)
    expect((await post(server, JSON.parse(JSON.stringify(body)))).status).toBe(200)
    expect(settler).toHaveBeenCalledExactlyOnceWith(body)
    expect(reportTerminal).toHaveBeenLastCalledWith(body, 3)
    expect(pending.size).toBe(0)
  })

  it('recovers a registration after parent restart before the first callback', async () => {
    const receipts = inbox()
    await receipts.register('realm', 'child', { secretHash, attempt: 4 })
    const reportTerminal = vi.fn()
    const restarted = createCallbackServer({ realm: 'realm', receipts, pending: new Map(), reportTerminal })
    expect((await post(restarted, body)).status).toBe(200)
    expect(reportTerminal).toHaveBeenCalledExactlyOnceWith(body, 4)
    expect(await receipts.get('realm', 'child')).toMatchObject({ body })
  })

  it('survives restart after receipt storage but before Scheduler confirmation', async () => {
    const receipts = inbox()
    const first = createCallbackServer({ realm: 'realm', receipts,
      pending: new Map([['child', { secret, attempt: 5, settler: vi.fn() }]]),
      reportTerminal: vi.fn().mockRejectedValue(new Error('offline')),
    })
    expect((await post(first, body)).status).toBe(503)
    const reportTerminal = vi.fn()
    const restarted = createCallbackServer({ realm: 'realm', receipts, pending: new Map(), reportTerminal })
    expect((await post(restarted, body)).status).toBe(200)
    expect(reportTerminal).toHaveBeenCalledExactlyOnceWith(body, 5)
  })

  it('rejects changed results, wrong capabilities and other realms without settling', async () => {
    const receipts = inbox()
    await receipts.put('realm', { secretHash, body, attempt: 2 })
    const reportTerminal = vi.fn()
    const server = createCallbackServer({ realm: 'realm', receipts, pending: new Map(), reportTerminal })
    expect((await post(server, { ...body, stopReason: 'error' })).status).toBe(409)
    expect((await post(server, body, 'different-secret')).status).toBe(404)
    expect((await post(server, { ...body, runId: 'another-child' })).status).toBe(404)
    const otherRealm = createCallbackServer({ realm: 'other', receipts, pending: new Map(), reportTerminal })
    expect((await post(otherRealm, body)).status).toBe(404)
    expect(reportTerminal).not.toHaveBeenCalled()
  })

  it('serializes concurrent callback replay and settles the parent once', async () => {
    const settler = vi.fn()
    const pending = new Map([['child', { secret, attempt: 1, settler }]])
    const server = createCallbackServer({ realm: 'realm', receipts: inbox(), pending, reportTerminal: vi.fn() })
    const replies = await Promise.all(Array.from({ length: 8 }, () => post(server, body)))
    expect(replies.every(reply => reply.status === 200)).toBe(true)
    expect(settler).toHaveBeenCalledExactlyOnceWith(body)
  })

  it('does not acknowledge or release the parent when receipt persistence fails', async () => {
    const receipts = inbox()
    vi.mocked(receipts.put).mockRejectedValue(new Error('database offline'))
    const settler = vi.fn()
    const reportTerminal = vi.fn()
    const pending = new Map([['child', { secret, attempt: 1, settler }]])
    const server = createCallbackServer({ realm: 'realm', receipts, pending, reportTerminal })
    expect((await post(server, body)).status).toBe(500)
    expect(reportTerminal).not.toHaveBeenCalled()
    expect(settler).not.toHaveBeenCalled()
    expect(pending.has('child')).toBe(true)
  })
})
