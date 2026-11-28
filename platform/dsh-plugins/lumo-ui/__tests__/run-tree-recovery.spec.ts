import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunTreeStream } from '../src/client/run-tree-stream.ts'
import type { RunTreeDelta } from '../../../shared/seam-contracts/run-tree.ts'

const delta = (seq: number, status = 'running'): RunTreeDelta => ({ seq, event: { type: 'node.upsert', node: { id: 'task:a', kind: 'task', title: 'A', status: status as 'running' } } })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
afterEach(() => vi.useRealTimers())

describe('RunTree reconnect projection', () => {
  it('shares the in-flight snapshot, queues deltas and deduplicates them', async () => {
    const pending = deferred<{ seq: number; nodes: [] }>()
    const snapshot = vi.fn(() => pending.promise); const publish = vi.fn()
    const stream = new RunTreeStream(snapshot, publish, vi.fn())
    try {
      const one = stream.refresh(); const two = stream.refresh()
      expect(one).toBe(two)
      stream.delta(delta(2)); stream.delta(delta(1)); stream.delta(delta(2))
      pending.resolve({ seq: 0, nodes: [] }); await one
      expect(snapshot).toHaveBeenCalledOnce()
      expect(publish.mock.lastCall?.[0].seq).toBe(2)
      stream.delta(delta(2, 'failed'))
      expect(publish.mock.lastCall?.[0].nodes['task:a'].status).toBe('running')
    } finally { stream.dispose() }
  })
  it('ignores old snapshot completion after reconnect and permits server sequence reset', async () => {
    const old = deferred<{ seq: number; nodes: [] }>()
    const snapshot = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ seq: 1, nodes: [] })
    const publish = vi.fn(); const stream = new RunTreeStream(snapshot, publish, vi.fn())
    const first = stream.refresh(); await Promise.resolve()
    stream.hello(); await stream.refresh()
    old.resolve({ seq: 999, nodes: [] }); await first
    expect(publish.mock.lastCall?.[0].seq).toBe(1)
    expect(snapshot.mock.calls[0]![0].aborted).toBe(true)
    stream.dispose()
  })
  it('recovers a missing terminal event using a snapshot after a gap', async () => {
    const snapshot = vi.fn().mockResolvedValueOnce({ seq: 1, nodes: [] }).mockResolvedValueOnce({ seq: 3, nodes: [{ id: 'task:a', kind: 'task', status: 'succeeded' }] })
    const publish = vi.fn(); const stream = new RunTreeStream(snapshot, publish, vi.fn())
    try {
      await stream.refresh(); stream.delta(delta(3, 'succeeded')); await stream.refresh()
      expect(publish.mock.lastCall?.[0].seq).toBe(3)
      expect(publish.mock.lastCall?.[0].nodes['task:a'].status).toBe('succeeded')
    } finally { stream.dispose() }
  })
  it('does not publish or retry after disposal', async () => {
    vi.useFakeTimers()
    const pending = deferred<{ seq: number; nodes: [] }>()
    const publish = vi.fn(); const stream = new RunTreeStream(() => pending.promise, publish, vi.fn())
    const request = stream.refresh(); stream.dispose(); pending.resolve({ seq: 5, nodes: [] }); await request
    expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it('backs off snapshot failures instead of leaving the panel disconnected', async () => {
    vi.useFakeTimers()
    const snapshot = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ seq: 5, nodes: [] })
    const publish = vi.fn(); const notice = vi.fn(); const stream = new RunTreeStream(snapshot, publish, notice)
    try {
      await stream.refresh(); expect(notice.mock.lastCall?.[0]).toContain('offline')
      await vi.advanceTimersByTimeAsync(1000)
      expect(publish.mock.lastCall?.[0].seq).toBe(5)
    } finally { stream.dispose() }
  })
  it('does not let healthy SSE traffic bypass snapshot failure backoff', async () => {
    vi.useFakeTimers()
    const snapshot = vi.fn().mockRejectedValue(new Error('unavailable'))
    const stream = new RunTreeStream(snapshot, vi.fn(), vi.fn())
    try {
      await stream.refresh()
      for (let seq = 1; seq <= 4; seq++) { stream.delta(delta(seq)); await Promise.resolve() }
      expect(snapshot).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(999); expect(snapshot).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1); expect(snapshot).toHaveBeenCalledTimes(2)
    } finally { stream.dispose() }
  })

})
