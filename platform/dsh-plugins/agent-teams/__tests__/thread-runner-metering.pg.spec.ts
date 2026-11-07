import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import * as JsonlSessionPersistence from '../../../../deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import { apply as mountMetering } from '../../metering/src/index.ts'
import { PgMeteringSeam } from '../../metering/src/pg-meter.ts'
import { freshSchemaDsn } from '../../storage/__tests__/pg-schema.ts'
import type { SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'
import { createLocalThreadRunner, threadRoundRunId, type ThreadRoundAdmissionRequest, type ThreadRoundReceipt,
  type ThreadRoundStore } from '../src/thread-runner.ts'
import type { ThreadRow } from '../src/thread.ts'

const pgTest = process.env.LUMO_TEST_PG_DSN ? it : it.skip
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

pgTest('真实 Thread 稳定 session 跨运行时恢复双轮，真实 usage 按各轮 trace 入 PG 且采用可信 owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumo-thread-metering-'))
  closers.push(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'workspaces')
  const workspace = join(workspaceRoot, 'thread', 'thread-metering')
  await mkdir(workspace, { recursive: true })
  const dsn = await freshSchemaDsn(process.env.LUMO_TEST_PG_DSN!, 'thread_metering')
  const meter = new PgMeteringSeam(dsn)
  closers.push(() => meter.close())
  await meter.init()
  await meter.raw(`CREATE TABLE llm_providers(model TEXT PRIMARY KEY, price_in_per_mtok NUMERIC,
    price_out_per_mtok NUMERIC); INSERT INTO llm_providers VALUES('mock',100,200)`)
  const owner = { userId: 'thread-owner', projectId: 'thread-project', agentId: 'thread-agent',
    presetRevision: 3, provider: 'mock', model: 'mock', maxConcurrency: 1 }
  await meter.setBudget('user', owner.userId, 1_000_000)
  await meter.setBudget('project', owner.projectId, 1_000_000)
  const thread: ThreadRow = { id: 'thread-metering', realm: 'thread-realm', project_id: owner.projectId, task_id: 'thread-task',
    coordinator_session_ref: 'coordinator', session_ref: 'durable-thread-session', node_id: 'thread-node',
    workspace: 'thread/thread-metering/', state: 'idle', created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }
  const receipts = new Map<string, ThreadRoundReceipt>()
  const admissions = new Set<string>()
  const roundStore: ThreadRoundStore = {
    async admit(request: ThreadRoundAdmissionRequest) {
      const receipt = receipts.get(request.runId)
      if (receipt) return { kind: 'replay', receipt }
      if (admissions.has(request.runId)) throw new Error('uncertain admitted round is not replayed')
      const sessionMode = admissions.size ? 'resume' as const : 'create' as const
      admissions.add(request.runId)
      return { kind: 'admitted', token: request.runId, sessionMode }
    },
    async finish(request, token, receipt) {
      if (token !== request.runId || !admissions.has(request.runId)) throw new Error('stale round')
      receipts.set(request.runId, structuredClone(receipt))
    },
  }
  const requests: GenerateOptions[] = []
  async function runtime(round: number) {
    const ctx = new Context()
    closers.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        yield { type: 'text-delta', index: 0, text: `Deliverable for round ${round}` }
        yield { type: 'usage', usage: { inputTokens: 1_000 * round, outputTokens: 100 * round } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })())
    mountMetering(ctx, { connectionString: dsn, userId: 'node-owner', projectId: 'node-project',
      deptId: 'dept', role: 'member', agentId: 'node-agent', componentId: 'node', feature: 'default',
      defaultBudget: 1_000_000, ledgerTransport: 'rmq' })
    const scope = ctx.get('meteringScope') as SessionMeterScope
    const runner = createLocalThreadRunner({ ctx, realm: thread.realm, nodeId: thread.node_id, workspaceRoot,
      workspace: async () => workspace, authorize: async () => owner, persistence: ctx.sessionPersistence, roundStore, meterScope: scope })
    return { ctx, scope, runner }
  }
  const first = await runtime(1)
  const round1 = { task_id: thread.task_id, attempt: 1 }
  const input1 = { thread, round: round1, prompt: 'Produce the first durable result', parent: undefined, signal: new AbortController().signal }
  await first.runner.start(input1)
  expect(first.scope.resolve(thread.session_ref)).toBeUndefined()
  expect(first.ctx.agents.get(SessionId(thread.session_ref))).toBeUndefined()
  await first.ctx.fiber.dispose()

  const second = await runtime(2)
  const round2 = { task_id: thread.task_id, attempt: 2 }
  const result2 = await second.runner.start({ ...input1, thread: { ...thread, state: 'awaiting' }, round: round2, prompt: 'Continue from the first result' })
  expect(result2.runId).not.toBe(threadRoundRunId(thread.id, round1, thread.realm))
  expect(second.scope.resolve(thread.session_ref)).toBeUndefined()
  expect(second.ctx.agents.get(SessionId(thread.session_ref))).toBeUndefined()
  expect(requests.map(request => request.sessionId)).toEqual([thread.session_ref, thread.session_ref])
  expect(JSON.stringify(requests[1])).toContain('Deliverable for round 1')
  expect(JSON.stringify(requests[1])).toContain('Continue from the first result')
  const stored = await second.ctx.sessionPersistence.open(SessionId(thread.session_ref), 'read')
  try {
    expect(stored.header.cwd).toBe(await realpath(workspace))
    expect((await stored.read()).events.filter(event => event.type === 'turn/end')).toHaveLength(2)
  } finally { await stored.close() }

  const events = await meter.raw<{ payload: { traceId: string; qty: number; costUsd: number; context: Record<string, string> } }>(
    'SELECT payload FROM usage_event_outbox ORDER BY seq')
  expect(events.map(event => event.payload.traceId)).toEqual([
    `run:${threadRoundRunId(thread.id, round1, thread.realm)}`, `run:${threadRoundRunId(thread.id, round2, thread.realm)}`,
  ])
  expect(events.map(event => event.payload.qty)).toEqual([1_100, 2_200])
  for (const event of events) expect(event.payload.context).toMatchObject({ userId: owner.userId, projectId: owner.projectId,
    agentId: owner.agentId, componentId: 'agent-teams', feature: `thread:${thread.id}`, sessionRef: thread.session_ref })
  expect(await meter.balance({ kind: 'user', id: owner.userId })).toBe(996_700)
  expect(await meter.balance({ kind: 'project', id: owner.projectId })).toBe(996_700)
  expect(await meter.balance({ kind: 'user', id: 'node-owner' })).toBe(1_000_000)
  expect(await meter.balance({ kind: 'project', id: 'node-project' })).toBe(1_000_000)
  await meter.drainOnce()
  const trace1 = await meter.byTrace(`run:${threadRoundRunId(thread.id, round1, thread.realm)}`)
  const trace2 = await meter.byTrace(`run:${threadRoundRunId(thread.id, round2, thread.realm)}`)
  expect(trace1).toHaveLength(1)
  expect(trace2).toHaveLength(1)
  expect(trace1[0]?.costUsd).toBeCloseTo(0.12)
  expect(trace2[0]?.costUsd).toBeCloseTo(0.24)

  await second.runner.start(input1)
  expect(requests).toHaveLength(2)
  expect(await meter.balance({ kind: 'user', id: owner.userId })).toBe(996_700)
})
