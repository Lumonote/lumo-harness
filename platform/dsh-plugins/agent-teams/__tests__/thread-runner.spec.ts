import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId, SessionSeq } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import * as JsonlSessionPersistence from '../../../../deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import { defineContentToolFixture } from '../../../../deepseek-harness/packages/test-support/tool-testkit/lib/index.js'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { SessionMeterRegistry } from '../../../shared/seam-contracts/meter-attribution.ts'
import { createLocalThreadRunner, threadRoundRunId, type LocalThreadRunnerOptions, type ThreadRoundAdmissionRequest,
  type ThreadRoundAuthorization, type ThreadRoundReceipt, type ThreadRoundStore } from '../src/thread-runner.ts'
import type { ThreadRow } from '../src/thread.ts'

const resources: { root: string; contexts: Context[] }[] = []
afterEach(async () => {
  for (const item of resources.splice(0)) {
    for (const ctx of item.contexts.reverse()) await ctx.fiber.dispose()
    await rm(item.root, { recursive: true, force: true })
  }
})

// The Go store's transaction is tested against PostgreSQL separately. This
// fixture models its exact immutable admission contract for real Agent tests.
class RoundStore implements ThreadRoundStore {
  entries = new Map<string, { request: ThreadRoundAdmissionRequest; token: string; receipt?: ThreadRoundReceipt }>()
  failFinish = false
  async admit(request: ThreadRoundAdmissionRequest) {
    const previous = this.entries.get(request.runId)
    if (previous) {
      if (previous.request.requestHash !== request.requestHash) throw new Error('round input conflict')
      return { kind: 'replay' as const, receipt: previous.receipt ?? {
        runId: request.runId, state: 'uncertain' as const, summary: 'Previously admitted; no durable result. Not replayed.',
      } }
    }
    const rounds = [...this.entries.values()].filter(item => item.request.thread.id === request.thread.id)
    if (rounds.some(item => !item.receipt || item.receipt.state !== 'completed')) throw new Error('previous round is unfinished')
    if (rounds.some(item => item.request.ownerUserId !== request.ownerUserId || item.request.agentId !== request.agentId
      || item.request.presetRevision !== request.presetRevision || item.request.provider !== request.provider || item.request.model !== request.model
      || item.request.maxConcurrency !== request.maxConcurrency
      || item.request.thread.session_ref !== request.thread.session_ref)) throw new Error('session identity conflict')
    const token = `token-${request.runId}`
    this.entries.set(request.runId, { request: structuredClone(request), token })
    return { kind: 'admitted' as const, token, sessionMode: rounds.length ? 'resume' as const : 'create' as const }
  }
  async finish(request: ThreadRoundAdmissionRequest, token: string, receipt: ThreadRoundReceipt) {
    if (this.failFinish) throw new Error('receipt transport unavailable')
    const entry = this.entries.get(request.runId)
    if (!entry || entry.token !== token) throw new Error('stale round token')
    entry.receipt = structuredClone(receipt)
  }
}

const authorization: ThreadRoundAuthorization = { userId: 'owner-1', projectId: 'project-1', agentId: 'agent-1',
  presetRevision: 1, provider: 'mock', model: 'mock', maxConcurrency: 1, systemPrompt: 'Use the approved project evidence.' }
const initial: ThreadRow = { id: 'thread-1', realm: 'realm-1', project_id: 'project-1', task_id: 'task-1',
  coordinator_session_ref: 'coordinator-1', session_ref: 'stable-thread-1', node_id: 'node-1', workspace: 'thread/thread-1/',
  state: 'idle', created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }

function input(attempt = 1, prompt = 'First round objective', thread = initial) {
  return { thread, round: { task_id: thread.task_id, attempt }, prompt, parent: { cwd: '/untrusted-parent' }, signal: new AbortController().signal }
}

async function fixture(responses = ['first deliverable', 'second deliverable']) {
  const root = await mkdtemp(join(tmpdir(), 'lumo-thread-runner-'))
  const contexts: Context[] = []
  resources.push({ root, contexts })
  const workspaceRoot = join(root, 'workspaces')
  const workspace = join(workspaceRoot, 'thread', initial.id)
  await mkdir(workspace, { recursive: true })
  const store = new RoundStore()
  const meters = new SessionMeterRegistry()
  const requests: GenerateOptions[] = []
  const attributions: ReturnType<SessionMeterRegistry['resolve']>[] = []
  let next = 0
  async function context() {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        attributions.push(meters.resolve(initial.session_ref))
        const text = responses[next++] ?? ''
        if (text) yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })())
    return ctx
  }
  const ctx = await context()
  const options: LocalThreadRunnerOptions = { ctx, realm: initial.realm, nodeId: initial.node_id, workspaceRoot,
    workspace: async () => workspace, authorize: async () => authorization, roundStore: store,
    persistence: ctx.sessionPersistence, meterScope: meters }
  return { ctx, options, root, workspace, workspaceRoot, context, store, meters, requests, attributions }
}

describe('fixed-node Thread execution through public Agent APIs', () => {
  it('uses different deterministic run and trace identities for otherwise identical Threads in distinct realms', () => {
    const round = { task_id: initial.task_id, attempt: 1 }
    expect(threadRoundRunId(initial.id, round, initial.realm)).not.toBe(threadRoundRunId(initial.id, round, 'another-realm'))
    expect(() => threadRoundRunId(initial.id, round, '')).toThrow('realm')
  })

  it('resumes the same durable session over two rounds and a complete runtime restart, with per-round metering', async () => {
    const f = await fixture()
    const first = createLocalThreadRunner(f.options)
    await expect(first.start(input())).resolves.toEqual({ runId: threadRoundRunId(initial.id, input().round, initial.realm), summary: 'first deliverable' })
    expect(f.ctx.agents.get(SessionId(initial.session_ref))).toBeUndefined()
    expect(f.meters.resolve(initial.session_ref)).toBeUndefined()
    await f.ctx.fiber.dispose()
    const restarted = await f.context()
    const second = createLocalThreadRunner({ ...f.options, ctx: restarted, persistence: restarted.sessionPersistence })
    const round2 = input(2, 'Continue using the previous result', { ...initial, state: 'awaiting' })
    await second.start(round2)
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1])).toContain('first deliverable')
    expect(JSON.stringify(f.requests[1])).toContain('First round objective')
    expect(JSON.stringify(f.requests[1])).toContain('Continue using the previous result')
    expect(JSON.stringify(f.requests[1])).not.toContain('/untrusted-parent')
    expect(f.attributions.map(item => item?.traceId)).toEqual([
      `run:${threadRoundRunId(initial.id, input().round, initial.realm)}`, `run:${threadRoundRunId(initial.id, round2.round, initial.realm)}`,
    ])
    const stored = await restarted.sessionPersistence.open(SessionId(initial.session_ref), 'read')
    try {
      expect(stored.header.cwd).toBe(await realpath(f.workspace))
      const log = await stored.read()
      expect(log.events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    } finally { await stored.close() }
    expect([...f.store.entries.values()].map(item => item.receipt?.summary)).toEqual(['first deliverable', 'second deliverable'])
  })

  it('replays an immutable success without running another model turn, including a terminal Thread snapshot', async () => {
    const f = await fixture()
    const runner = createLocalThreadRunner(f.options)
    const first = await runner.start(input())
    await expect(runner.start(input(1, 'First round objective', { ...initial, state: 'done' }))).resolves.toEqual(first)
    await expect(runner.start(input(1, 'changed objective'))).rejects.toThrow('round input conflict')
    expect(f.requests).toHaveLength(1)
  })

  it('executes the admitted prompt snapshot when the caller mutates its request during durable admission', async () => {
    const f = await fixture()
    const admit = f.store.admit.bind(f.store)
    const original = input()
    f.store.admit = async request => {
      original.prompt = 'Unadmitted replacement prompt'
      original.round.attempt = 9
      original.thread = { ...initial, session_ref: 'unadmitted-session' }
      return admit(request)
    }
    await createLocalThreadRunner(f.options).start(original)
    expect(JSON.stringify(f.requests[0])).toContain('First round objective')
    expect(JSON.stringify(f.requests[0])).not.toContain('Unadmitted replacement prompt')
    expect(f.requests[0]?.sessionId).toBe(initial.session_ref)
    expect([...f.store.entries.values()][0]?.request.round.attempt).toBe(1)
  })

  it('does not reexecute when receipt persistence fails after the model turn', async () => {
    const f = await fixture()
    const runner = createLocalThreadRunner(f.options)
    f.store.failFinish = true
    await expect(runner.start(input())).rejects.toThrow('receipt transport unavailable')
    f.store.failFinish = false
    await expect(runner.start(input())).rejects.toMatchObject({ receipt: { state: 'uncertain' } })
    expect(f.requests).toHaveLength(1)
  })

  it('admits the same round once under concurrent callers and treats the unresolved replay as uncertain', async () => {
    const f = await fixture()
    const runner = createLocalThreadRunner(f.options)
    const results = await Promise.allSettled([runner.start(input()), runner.start(input())])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
  })

  it.each(['wrong-node', 'wrong-realm', 'wrong-owner', 'wrong-project'] as const)('refuses %s before admission', async reason => {
    const f = await fixture()
    const thread = { ...initial }
    const options = { ...f.options }
    if (reason === 'wrong-node') thread.node_id = 'other'
    if (reason === 'wrong-realm') thread.realm = 'other'
    if (reason === 'wrong-owner') options.authorize = async () => { throw new Error('owner revoked') }
    if (reason === 'wrong-project') options.authorize = async () => ({ ...authorization, projectId: 'other' })
    await expect(createLocalThreadRunner(options).start(input(1, 'hello', thread))).rejects.toThrow()
    expect(f.store.entries.size).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it('requires the previous persisted session and never silently creates an empty replacement', async () => {
    const f = await fixture()
    f.store.entries.set('previous', { request: { thread: initial, round: { task_id: initial.task_id, attempt: 1 }, runId: 'previous',
      requestHash: 'previous', ownerUserId: authorization.userId, agentId: authorization.agentId, presetRevision: 1,
      provider: authorization.provider, model: authorization.model, maxConcurrency: authorization.maxConcurrency },
    token: 'previous', receipt: { runId: 'previous', state: 'completed', summary: 'previous' } })
    await expect(createLocalThreadRunner(f.options).start(input(2, 'continue'))).rejects.toMatchObject({ receipt: { state: 'failed' } })
    expect(f.requests).toHaveLength(0)
    expect(await f.ctx.sessionPersistence.stat(SessionId(initial.session_ref))).toBeUndefined()
  })

  it('refuses durable pending input before publishing a resumed Agent', async () => {
    const f = await fixture()
    await createLocalThreadRunner(f.options).start(input())
    const writer = await f.ctx.sessionPersistence.open(SessionId(initial.session_ref), 'write')
    const log = await writer.read()
    await writer.append([{ type: 'agent/inbox/spliced', seq: SessionSeq(log.events.length), time: Date.now(),
      data: { target: 'next-turn', start: 0, removedCount: 0,
        inserted: [createUserMessage({ content: [{ type: 'text', text: 'unaccounted input' }], source: { kind: 'user' } })] } }])
    await writer.close()
    await expect(createLocalThreadRunner(f.options).start(input(2, 'continue'))).rejects.toMatchObject({ receipt: { state: 'failed' } })
    expect(f.requests).toHaveLength(1)
  })

  it('does not report the preceding round output when the new round has no deliverable', async () => {
    const f = await fixture(['previous deliverable', ''])
    const runner = createLocalThreadRunner(f.options)
    await runner.start(input())
    await expect(runner.start(input(2, 'new round'))).rejects.toMatchObject({ receipt: { state: 'failed' } })
    const receipt = [...f.store.entries.values()].at(-1)?.receipt
    expect(receipt?.summary).not.toContain('previous deliverable')
  })

  it('blocks an ancestor symlink even when the final workspace directory is ordinary', async () => {
    const f = await fixture()
    await rm(join(f.workspaceRoot, 'thread'), { recursive: true })
    const outside = join(f.root, 'outside')
    await mkdir(join(outside, initial.id), { recursive: true })
    await symlink(outside, join(f.workspaceRoot, 'thread'))
    await expect(createLocalThreadRunner(f.options).start(input())).rejects.toMatchObject({ receipt: { state: 'failed' } })
    expect(f.requests).toHaveLength(0)
  })

  it('denies execution without trusted metering and requires explicit runtime limits', async () => {
    const f = await fixture()
    expect(() => createLocalThreadRunner({ ...f.options, meterScope: undefined! })).toThrow('metering')
    expect(() => createLocalThreadRunner({ ...f.options, timeoutMs: Infinity })).toThrow('timeout')
  })

  it.each([undefined, 0, -1, 1.5, Infinity])('refuses invalid trusted maxConcurrency %s before admission', async maxConcurrency => {
    const f = await fixture()
    const authorize = async () => ({ ...authorization, maxConcurrency: maxConcurrency as number })
    await expect(createLocalThreadRunner({ ...f.options, authorize }).start(input())).rejects.toThrow('authorization')
    expect(f.store.entries.size).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it('includes the authorized concurrency bound in the durable request hash', async () => {
    const f = await fixture()
    const runner = createLocalThreadRunner(f.options)
    await runner.start(input())
    expect([...f.store.entries.values()][0]?.request.maxConcurrency).toBe(1)
    const changed = createLocalThreadRunner({ ...f.options, authorize: async () => ({ ...authorization, maxConcurrency: 2 }) })
    await expect(changed.start(input())).rejects.toThrow('round input conflict')
    expect(f.requests).toHaveLength(1)
  })

  it('cancels before the first turn if authorization changes after durable admission', async () => {
    const f = await fixture()
    const authorize = vi.fn().mockResolvedValueOnce(authorization).mockResolvedValue({ ...authorization, presetRevision: 2 })
    await expect(createLocalThreadRunner({ ...f.options, authorize }).start(input())).rejects.toMatchObject({ receipt: { state: 'failed' } })
    expect(f.requests).toHaveLength(0)
    expect(f.meters.resolve(initial.session_ref)).toBeUndefined()
  })

  it('denies a scoped tool installed after setup and does not inherit global tools', async () => {
    const f = await fixture()
    const execute = vi.fn(async () => [{ type: 'text' as const, text: 'unauthorized data' }])
    const definition = (name: string) => defineContentToolFixture({ name, description: name, parameters: {}, execute })
    f.ctx.tools.register(definition('global_secret'))
    f.ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.register(definition('scoped_secret'))
      return undefined
    })
    const adapter = new MockAdapter([toolCallResponse('denied-call', 'scoped_secret', {}), textResponse('No tool data was accessed')])
    f.ctx.llm.registerAdapter(['guard-test'], adapter)
    await createLocalThreadRunner({ ...f.options, authorize: async () => ({ ...authorization, provider: 'guard-test' }) }).start(input())
    expect(execute).not.toHaveBeenCalled()
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['scoped_secret'])
    expect(JSON.stringify(adapter.requests[1])).toContain('Thread execution does not grant tool access')
    expect(JSON.stringify(adapter.requests[1])).not.toContain('unauthorized data')
  })

  it.each(['revocation', 'timeout'] as const)('stops a live model stream on %s and retains the cancelled receipt', async reason => {
    const f = await fixture()
    let started!: () => void
    const active = new Promise<void>(resolve => { started = resolve })
    f.ctx.llm.registerAdapter(['hanging'], new (class extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'partial output' }
        started()
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) return reject(options.signal.reason)
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      }
    })())
    let revoked = false
    const runner = createLocalThreadRunner({ ...f.options, authorityPollMs: 10, timeoutMs: reason === 'timeout' ? 50 : 5_000,
      authorize: async () => { if (revoked) throw new Error('owner revoked'); return { ...authorization, provider: 'hanging' } } })
    const running = runner.start(input())
    const rejected = expect(running).rejects.toMatchObject({ receipt: { state: 'cancelled' } })
    await active
    if (reason === 'revocation') revoked = true
    await rejected
    expect(f.ctx.agents.get(SessionId(initial.session_ref))).toBeUndefined()
    expect(f.meters.resolve(initial.session_ref)).toBeUndefined()
    expect([...f.store.entries.values()][0]?.receipt?.state).toBe('cancelled')
    await expect(runner.start(input())).rejects.toThrow()
  })

  it('waits for the in-flight authority read before accepting a completed model result', async () => {
    const f = await fixture()
    let finishModel!: () => void
    let pendingCheck!: () => void
    let rejectCheck!: (error: Error) => void
    const polled = new Promise<void>(resolve => { pendingCheck = resolve })
    const modelFinished = new Promise<void>(resolve => { finishModel = resolve })
    f.ctx.llm.registerAdapter(['authority-race'], new (class extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        await modelFinished
        yield { type: 'text-delta', index: 0, text: 'apparently complete' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })())
    let count = 0
    const authorize = async () => {
      if (++count === 4) {
        pendingCheck()
        await new Promise<void>((_resolve, reject) => { rejectCheck = reject })
      }
      return { ...authorization, provider: 'authority-race' }
    }
    const running = createLocalThreadRunner({ ...f.options, authorize, authorityPollMs: 10 }).start(input())
    const rejected = expect(running).rejects.toMatchObject({ receipt: { state: 'cancelled' } })
    await polled
    finishModel()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect([...f.store.entries.values()][0]?.receipt).toBeUndefined()
    rejectCheck(new Error('authority revoked during final read'))
    await rejected
    expect([...f.store.entries.values()][0]?.receipt?.state).toBe('cancelled')
  })
})
