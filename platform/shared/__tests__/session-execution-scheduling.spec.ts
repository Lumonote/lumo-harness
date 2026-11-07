import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionExecutionClient, SessionExecutionRuntime } from '../session-execution.ts'

const runtimes: SessionExecutionRuntime[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); vi.restoreAllMocks(); vi.useRealTimers() })
function timers(random = 0) {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(random)
  // Node's native AbortSignal.timeout uses internal timers, outside fake timers.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Operation timed out', 'TimeoutError')), ms).unref()
    return controller.signal
  })
}
function fixture() {
  const waits: Array<{ path: string; signal: AbortSignal; resolve(): void; reject(): void }> = []
  let blockSessions = false, blockNode = false, active = 0, maximum = 0
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body))
    const ref = path.split('/')[4]
    const response = () => Response.json(path.includes('/nodes/') ? { node: { ...body, fence: 3, expires_at: '2099-01-01' } } : { lease: { ...body, session_ref: ref, node_fence: 3, fencing_token: 5, expires_at: '2099-01-01' } })
    if (path.endsWith('/renew') && (path.includes('/nodes/') ? blockNode : blockSessions)) {
      active++; maximum = Math.max(maximum, active)
      return new Promise<Response>((resolve, reject) => {
        waits.push({ path, signal: init!.signal!, resolve: () => resolve(response()), reject: () => reject(new Error('authority unavailable')) })
      }).finally(() => { active-- })
    }
    return response()
  })
  const stop = vi.fn()
  const runtime = new SessionExecutionRuntime(new SessionExecutionClient('https://authority.example', 'service', fetcher as typeof fetch), 'r', 'n', 'p', 'https://n.example', 'writer', stop)
  runtimes.push(runtime)
  const count = (part: string) => fetcher.mock.calls.filter(([url]) => String(url).includes(part)).length
  return { runtime, fetcher, stop, waits, count, maximum: () => maximum, blockSessions: (value: boolean) => { blockSessions = value }, blockNode: (value: boolean) => { blockNode = value } }
}
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve() }

describe('bounded execution heartbeat scheduling', () => {
  it('caps background renewals at eight and never overlaps a running sweep', async () => {
    timers(); const f = fixture()
    for (let i = 0; i < 24; i++) await f.runtime.ensure(`session-${i}`)
    f.blockSessions(true)
    await vi.advanceTimersByTimeAsync(1750)
    expect(f.waits).toHaveLength(8); expect(f.maximum()).toBe(8)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.waits).toHaveLength(8)
    f.blockSessions(false); for (const wait of f.waits) wait.resolve()
    await flush()
    expect(f.count('/renew')).toBe(25)
    expect(f.maximum()).toBe(8); expect(f.stop).not.toHaveBeenCalled()
  })
  it('skips only a queued lease already refreshed by a successful foreground request', async () => {
    timers(); const f = fixture()
    for (let i = 0; i < 12; i++) await f.runtime.ensure(`session-${i}`)
    f.blockSessions(true); await vi.advanceTimersByTimeAsync(1750)
    const foreground = f.runtime.ensure('session-11'); await flush()
    const foregroundWait = f.waits.find(wait => wait.path.includes('/session-11/'))!
    foregroundWait.resolve(); await foreground
    f.blockSessions(false); for (const wait of f.waits) wait.resolve(); await flush()
    expect(f.count('/session-11/renew')).toBe(1)
    await f.runtime.ensure('session-11')
    expect(f.count('/session-11/renew')).toBe(2) // No reuse of a completed authority check.
  })
  it('joins only in-flight node checks and jitters each non-overlapping sweep', async () => {
    timers(0); const f = fixture(); await f.runtime.start()
    f.blockNode(true)
    const checks = [f.runtime.check(), f.runtime.check(), f.runtime.check()]; await flush()
    expect(f.count('/nodes/n/renew')).toBe(1)
    f.waits[0]!.resolve(); await Promise.all(checks)
    f.blockNode(false); await f.runtime.check(); expect(f.count('/nodes/n/renew')).toBe(2)
    await vi.advanceTimersByTimeAsync(1749); expect(f.count('/nodes/n/renew')).toBe(2)
    vi.mocked(Math.random).mockReturnValue(0.9999)
    await vi.advanceTimersByTimeAsync(1); expect(f.count('/nodes/n/renew')).toBe(3)
    await vi.advanceTimersByTimeAsync(2249); expect(f.count('/nodes/n/renew')).toBe(3)
    await vi.advanceTimersByTimeAsync(1); expect(f.count('/nodes/n/renew')).toBe(4)
  })
  it('fences the runtime and cancels all outstanding requests when a renewal fails', async () => {
    timers(); const f = fixture()
    for (let i = 0; i < 20; i++) await f.runtime.ensure(`session-${i}`)
    f.blockSessions(true); await vi.advanceTimersByTimeAsync(1750)
    f.waits[0]!.reject(); await flush()
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.runtime.signal.aborted).toBe(true)
    expect(f.waits.every(wait => wait.signal.aborted)).toBe(true)
    const count = f.fetcher.mock.calls.length
    await expect(f.runtime.ensure('session-19')).rejects.toMatchObject({ code: 'session_execution_unavailable' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.fetcher).toHaveBeenCalledTimes(count)
    for (const wait of f.waits) wait.resolve(); await flush()
    await expect(f.runtime.start()).rejects.toMatchObject({ code: 'session_execution_unavailable' })
  })
  it('fences a stalled sweep within its overall budget and never dequeues its remaining sessions', async () => {
    timers(); const f = fixture()
    for (let i = 0; i < 24; i++) await f.runtime.ensure(`session-${i}`)
    f.blockSessions(true); await vi.advanceTimersByTimeAsync(1750)
    // One wave takes two seconds; the next wave stalls. Per-call 3s and
    // total sweep 5s both end at 6750, before the 10s session lease deadline.
    await vi.advanceTimersByTimeAsync(2000)
    for (const wait of f.waits) wait.resolve(); await flush()
    expect(f.waits).toHaveLength(16)
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.runtime.signal.aborted).toBe(true)
    expect(f.waits).toHaveLength(16)
    for (const wait of f.waits) wait.resolve(); await flush()
  })
  it('renews all 512 admitted sessions with a measured eight-request ceiling', async () => {
    timers()
    let active = 0, maximum = 0, completed = 0
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body))
      if (path.includes('/sessions/') && path.endsWith('/renew')) {
        active++; maximum = Math.max(maximum, active)
        await new Promise<void>(resolve => { setTimeout(resolve, 5) })
        active--; completed++
      }
      return Response.json(path.includes('/nodes/') ? { node: { ...body, fence: 1 } } : { lease: { ...body, session_ref: path.split('/')[4], node_fence: 1, fencing_token: 1 } })
    }
    const stop = vi.fn()
    const runtime = new SessionExecutionRuntime(new SessionExecutionClient('https://authority.example', 'service', fetcher), 'r', 'n', 'p', 'https://n.example', 'writer', stop)
    runtimes.push(runtime)
    for (let i = 0; i < 512; i++) await runtime.ensure(`session-${i}`)
    await expect(runtime.ensure('session-over-capacity')).rejects.toThrow('capacity')
    await vi.advanceTimersByTimeAsync(2069)
    expect(completed).toBe(504)
    await vi.advanceTimersByTimeAsync(1)
    expect(completed).toBe(512); expect(maximum).toBe(8); expect(stop).not.toHaveBeenCalled()
  })
  it('cannot schedule a heartbeat when node acquisition finishes after disposal', async () => {
    timers()
    let complete!: () => void
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return new Promise<Response>(resolve => { complete = () => resolve(Response.json({ node: { ...body, fence: 1 } })) })
    })
    const runtime = new SessionExecutionRuntime(new SessionExecutionClient('https://authority.example', 'service', fetcher as typeof fetch), 'r', 'n', 'p', 'https://n.example', 'writer', vi.fn())
    runtimes.push(runtime)
    const starting = runtime.start(), rejected = expect(starting).rejects.toMatchObject({ code: 'session_execution_unavailable' })
    await flush(); await runtime.dispose(); complete(); await rejected; await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledOnce(); expect(runtime.signal.aborted).toBe(true)
    await expect(runtime.start()).rejects.toMatchObject({ code: 'session_execution_unavailable' })
  })
  it('does not revive a disposed process from late acquisition or body completion', async () => {
    const abort = new AbortController()
    const cancel = vi.fn()
    const client = new SessionExecutionClient('https://authority.example', 'service', async () => new Response(new ReadableStream({ start() {}, cancel })))
    const pending = client.call('/nodes/n/acquire', {}, abort.signal)
    abort.abort(); await expect(pending).rejects.toMatchObject({ code: 'session_execution_unavailable' }); await flush()
    expect(cancel).toHaveBeenCalledOnce()
    const f = fixture(); f.blockNode(true); await f.runtime.start()
    const check = f.runtime.check(); await flush(); await f.runtime.dispose()
    f.waits[0]!.resolve(); await expect(check).rejects.toMatchObject({ code: 'session_execution_unavailable' })
    expect(f.runtime.signal.aborted).toBe(true)
  })
})
