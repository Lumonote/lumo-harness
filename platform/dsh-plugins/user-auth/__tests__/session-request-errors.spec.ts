import { describe, expect, it, vi } from 'vitest'
import { SessionRequestError, publicSessionRequestError, sessionUpstreamError } from '../src/session-request-errors.ts'
import { attachmentBytes, attachmentMediaType, attachmentName, attachmentText, OwnedSessionAttachments } from '../src/session-attachments.ts'

describe('safe owned session failure classification', () => {
  it.each([
    [403, 'private_scope_denied', 'session_attachment_denied'],
    [400, 'private_field', 'session_attachment_invalid'],
    [413, 'secret_limit', 'session_attachment_too_large'],
    [415, 'private_parser', 'session_attachment_unsupported'],
    [409, 'session_attachment_capacity', 'session_attachment_capacity'],
    [503, 'attachment_store_unavailable', 'session_attachment_unavailable'],
    [507, 'storage_quota_exceeded', 'storage_quota_exceeded'],
    [507, 'unknown_storage_error', 'session_attachment_unavailable'],
  ])('maps upstream %s to a fixed public descriptor', async (status, remote, code) => {
    const error = await sessionUpstreamError(new Response(JSON.stringify({ error: remote, message: 'service-secret /private/bucket' }), { status: Number(status) }), 'attachment')
    expect(error.code).toBe(code)
    expect(error.message).not.toMatch(/service-secret|private|bucket/u)
    expect(error).toBeInstanceOf(SessionRequestError)
  })
  it.each([['0', 1], ['7', 7], ['999999999', 60], ['Wed, 05 Nov 2026 00:00:00 GMT', 2], ['-3', 2]])('bounds Retry-After %s', async (header, expected) => {
    const error = await sessionUpstreamError(new Response('{"error":"private"}', { status: 429, headers: { 'retry-after': header } }), 'attachment')
    expect(error).toMatchObject({ code: 'session_attachment_busy', status: 429, retryAfter: expected, retryable: true })
  })
  it('discards malformed, oversized, null and forged downstream bodies', async () => {
    for (const raw of ['bad-json', 'null', JSON.stringify({ error: 'constructor', message: 'login-secret' }), JSON.stringify({ error: 'session_attachment_denied', padding: 'x'.repeat(5000) })]) {
      const failure = await sessionUpstreamError(new Response(raw, { status: 503 }), 'attachment')
      expect(failure.code).toBe('session_attachment_unavailable'); expect(failure.message).not.toContain('login-secret')
    }
    expect(publicSessionRequestError('constructor', 403)).toBeUndefined()
    expect(publicSessionRequestError('session_attachment_denied', 503)).toBeUndefined()
    expect(publicSessionRequestError('storage_quota_exceeded', 507)).toMatchObject({ status: 507 })
  })
  it('keeps an external dispatch outcome unknown and never retryable', async () => {
    for (const status of [502, 503, 507]) {
      const failure = await sessionUpstreamError(new Response('{"error":"owned_connector_unavailable"}', { status }), 'connector', true)
      expect(failure).toMatchObject({ code: 'connector_outcome_unknown', status: 502, retryable: false, retryAfter: 0 })
    }
    expect(await sessionUpstreamError(new Response('{"error":"connector_outcome_unknown"}', { status: 502 }), 'connector')).toMatchObject({ retryable: false })
  })
  it('distinguishes invalid metadata, unsupported media and actual stream byte limits', async () => {
    expect(() => attachmentName('..')).toThrowError(expect.objectContaining({ code: 'session_attachment_invalid', status: 400 }))
    expect(() => attachmentMediaType('text/html')).toThrowError(expect.objectContaining({ code: 'session_attachment_unsupported', status: 415 }))
    expect(() => attachmentText(new Uint8Array([255]))).toThrowError(expect.objectContaining({ status: 415 }))
    await expect(attachmentBytes((async function* () { yield Buffer.from('four') })(), 3, new AbortController().signal)).rejects.toMatchObject({ code: 'session_attachment_too_large', status: 413 })
  })
  it('classifies the real attachment authority response and provider failure without leaking text', async () => {
    const principal = { realm: 'r', user_id: 'alice' } as never
    const runtime = { realm: 'r', signal: new AbortController().signal, proof: vi.fn(async () => ({ secret: 'execution-secret' })) } as never
    const fetcher = vi.fn(async () => new Response('{"error":"storage_quota_exceeded","message":"private PG detail"}', { status: 507 }))
    const manager = new OwnedSessionAttachments({} as never, { realm: 'r' }, runtime, 'https://authority.example', 'service-secret', fetcher)
    await expect(manager.get(principal, `session-${'a'.repeat(32)}`, `att_${'b'.repeat(48)}`)).rejects.toMatchObject({ code: 'storage_quota_exceeded', status: 507, retryable: false })
    const save = vi.fn(async () => { throw Error('provider-secret /private/object') })
    const unavailable = new OwnedSessionAttachments({ saveFileStream: save } as never, { realm: 'r' }, runtime, 'https://authority.example', 'service-secret', fetcher)
    const failure = await unavailable.upload(principal, `session-${'a'.repeat(32)}`, { name: 'notes.txt', mediaType: 'text/plain' }, (async function* () { yield Buffer.from('safe') })(), new AbortController().signal, async () => {}).catch(error => error as SessionRequestError)
    expect(failure).toMatchObject({ code: 'session_attachment_unavailable', status: 503 }); expect(failure.message).not.toMatch(/provider-secret|private/u)
  })
  it('releases transfer capacity after cancellation and reports a bounded concurrent 429', async () => {
    let entered = 0
    const runtime = { realm: 'r', signal: new AbortController().signal } as never
    const manager = new OwnedSessionAttachments({} as never, { realm: 'r' }, runtime, 'https://authority.example', 'service-secret')
    const abort = new AbortController()
    const source = { async *[Symbol.asyncIterator]() { entered++; await new Promise(() => {}); yield Buffer.from('unused') } }
    const run = () => manager.upload({} as never, 'session-ref', { name: 'notes.txt', mediaType: 'text/plain' }, source, abort.signal, async () => {})
    const first = run(), second = run()
    await expect(run()).rejects.toMatchObject({ code: 'session_attachment_busy', status: 429, retryAfter: 2 })
    expect(entered).toBe(2); abort.abort(Error('canceled'))
    await expect(first).rejects.toThrow('canceled'); await expect(second).rejects.toThrow('canceled')
    await expect(run()).rejects.toThrow('canceled')
  })
})
