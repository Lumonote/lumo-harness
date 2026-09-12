import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { runGovernedTask, startGovernedDispatch } from '../src/governed-run.ts'
import { ExecutionConflictError, type GovernedExecution, type GovernedResult } from '../src/governed-dispatch.ts'
import { binding, config, execution } from './governed-fixtures.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.useRealTimers()
})

async function context(text: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const requests: GenerateOptions[] = []
  ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      if (text) yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })())
  return { ctx, requests }
}

it('executes a governed turn through the public Agent API with its installed identity and inherited contract', async () => {
  const { ctx, requests } = await context('Verified output')
  const result = await runGovernedTask(ctx, execution(), binding, config.nodeId, new AbortController().signal)
  expect(result).toMatchObject({ run_id: 'run-1', task_id: 'task-run-1', session_ref: 'session-run-1',
    state: 'COMPLETED', summary: 'Verified output', output: [{ type: 'text', text: 'Verified output' }] })
  expect(requests).toHaveLength(1)
  const prompt = JSON.stringify(requests[0])
  expect(prompt).toContain('Complete the research')
  expect(prompt).toContain('Use the supplied evidence')
  expect(prompt).toContain('Cite the sources')
  expect(prompt).toContain('agent:writer')
})

it.each(['cancelled', 'expired', 'wrong-project', 'wrong-owner', 'excessive-depth'] as const)(
  'does not create an Agent for a %s dispatch', async reason => {
    const item = execution()
    if (reason === 'cancelled') item.cancelled = true
    if (reason === 'expired') item.deadlineMS = Date.now() - 1
    if (reason === 'wrong-project') item.task.project_id = 'other'
    if (reason === 'wrong-owner') item.preset.owner_user_id = 'other'
    if (reason === 'excessive-depth') item.task.intent_contract!.depth = 3
    const create = vi.fn()
    const ctx = { agents: { create }, logger: { warn: vi.fn() } } as unknown as Context
    const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal)
    expect(create).not.toHaveBeenCalled()
    expect(result.state).toBe(['cancelled', 'expired'].includes(reason) ? 'CANCELLED' : 'FAILED')
  })

it('fails a completed turn without a deliverable', async () => {
  const { ctx } = await context('')
  const result = await runGovernedTask(ctx, execution(), binding, config.nodeId, new AbortController().signal)
  expect(result).toMatchObject({ state: 'FAILED', summary: 'Agent completed without a deliverable' })
})

function fakeStore() {
  return { config, take: vi.fn<() => Promise<GovernedExecution | undefined>>().mockResolvedValue(undefined),
    recover: vi.fn().mockResolvedValue(0), deliver: vi.fn().mockResolvedValue(undefined),
    shouldStop: vi.fn().mockResolvedValue(false),
    save: vi.fn<(item: GovernedExecution, result: GovernedResult) => Promise<void>>().mockResolvedValue(undefined) }
}
function pendingContext() {
  let signal: AbortSignal | undefined
  const create = vi.fn(({ signal: stop }: { signal: AbortSignal }) => {
    signal = stop
    return new Promise((_resolve, reject) => {
      if (stop.aborted) reject(stop.reason)
      else stop.addEventListener('abort', () => reject(stop.reason), { once: true })
    })
  })
  return { ctx: { agents: { create }, logger: { warn: vi.fn() } } as unknown as Context,
    create, signal: () => signal }
}

it('records a deadline that aborts Agent creation as cancellation', async () => {
  const pending = pendingContext()
  const item = { ...execution(), deadlineMS: Date.now() + 50 }
  const result = await runGovernedTask(pending.ctx, item, binding, config.nodeId, new AbortController().signal)
  expect(pending.create).toHaveBeenCalledTimes(1)
  expect(pending.signal()?.aborted).toBe(true)
  expect(result.state).toBe('CANCELLED')
})

it('keeps execution and cancellation polling live while a result delivery is waiting', async () => {
  vi.useFakeTimers()
  const store = fakeStore()
  const pending = pendingContext()
  let finishDelivery!: () => void
  store.deliver.mockImplementationOnce(() => new Promise<void>(resolve => { finishDelivery = resolve }))
  store.take.mockResolvedValueOnce(execution())
  const worker = startGovernedDispatch(pending.ctx, store, vi.fn())
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(pending.create).toHaveBeenCalledTimes(1)
    worker.stop('other-realm', 'run-1')
    expect(pending.signal()?.aborted).toBe(false)
    worker.stop(config.realm, 'run-1')
    await vi.advanceTimersByTimeAsync(1)
    expect(store.save.mock.calls[0]?.[1].state).toBe('CANCELLED')
  } finally {
    finishDelivery()
    await worker.close()
  }
})

it('cancels active execution when its authority check fails', async () => {
  vi.useFakeTimers()
  const pending = pendingContext()
  const store = fakeStore()
  store.take.mockResolvedValueOnce(execution())
  store.shouldStop.mockRejectedValueOnce(new Error('database unavailable'))
  const onError = vi.fn()
  const worker = startGovernedDispatch(pending.ctx, store, onError)
  try {
    await vi.advanceTimersByTimeAsync(1001)
    expect(pending.signal()?.aborted).toBe(true)
    expect(store.save.mock.calls[0]?.[1].state).toBe('CANCELLED')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'database unavailable' }))
  } finally { await worker.close() }
})

it('does not retry immutable result conflicts or rerun the accepted task', async () => {
  vi.useFakeTimers()
  const pending = pendingContext()
  const store = fakeStore()
  store.take.mockResolvedValueOnce({ ...execution(), cancelled: true })
  store.save.mockRejectedValue(new ExecutionConflictError('recovered by another instance'))
  const worker = startGovernedDispatch(pending.ctx, store, vi.fn())
  try {
    await vi.advanceTimersByTimeAsync(3001)
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(pending.create).not.toHaveBeenCalled()
  } finally { await worker.close() }
})

it('persists cancellation if shutdown occurs during the admission transaction', async () => {
  vi.useFakeTimers()
  const pending = pendingContext()
  const store = fakeStore()
  let accept!: (item: GovernedExecution) => void
  store.take.mockImplementationOnce(() => new Promise(resolve => { accept = resolve }))
  const worker = startGovernedDispatch(pending.ctx, store, vi.fn())
  await vi.advanceTimersByTimeAsync(1)
  const closed = worker.close()
  accept(execution())
  await closed
  expect(pending.create).not.toHaveBeenCalled()
  expect(store.save.mock.calls[0]?.[1].state).toBe('CANCELLED')
})
