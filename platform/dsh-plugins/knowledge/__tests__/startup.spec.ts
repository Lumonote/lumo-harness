import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const mocks = vi.hoisted(() => ({ vectorInit: vi.fn(), graphInit: vi.fn(), close: vi.fn(), drain: vi.fn() }))
vi.mock('../src/pg-provider.ts', () => ({ PgKnowledgeProvider: class {
  init = mocks.vectorInit; close = mocks.close; drainVectorProjection = mocks.drain
} }))
vi.mock('../src/graph-provider.ts', () => ({ PgGraphProvider: class { init = mocks.graphInit; close = mocks.close } }))
vi.mock('../src/graph-projector.ts', () => ({ GraphProjector: class { drain = mocks.drain; close = mocks.close } }))
import { apply } from '../src/index.ts'

function setup() {
  const cleanups: (() => void)[] = []
  const ctx = {
    provide: vi.fn(), on: vi.fn(), tools: { register: vi.fn(() => vi.fn()) }, logger: { warn: vi.fn(), error: vi.fn() },
    effect: (fn: () => () => void) => { cleanups.push(fn()) },
  }
  const config = { connectionString: 'fixture', realm: 'test', embedding: { baseUrl: 'http://fixture', model: 'test', dimension: 2 } }
  const dispose = () => cleanups.splice(0).reverse().forEach(fn => fn())
  return { ctx, start: () => apply(ctx as unknown as Context, config), dispose }
}
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('knowledge startup lifecycle', () => {
  it('does not expose tools before initialization and recovers a transient failure', async () => {
    vi.useFakeTimers()
    mocks.vectorInit.mockRejectedValueOnce(new Error('database starting')).mockResolvedValue(undefined)
    mocks.graphInit.mockResolvedValue(undefined); mocks.drain.mockResolvedValue(undefined)
    const { ctx, start, dispose } = setup()
    const ready = start()
    expect(ctx.provide).not.toHaveBeenCalled()
    expect(ctx.tools.register).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    await ready
    expect(mocks.vectorInit).toHaveBeenCalledTimes(2)
    expect(ctx.tools.register).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.drain).toHaveBeenCalled()
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects startup after bounded retries instead of advertising unusable seams', async () => {
    vi.useFakeTimers()
    mocks.vectorInit.mockRejectedValue(new Error('database offline'))
    mocks.graphInit.mockResolvedValue(undefined)
    const { ctx, start, dispose } = setup()
    const failure = expect(start()).rejects.toThrow('database offline')
    await vi.advanceTimersByTimeAsync(5000)
    await failure
    expect(ctx.provide).not.toHaveBeenCalled()
    expect(ctx.tools.register).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(3)
    dispose()
    expect(mocks.close).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not publish late initialization after disposal', async () => {
    let finish!: () => void
    mocks.vectorInit.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    mocks.graphInit.mockResolvedValue(undefined)
    const { ctx, start, dispose } = setup()
    const ready = start()
    const failure = expect(ready).rejects.toThrow()
    await Promise.resolve()
    dispose(); finish()
    await failure
    expect(ctx.provide).not.toHaveBeenCalled()
    expect(ctx.tools.register).not.toHaveBeenCalled()
  })

  it('unloads a real Cordis plugin while initialization never settles', async () => {
    mocks.vectorInit.mockImplementation(() => new Promise(() => {}))
    mocks.graphInit.mockResolvedValue(undefined)
    const ctx = new Context()
    const register = vi.fn(() => vi.fn())
    ctx.provide('tools', { register } as never)
    const fiber = ctx.plugin(async child => apply(child, { connectionString: 'fixture', realm: 'test', embedding: { baseUrl: 'http://fixture', model: 'test', dimension: 2 } }))
    for (let i = 0; i < 20 && mocks.vectorInit.mock.calls.length === 0; i++) await Promise.resolve()
    expect(mocks.vectorInit).toHaveBeenCalled()
    await fiber.dispose()
    expect(register).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledTimes(3)
  })

  it('bounds a hung startup and ignores results after the total deadline', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    mocks.vectorInit.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    mocks.graphInit.mockResolvedValue(undefined)
    const { ctx, start, dispose } = setup()
    const failure = expect(start()).rejects.toThrow('60 秒')
    await vi.advanceTimersByTimeAsync(60_000)
    await failure
    expect(mocks.vectorInit).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(3)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.provide).not.toHaveBeenCalled()
    expect(ctx.tools.register).not.toHaveBeenCalled()
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
