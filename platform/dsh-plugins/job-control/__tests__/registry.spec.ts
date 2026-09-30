import { describe, expect, it, vi } from 'vitest'
import { JobId, type JobEventListener, type JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { adaptDshJobs, observeDshJobs } from '../src/registry.ts'

const job: JobView = {
  id: JobId('bash-1'), kind: 'bash', label: 'build', owner: SessionId('session-1'),
  status: 'running', startedAt: 10, output: { total: 0, earliest: 0 },
}

describe('current DSH job registry bridge', () => {
  it('uses session IDs for fenced list and kill calls, and maps ownership', () => {
    const registry = { list: vi.fn(() => [job]), kill: vi.fn(() => 'requested' as const) }
    const adapter = adaptDshJobs(registry)
    const owner = { session: { id: 'session-1' } }
    expect(adapter.list(owner)[0]?.ownerSession).toBe('session-1')
    expect(registry.list).toHaveBeenCalledWith('session-1')
    expect(adapter.kill('bash-1', owner, 'deadline')).toBe('requested')
    expect(registry.kill).toHaveBeenCalledWith('bash-1', 'session-1', 'deadline')
  })

  it('attaches a controller and projects owned registration and settlement events', async () => {
    let receive!: JobEventListener
    const registry = {
      attachController: vi.fn(() => () => {}),
      events: { subscribe: vi.fn((_filter, listener: JobEventListener) => { receive = listener; return () => {} }) },
    }
    const executor = { done: vi.fn(async () => {}) }
    observeDshJobs(registry, executor, error => { throw error })
    expect(registry.attachController).toHaveBeenCalledWith('lumo/job-control')
    expect(registry.events.subscribe).toHaveBeenCalledWith({ owners: 'scope' }, expect.any(Function))
    receive({ type: 'registered', job })
    receive({ type: 'settled', job: { ...job, status: 'completed', finishedAt: 20 }, cause: 'producer', awaited: false })
    receive({ type: 'registered', job: { ...job, owner: undefined } })
    receive({ type: 'output', id: job.id, owner: job.owner, total: 5 })
    receive({ type: 'removed', job })
    await Promise.resolve()
    expect(executor.done).toHaveBeenCalledTimes(2)
    expect(executor.done).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerSession: 'session-1', status: 'completed', finishedAt: 20 }),
      { session: { id: 'session-1' } },
    )
  })

  it('reports asynchronous projection failures', async () => {
    let receive!: JobEventListener
    const registry = {
      attachController: () => () => {},
      events: { subscribe: (_filter, listener: JobEventListener) => { receive = listener; return () => {} } },
    }
    const error = new Error('database unavailable')
    const onError = vi.fn()
    observeDshJobs(registry, { done: async () => { throw error } }, onError)
    receive({ type: 'registered', job })
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(error)
  })
})
