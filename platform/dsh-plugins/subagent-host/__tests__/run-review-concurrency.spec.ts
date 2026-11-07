import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareGovernedRun, type PreparedRun, type ReviewFileEntry } from '../src/run-review.ts'
import { runGovernedTask } from '../src/governed-run.ts'
import { CLOSED_FILES_PROFILE, CLOSED_TEXT_PROFILE } from '../src/controlled-files.ts'
import { binding, config, execution } from './governed-fixtures.ts'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fakeTimers() {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Operation timed out', 'TimeoutError')), ms).unref()
    return controller.signal
  })
}
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve() }
function fixture(count = 8) {
  const item = execution()
  const contents = Array.from({ length: count }, (_, index) => `Complete content ${index}`)
  const files: ReviewFileEntry[] = contents.map((text, index) => ({ id: `file-${String(index + 1).padStart(4, '0')}`, name: `file-${index}.txt`, media_type: 'text/plain; charset=utf-8', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }))
  const value: PreparedRun = {
    snapshot: { realm: config.realm, task_id: item.task.id, run_id: item.runId, worker_id: `agent:${binding.agentId}`, node_id: config.nodeId, session_ref: item.sessionRef, preset_id: binding.agentId, preset_revision: binding.presetRevision, provider: binding.provider, model: binding.model, output_profile: CLOSED_TEXT_PROFILE },
    review: { producer_task_id: 'producer', producer_run_id: 'run-p', producer_intent: 'Read every complete file', manifest_digest: 'a'.repeat(64), manifest: { scope: CLOSED_FILES_PROFILE, task_id: 'producer', run_id: 'run-p', summary: 'all files', entries: [{ id: 'output-0001', sha256: 'b'.repeat(64), text: 'delivered' }], files }, expires_at: new Date(Date.now() + 60_000).toISOString() },
  }
  const waits: Array<{ index: number; signal: AbortSignal; resolve(patch?: object): void; fail(): void }> = []
  let active = 0, maximum = 0
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/prepare')) return Response.json(value)
    const index = files.findIndex(file => path.endsWith(file.id))
    active++; maximum = Math.max(active, maximum)
    return new Promise<Response>((resolve, reject) => {
      waits.push({ index, signal: init!.signal!, resolve: patch => resolve(Response.json({ ...files[index], text: contents[index], receipt: String(index).padStart(64, 'c'), ...patch })), fail: () => reject(new Error('independent read failed')) })
    }).finally(() => { active-- })
  })
  return { item, files, contents, value, waits, fetcher, maximum: () => maximum }
}

describe('bounded complete-file review preparation', () => {
  it('reads at most four files at once and publishes evidence only after all pass in manifest order', async () => {
    const f = fixture(8)
    let completed = false
    const pending = prepareGovernedRun(config, f.item, f.fetcher as typeof fetch).then(result => { completed = true; return result })
    await flush(); expect(f.waits).toHaveLength(4); expect(f.maximum()).toBe(4)
    f.waits[3]!.resolve(); await flush()
    expect(f.waits).toHaveLength(5); expect(completed).toBe(false)
    expect(f.value.review!.read_files).toBeUndefined(); expect(f.value.reviewFileReceipts).toBeUndefined()
    // Complete the remaining reads in reverse order, including later workers.
    for (let index = 0; index < 8; index++) {
      for (const wait of [...f.waits].reverse()) wait.resolve()
      await flush()
    }
    const actual = await pending
    expect(f.maximum()).toBe(4)
    expect(actual.review!.read_files).toEqual(f.files.map((file, index) => ({ ...file, text: f.contents[index] })))
    expect(actual.reviewFileReceipts?.map(read => read.id)).toEqual(f.files.map(file => file.id))
    expect(JSON.stringify(actual.review)).not.toContain('cccccccccccccccc')
  })
  it.each(['hash', 'metadata', 'receipt', 'fetch'])('cancels every sibling and refuses all evidence after a %s failure', async failure => {
    const f = fixture(12), pending = prepareGovernedRun(config, f.item, f.fetcher as typeof fetch)
    const rejected = expect(pending).rejects.toThrow()
    await flush(); expect(f.waits).toHaveLength(4)
    if (failure === 'fetch') f.waits[0]!.fail()
    else f.waits[0]!.resolve(failure === 'hash' ? { text: 'Incorrect complete bytes' } : failure === 'metadata' ? { name: 'foreign.txt' } : { receipt: 'self-proven' })
    await rejected
    expect(f.waits.every(wait => wait.signal.aborted)).toBe(true)
    expect(f.waits).toHaveLength(4)
    expect(f.value.review!.read_files).toBeUndefined(); expect(f.value.reviewFileReceipts).toBeUndefined()
    for (const wait of f.waits) wait.resolve(); await flush()
  })
  it('validates the full manifest before reading a file and rejects already-cancelled work before fetch', async () => {
    const f = fixture()
    f.files.at(-1)!.id = f.files[0]!.id
    await expect(prepareGovernedRun(config, f.item, f.fetcher as typeof fetch)).rejects.toThrow('identity')
    expect(f.fetcher).toHaveBeenCalledOnce()
    const abort = new AbortController(); abort.abort(Error('cancelled before prepare'))
    await expect(prepareGovernedRun(config, f.item, f.fetcher as typeof fetch, abort.signal)).rejects.toThrow('cancelled before prepare')
    expect(f.fetcher).toHaveBeenCalledOnce()
  })
  it('cancels fetch and body reads promptly when the owning execution stops', async () => {
    const f = fixture(), abort = new AbortController()
    const pending = prepareGovernedRun(config, f.item, f.fetcher as typeof fetch, abort.signal)
    const rejected = expect(pending).rejects.toThrow('owner stopped')
    await flush(); abort.abort(Error('owner stopped')); await rejected
    expect(f.waits.every(wait => wait.signal.aborted)).toBe(true)
    for (const wait of f.waits) wait.resolve(); await flush()
    const cancel = vi.fn(), bodyAbort = new AbortController()
    const blockedBody = prepareGovernedRun(config, f.item, async () => new Response(new ReadableStream({ start() {}, cancel })), bodyAbort.signal)
    const bodyRejected = expect(blockedBody).rejects.toThrow('body stopped')
    await flush(); bodyAbort.abort(Error('body stopped')); await bodyRejected
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('applies one overall deadline across sequential waves and rejects files that finish after review expiry', async () => {
    fakeTimers(); const f = fixture(16)
    f.item.deadlineMS = Date.now() + 7500
    const pending = prepareGovernedRun(config, f.item, f.fetcher as typeof fetch)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await flush()
    await vi.advanceTimersByTimeAsync(4000)
    for (const wait of f.waits) wait.resolve(); await flush(); expect(f.waits).toHaveLength(8)
    await vi.advanceTimersByTimeAsync(3500); await rejected
    expect(f.waits).toHaveLength(8); expect(f.waits.every(wait => wait.signal.aborted)).toBe(true)
    for (const wait of f.waits) wait.resolve(); await flush()
    const g = fixture(1); g.value.review!.expires_at = new Date(Date.now() + 50).toISOString()
    const expires = prepareGovernedRun(config, g.item, g.fetcher as typeof fetch)
    const expired = expect(expires).rejects.toThrow('expired during file reads')
    await flush(); await vi.advanceTimersByTimeAsync(51); g.waits[0]!.resolve(); await expired
  })
  it('receives the actual execution timeout before Agent creation, including preparation time', async () => {
    fakeTimers(); const f = fixture(4)
    f.item.preset.timeout_seconds = 1
    const create = vi.fn(), logger = { warn: vi.fn() }
    let preparationSignal: AbortSignal | undefined
    const run = runGovernedTask({ agents: { create }, logger } as never, f.item, binding, config.nodeId, new AbortController().signal, undefined, signal => {
      preparationSignal = signal
      return prepareGovernedRun(config, f.item, f.fetcher as typeof fetch, signal)
    })
    await flush(); expect(f.waits).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await run).toMatchObject({ state: 'CANCELLED' })
    expect(preparationSignal?.aborted).toBe(true)
    expect(f.waits.every(wait => wait.signal.aborted)).toBe(true); expect(create).not.toHaveBeenCalled()
    for (const wait of f.waits) wait.resolve(); await flush()
  })
  it('bounds a stalled response body and never creates an Agent from partially verified files', async () => {
    fakeTimers(); const f = fixture(2), cancel = vi.fn()
    const blocked = prepareGovernedRun(config, f.item, async input => String(input).endsWith('/prepare') ? Response.json(f.value) : new Response(new ReadableStream({ start() {}, cancel })))
    const rejected = expect(blocked).rejects.toMatchObject({ name: 'TimeoutError' })
    await flush(); await vi.advanceTimersByTimeAsync(5000); await rejected
    expect(cancel).toHaveBeenCalledTimes(2)
    const create = vi.fn(), logger = { warn: vi.fn() }
    const run = runGovernedTask({ agents: { create }, logger } as never, f.item, binding, config.nodeId, new AbortController().signal, undefined,
      () => prepareGovernedRun(config, f.item, async input => String(input).endsWith('/prepare') ? Response.json(f.value) : new Response('missing', { status: 404 })))
    expect(await run).toMatchObject({ state: 'FAILED' }); expect(create).not.toHaveBeenCalled()
  })
})
