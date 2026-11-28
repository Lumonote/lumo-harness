import { afterEach, describe, expect, it, vi } from 'vitest'
import { DualPluginGateway, LocalDecider, type DualPluginManifest } from '../src/index.ts'
const manifest: DualPluginManifest = { manifestVersion: 1, id: 'cancel', title: 'Cancel', pages: [], tools: [{ name: 'cancel_test', description: 'fixture', action: 'test:read', risk: 'low', parameters: { type: 'object', properties: {} } }] }
const caller = { realm: 'r', userId: 'u', channel: 'platform' as const, sessionRef: 's' }
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('gateway cancellation', () => {
  it('does not execute a pre-aborted call', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    const handler = vi.fn(); gw.register(manifest, { cancel_test: handler })
    expect(await gw.invoke('cancel_test', {}, caller, AbortSignal.abort())).toMatchObject({ ok: false, code: 'aborted' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('cancels while authorization is pending without waiting for its response', async () => {
    const gw = new DualPluginGateway({ decider: { adapter: 'held', decide: () => new Promise(() => {}) } })
    const handler = vi.fn(); gw.register(manifest, { cancel_test: handler })
    const controller = new AbortController()
    const pending = gw.invoke('cancel_test', {}, caller, controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('cancels the individual approval and never executes after a late answer', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    const handler = vi.fn()
    gw.register({ ...manifest, tools: [{ ...manifest.tools[0]!, approval: 'always' }] }, { cancel_test: handler })
    const controller = new AbortController()
    const pending = gw.invoke('cancel_test', {}, caller, controller.signal)
    await flush()
    const ask = gw.asks.list({ status: 'pending' })[0]!
    expect(ask).toBeDefined()
    controller.abort()
    expect(await pending).toMatchObject({ ok: false })
    expect(gw.asks.get(ask.id)?.status).toBe('cancelled')
    expect(gw.asks.answer(ask.id, 'approve_once', 'u').ok).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('reports an unknown result at the deadline and ignores late success', async () => {
    vi.useFakeTimers()
    const events: unknown[] = []
    const gw = new DualPluginGateway({ decider: new LocalDecider(), handlerTimeoutMs: 5, runTree: { apply: event => events.push(event) } })
    let complete!: () => void
    let signal!: AbortSignal
    gw.register(manifest, { cancel_test: (_args, ctx) => { signal = ctx.signal; return new Promise<void>(resolve => { complete = resolve }) } })
    const pending = gw.invoke('cancel_test', {}, caller)
    await flush()
    await vi.advanceTimersByTimeAsync(6)
    expect(await pending).toMatchObject({ ok: false, code: 'result_unknown' })
    expect(signal.aborted).toBe(true)
    const count = events.length
    complete(); await flush()
    expect(events).toHaveLength(count)
    expect(JSON.stringify(events)).not.toContain('"stopReason":"completed"')
  })

  it('ends the wait on execution cancellation and observes a late rejection', async () => {
    vi.useFakeTimers()
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    let fail!: (error: Error) => void
    gw.register(manifest, { cancel_test: () => new Promise((_resolve, reject) => { fail = reject }) })
    const controller = new AbortController()
    const pending = gw.invoke('cancel_test', {}, caller, controller.signal)
    await flush()
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, code: 'result_unknown' })
    expect(vi.getTimerCount()).toBe(0)
    fail(new Error('late failure'))
    await flush()
  })

  it('returns a structured authorization failure without executing the tool', async () => {
    const handler = vi.fn()
    const gw = new DualPluginGateway({ decider: { adapter: 'broken', decide: async () => { throw new Error('authorization unavailable') } } })
    gw.register(manifest, { cancel_test: handler })
    expect(await gw.invoke('cancel_test', {}, caller)).toMatchObject({ ok: false, code: 'failed', error: 'authorization unavailable' })
    expect(handler).not.toHaveBeenCalled()
  })
})
