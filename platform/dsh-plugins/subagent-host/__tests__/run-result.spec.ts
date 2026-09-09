import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { runChild, type ResultDelivery, type RunRegistry } from '../src/run.ts'
import type { StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

const request: StartChildRequest = {
  childId: 'child', realm: 'realm', prompt: [{ type: 'text', text: 'produce the result' }],
  descriptor: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'task' },
  parent: { sessionId: 'parent', delegationDepth: 0, provider: 'mock', model: 'mock' },
  callbackUrl: 'http://parent.invalid/subagent/result/child/0123456789abcdef',
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function context() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'verified output' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })())
  return ctx
}

describe('child execution result persistence', () => {
  it('publishes one successful result using the DSH execution path', async () => {
    const ctx = await context()
    const delivery = vi.fn<ResultDelivery>().mockResolvedValue(undefined)
    const runs: RunRegistry = new Map()
    await runChild(ctx, request, runs, delivery)
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(delivery.mock.calls[0]?.[1]).toMatchObject({ runId: 'child', ok: true, stopReason: 'completed',
      output: [{ type: 'text', text: 'verified output' }] })
    expect(runs.size).toBe(0)
  })

  it('does not turn a persistence failure into a second execution result', async () => {
    const ctx = await context()
    const delivery = vi.fn<ResultDelivery>().mockRejectedValue(new Error('database offline'))
    const runs: RunRegistry = new Map()
    await expect(runChild(ctx, request, runs, delivery)).rejects.toThrow('database offline')
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(delivery.mock.calls[0]?.[1]).toMatchObject({ ok: true, stopReason: 'completed' })
    expect(runs.size).toBe(0)
  })

  it('keeps a successful result when the job-control projection fails', async () => {
    const ctx = await context()
    Object.defineProperty(ctx, 'jobControlRuntime', { value: {
      register: vi.fn().mockResolvedValue({ sessionRef: 'parent', node: 'node', jobId: 'child' }),
      settle: vi.fn().mockRejectedValue(new Error('job projection offline')),
    } })
    const delivery = vi.fn<ResultDelivery>().mockResolvedValue(undefined)
    await runChild(ctx, request, new Map(), delivery)
    expect(delivery.mock.calls[0]?.[1]).toMatchObject({ ok: true, stopReason: 'completed' })
  })

  it('reports registration failure and releases the run entry', async () => {
    const create = vi.fn()
    const ctx = { agents: { create }, logger: { error: vi.fn(), warn: vi.fn() },
      jobControlRuntime: { register: vi.fn().mockRejectedValue(new Error('offline')) },
    } as unknown as Context
    const delivery = vi.fn<ResultDelivery>().mockResolvedValue(undefined)
    const runs: RunRegistry = new Map()
    await runChild(ctx, request, runs, delivery)
    expect(create).not.toHaveBeenCalled()
    expect(delivery.mock.calls[0]?.[1]).toMatchObject({ runId: 'child', ok: false, code: 'internal' })
    expect(runs.size).toBe(0)
  })
})
