import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply as mountMetering } from '../../metering/src/index.ts'
import { PgMeteringSeam } from '../../metering/src/pg-meter.ts'
import { freshSchemaDsn } from '../../storage/__tests__/pg-schema.ts'
import { SessionMeterRegistry, type SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'
import type { ScopeCapSeam } from '../../../shared/seam-contracts/metering.ts'
import { runGovernedTask } from '../src/governed-run.ts'
import { binding, config, execution } from './governed-fixtures.ts'

const pgTest = process.env.LUMO_TEST_PG_DSN ? it : it.skip
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

async function fixture(chunks?: () => AsyncIterable<StreamChunk>) {
  const dsn = await freshSchemaDsn(process.env.LUMO_TEST_PG_DSN!, 'agent_metering')
  const meter = new PgMeteringSeam(dsn)
  closers.push(() => meter.close())
  await meter.init()
  await meter.raw(`CREATE TABLE llm_providers(model TEXT PRIMARY KEY, price_in_per_mtok NUMERIC,
    price_out_per_mtok NUMERIC); INSERT INTO llm_providers VALUES('mock',100,200)`)
  await meter.setBudget('user', binding.userId, 1_000_000)
  await meter.setBudget('project', binding.projectId, 1_000_000)
  const ctx = new Context()
  closers.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const requests: GenerateOptions[] = []
  const errors: string[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
  ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      if (chunks) { yield* chunks(); return }
      yield { type: 'text-delta', index: 0, text: 'Verified deliverable' }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })())
  mountMetering(ctx, { connectionString: dsn, userId: 'node-owner', projectId: 'node-project',
    deptId: 'dept', role: 'member', agentId: 'node-agent', componentId: 'node', feature: 'default',
    defaultBudget: 1_000_000, ledgerTransport: 'rmq' })
  return { ctx, meter, requests, errors, caps: ctx.get('meteringCaps') as ScopeCapSeam,
    scope: ctx.get('meteringScope') as SessionMeterScope }
}

pgTest('真实 Agent 的 sessionId/usage 进入 PG，归因到绑定 owner/project/run，下一次调用受会话金额上限约束', async () => {
  const { ctx, meter, requests, errors, caps, scope } = await fixture()
  const item = execution()
  item.preset.max_budget_cents = 5
  const result = await runGovernedTask(ctx, item, binding, config.nodeId, new AbortController().signal)
  expect(result.state, JSON.stringify({ summary: result.summary, errors })).toBe('COMPLETED')
  expect(requests[0]?.sessionId).toBe(item.sessionRef)
  expect(await caps.spentCents('governed-run', item.sessionRef)).toBeCloseTo(12)
  expect(await meter.balance({ kind: 'user', id: binding.userId })).toBe(998900)
  expect(await meter.balance({ kind: 'user', id: 'node-owner' })).toBe(1_000_000)
  expect(scope.resolve(item.sessionRef)).toBeUndefined()
  const events = await meter.raw<{ payload: { traceId: string; qty: number; context: Record<string, string> } }>('SELECT payload FROM usage_event_outbox')
  expect(events).toHaveLength(1)
  expect(events[0]!.payload).toMatchObject({ traceId: 'run:run-1', qty: 1100, context: {
    userId: binding.userId, projectId: binding.projectId, agentId: binding.agentId,
    sessionRef: item.sessionRef, feature: `governed:${item.task.id}` } })
  await meter.drainOnce()
  expect(await meter.byTrace('run:run-1')).toHaveLength(1)
  await expect(consume(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: SessionId(item.sessionRef) }))).rejects.toThrow('denied-scope-budget')
  expect(requests).toHaveLength(1)
})

pgTest('重复 usage 是累计快照，消费者提前结束仍同步扣账，不能用下一次请求抢过预算', async () => {
  const { ctx, meter, caps } = await fixture(async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }
    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 100 } }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await caps.setCap('governed-run', 'partial-session', 5)
  for await (const chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: SessionId('partial-session') })) {
    if (chunk.type === 'text-delta') break
  }
  expect(await caps.spentCents('governed-run', 'partial-session')).toBeCloseTo(12)
  expect((await meter.raw<{ payload: { qty: number } }>('SELECT payload FROM usage_event_outbox'))[0]!.payload.qty).toBe(1100)
})

pgTest('模型在报告 usage 后失败仍记录已知消耗；无 usage 的失败不编造账单', async () => {
  let report = true
  const { ctx, meter } = await fixture(async function* () {
    if (report) yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    throw new Error('adapter failed')
  })
  await consume(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: SessionId('failed-session') }))
  report = false
  await consume(ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [], sessionId: SessionId('no-usage-session') }))
  expect((await meter.raw<{ payload: { qty: number } }>('SELECT payload FROM usage_event_outbox')).map(row => row.payload.qty)).toEqual([12])
})

it('会话计量绑定拒绝覆盖、复制入参和读回值，旧释放器不能撤销新绑定', () => {
  const scope = new SessionMeterRegistry()
  const input = { context: { userId: 'u', projectId: 'p', agentId: 'a', componentId: 'c', feature: 'f' }, traceId: 'run:r' }
  const release = scope.bind('s', input)
  input.context.userId = 'forged'
  expect(scope.resolve('s')!.context.userId).toBe('u')
  expect(() => scope.bind('s', input)).toThrow('already bound')
  scope.resolve('s')!.context.userId = 'forged'
  expect(scope.resolve('s')!.context.userId).toBe('u')
  release()
  const next = scope.bind('s', input)
  release()
  expect(scope.resolve('s')).toBeDefined()
  next()
  expect(scope.resolve('s')).toBeUndefined()
})

async function consume(stream: AsyncIterable<StreamChunk>) { for await (const _ of stream) { /* consume */ } }
