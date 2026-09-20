import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { runGovernedTask, startGovernedDispatch } from '../src/governed-run.ts'
import { ExecutionConflictError, type GovernedExecution, type GovernedResult } from '../src/governed-dispatch.ts'
import { binding, config, execution } from './governed-fixtures.ts'
import { KNOWLEDGE_TOOL_NAMES } from '../../../shared/seam-contracts/knowledge.ts'

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

/**
 * 金额上限（`max_budget_cents`）的接线：**开跑前封顶，且拿不到执法面就拒绝开跑**。
 *
 * 这两条是一对：只做前者会得到一个「设了上限但没人执法」的执行，它与「没设上限」在结果上
 * 完全一样，而运维以为前者受着管；只做后者则上限永远不会被设上。判据出自
 * `assertExecutionPreset` 的原话——capabilities 必须**先有执法**才能加进 profile。
 */
it('refuses to start when the preset caps spend but the node cannot enforce it', async () => {
  const { ctx, requests } = await context('must not run')
  const item = execution()
  item.preset = { ...item.preset, max_budget_cents: 500 }
  const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal)
  expect(result.state).toBe('FAILED')
  // 摘要必须**说清是开跑前拒绝**。若它退化成模板化的「inspect its session log」，排查的人
  // 会去翻会话日志，而真相是「这个节点没装执法面」——会话里根本没有东西可看。
  expect(result.summary).toContain('metering cap enforcement')
  expect(requests).toHaveLength(0)
})

it('installs the scope cap from the preset before the first model call', async () => {
  const { ctx } = await context('ok')
  const calls: Array<[string, string, number]> = []
  ctx.provide('meteringCaps', {
    setCap: async (scope: string, id: string, cents: number) => { calls.push([scope, id, cents]) },
    clearCap: async () => undefined,
    spentCents: async () => undefined,
  })
  const item = execution()
  item.preset = { ...item.preset, max_budget_cents: 500 }
  const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal)
  expect(result.state).toBe('COMPLETED')
  // id 取会话 ref：计量截面按同一个键扣减，两边拼错一个字符的症状是「上限设了但从不生效」。
  expect(calls).toEqual([['governed-run', 'session-run-1', 500]])
})

it('leaves the cap alone when the preset sets none', async () => {
  const { ctx } = await context('ok')
  const calls: unknown[] = []
  ctx.provide('meteringCaps', {
    setCap: async (...args: unknown[]) => { calls.push(args) },
    clearCap: async () => undefined,
    spentCents: async () => undefined,
  })
  await runGovernedTask(ctx, execution(), binding, config.nodeId, new AbortController().signal)
  // 0 = 不限额，不是「上限 0 分」。设上去会让每一次没配预算的执行一开跑就被拒。
  expect(calls).toHaveLength(0)
})

/**
 * 知识空间（`knowledge_space_ids`）的接线：**按预设设收窄条件，且拿不到注册表就拒绝开跑**。
 *
 * 授权层的读法与契约层**方向相反**，这是刻意的：预设**列出**了空间才是「允许读知识」的证据，
 * 留空读作**不授予**（少给一次权限只是功能没开，多给一次就是一个没人打算开的读取面）。
 */
it('refuses to start when the preset scopes knowledge but the node has no registry', async () => {
  const { ctx, requests } = await context('must not run')
  const item = execution()
  item.preset = { ...item.preset, knowledge_space_ids: ['space-a'] }
  const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal)
  expect(result.state).toBe('FAILED')
  expect(result.summary).toContain('knowledge scope registry')
  expect(requests).toHaveLength(0)
})

/**
 * 注册两个**同名桩工具**。
 *
 * `tools.restrict` 对不认识的名字**抛错**，而生产里「scope 与两个知识工具出自同一个插件的
 * 同一次 apply」这条不变式，在本文件里被手搓的假 scope 破坏了——不补桩的话，用例会以
 * 「restrict 报未知工具」失败，而那与本次要测的东西无关。补桩让 ctx 的形状与生产一致。
 */
function registerKnowledgeToolStubs(ctx: Context): void {
  for (const name of KNOWLEDGE_TOOL_NAMES) {
    ctx.tools.register({
      name, description: 'stub', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}),
    } as never)
  }
}

it('installs the knowledge scope from the preset and clears it afterwards', async () => {
  const { ctx } = await context('ok')
  registerKnowledgeToolStubs(ctx)
  const set: Array<[string, readonly string[]]> = []
  const cleared: string[] = []
  ctx.provide('knowledgeScope', {
    set: (ref: string, spaces: readonly string[]) => { set.push([ref, spaces]) },
    clear: (ref: string) => { cleared.push(ref) },
    spacesFor: () => undefined,
  })
  const item = execution()
  item.preset = { ...item.preset, knowledge_space_ids: ['space-a', 'space-b'] }
  const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal)
  expect(result.state).toBe('COMPLETED')
  expect(set).toEqual([['session-run-1', ['space-a', 'space-b']]])
  // **必须清**：受治理执行的会话 id 从 run_id 确定性派生，同一个 run 重试会算出同一个
  // sessionRef——不清就会读到上一次执行留下的空间清单。
  expect(cleared).toEqual(['session-run-1'])
})

it('does not touch the knowledge scope when the preset lists no spaces', async () => {
  const { ctx } = await context('ok')
  const calls: unknown[] = []
  ctx.provide('knowledgeScope', {
    set: (...args: unknown[]) => { calls.push(args) },
    clear: (...args: unknown[]) => { calls.push(args) },
    spacesFor: () => undefined,
  })
  await runGovernedTask(ctx, execution(), binding, config.nodeId, new AbortController().signal)
  // 留空 = 不授予知识（授权层），而不是「不限制空间」（契约层）。两者方向相反是刻意的。
  expect(calls).toHaveLength(0)
})
