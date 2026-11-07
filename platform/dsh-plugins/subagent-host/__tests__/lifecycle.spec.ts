import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostLifecycle } from '../src/lifecycle.ts'

afterEach(() => vi.useRealTimers())

function setup() {
  let active = 0
  let healthy = true
  const dependencies = {
    active: () => active,
    health: () => ({ ready: healthy, pending: healthy ? 0 : 1 }),
    check: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    pause: vi.fn(),
    flush: vi.fn(async () => {}),
  }
  const lifecycle = new HostLifecycle(dependencies)
  return { lifecycle, dependencies, setActive: (n: number) => { active = n }, setHealthy: (value: boolean) => { healthy = value } }
}

describe('execution node lifecycle', () => {
  it('requires startup, replication health and a reachable database', async () => {
    const h = setup()
    expect(await h.lifecycle.ready()).toBe(false)
    h.lifecycle.start()
    expect(await h.lifecycle.ready()).toBe(true)
    h.setHealthy(false)
    expect(await h.lifecycle.ready()).toBe(false)
    expect(() => h.lifecycle.beginAdmission()).toThrow()
    h.setHealthy(true)
    h.dependencies.check.mockRejectedValueOnce(new Error('PG unavailable'))
    expect(await h.lifecycle.ready()).toBe(false)
  })

  it('closes admission immediately and waits for an admission to register its execution', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.lifecycle.start()
    const completeAdmission = h.lifecycle.beginAdmission()
    const drained = h.lifecycle.drain(1_000)
    expect(h.lifecycle.admitting()).toBe(false)
    expect(h.dependencies.pause).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.dependencies.flush).not.toHaveBeenCalled()
    h.setActive(1)
    completeAdmission()
    completeAdmission() // cancellation/finalization must not undercount active work
    await vi.advanceTimersByTimeAsync(100)
    expect(h.dependencies.flush).not.toHaveBeenCalled()
    h.setActive(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(await drained).toBe(true)
    expect(h.dependencies.flush).toHaveBeenCalledOnce()
  })

  it('bounds directory withdrawal and log flush by the same total deadline', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.lifecycle.start()
    h.dependencies.withdraw.mockImplementationOnce(() => new Promise(() => {}))
    const waiting = h.lifecycle.drain(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await waiting).toBe(false)
    expect(h.dependencies.flush).not.toHaveBeenCalled()

    const f = setup()
    f.lifecycle.start()
    f.dependencies.flush.mockImplementationOnce(() => new Promise(() => {}))
    const flushing = f.lifecycle.drain(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await flushing).toBe(false)
    expect(f.lifecycle.admitting()).toBe(false)
  })

  it('retries failed withdrawal and does not report an active execution as drained', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.lifecycle.start()
    h.dependencies.withdraw.mockRejectedValueOnce(new Error('Nacos unavailable'))
    await expect(h.lifecycle.drain(100)).rejects.toThrow('Nacos unavailable')
    h.setActive(1)
    const drain = h.lifecycle.drain(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await drain).toBe(false)
    expect(h.dependencies.withdraw).toHaveBeenCalledTimes(2)
    expect(h.dependencies.flush).not.toHaveBeenCalled()
  })
})
