import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import * as JsonlPersistence from '../../../../deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import TypertRegistry from '../../../../deepseek-harness/packages/typert/registry/lib/index.js'
import RemoteAccess from '../../../../deepseek-harness/packages/api/remote-access/lib/index.js'
import Gateway from '../../../../deepseek-harness/packages/api/gateway/lib/index.js'
import { Peer } from '../../../../deepseek-harness/packages/client/connection/lib/index.js'
import Controller from '../../../../deepseek-harness/packages/api/session-controller/lib/index.js'
import QueryEngine from '../../../../deepseek-harness/packages/session-query/session-query/lib/index.js'
import { z } from '../../../../deepseek-harness/node_modules/zod/index.js'
import { SessionMeterRegistry } from '../../../shared/seam-contracts/meter-attribution.ts'
import type { SessionOwner } from '../../../shared/session-owners.ts'
import { createSessionTransport } from '../src/session-transport.ts'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const alice = { realm: 'r', user_id: 'alice', username: 'alice', display_name: 'Alice', roles: ['operator'], session_expires_at: '2099-01-01' }
const signal = new AbortController().signal
const authority = async () => {}

async function fixture(dynamic = false) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'owned-fork-')))
  closers.push(() => rm(temp, { recursive: true, force: true }))
  const facts = new Map<string, SessionOwner>()
  const requests: GenerateOptions[] = []
  let reservations = 0
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path === '/v1/session-owners') {
      const input = JSON.parse(String(init!.body))
      const owner: SessionOwner = { ...input, session_ref: `session-${String(++reservations).padStart(32, '0')}`, state: 'reserved', created_at: '2026-11-07T00:00:00Z' }
      facts.set(owner.session_ref, owner)
      return new Response(JSON.stringify({ owner, creation_token: 'c'.repeat(64) }))
    }
    const ref = path.split('/')[3]!
    const fact = facts.get(ref)!
    if (path.endsWith('/activate')) fact.state = 'active'
    return new Response(JSON.stringify({ owner: fact }))
  }
  async function runtime(retire = false) {
    const ctx = new Context(); closers.push(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlPersistence, { root: join(temp, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock', 'alternate'], new (class extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        yield { type: 'text-delta', index: 0, text: `Answer ${requests.length}` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    })())
    await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
    ctx.provide('connection', { createPeer: options => new Peer(ctx, options) } as never)
    const meters = new SessionMeterRegistry(); ctx.provide('meteringScope', meters)
    ctx.provide('sessionModelBilling', { quote: async (route: unknown) => route })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }), saveSelection: async () => {} } as never)
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1000, maxImagesPerMessage: 1, maxMessageImageBytes: 1000, maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: [] }, admitPromptContent: async content => content } as never)
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => undefined, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }), retirePrompt() {} } as never)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: () => undefined } as never)
    new QueryEngine(ctx)
    class TestController extends Controller { initialize() { return this[Service.init]() } }
    await new TestController(ctx, { nativeOpen: false }).initialize()
    const schema = z.object({ sessionId: z.string(), requestId: z.string(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })), mode: z.literal('queue') })
    ctx.typert.register({ package: '@lumo/owned-fork-test', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{ id: '@lumo/owned-fork-test#session/prompt', service: 'sessionController', namespace: 'session', method: 'prompt', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: '@lumo/owned#Prompt', create: () => schema } }], cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@lumo/owned#Result', create: () => z.object({ accepted: z.literal(true) }) } }] })
    const transport = createSessionTransport(ctx, { authorityUrl: 'http://owner', nodeId: 'n', projectId: 'p', workspaceRoot: join(temp, 'workspaces'), provider: 'mock', model: 'mock',
      ...(dynamic ? { modelChoices: [{ id: 'default', label: '默认', provider: 'mock', model: 'mock', billingModel: 'mock' }, ...retire ? [] : [{ id: 'alternate', label: '备用', provider: 'alternate', model: 'alternate', billingModel: 'alternate' }]] } : {}),
    }, 'test', async () => {}, fetcher)
    const send = async (sessionId: string, text: string) => {
      await transport.execute(alice, 'prompt', { sessionId, requestId: `${sessionId}-${text}`, content: [{ type: 'text', text }], mode: 'queue' }, signal, authority)
      await ctx.agents.get(SessionId(sessionId))!.whenIdle()
    }
    return { ctx, transport, send, meters }
  }
  return { runtime, facts, requests, reservations: () => reservations }
}

describe('owned Session fork with real AgentLoop and persistence', () => {
  it('inherits the completed model snapshot across fork and restart, then refuses a withdrawn route before execution', async () => {
    const f = await fixture(true), first = await f.runtime()
    const parent = (await first.transport.execute(alice, 'create', {}, signal, authority) as { sessionId: string }).sessionId
    const view = await first.transport.execute(alice, 'models', { sessionId: parent }, signal, authority) as { policy_digest: string; selection_revision: number }
    await first.transport.execute(alice, 'selectModel', { sessionId: parent, choice_id: 'alternate', expected_revision: view.selection_revision, policy_digest: view.policy_digest }, signal, authority)
    await first.send(parent, 'selected route')
    const child = (await first.transport.execute(alice, 'fork', { sessionId: parent }, signal, authority) as { sessionId: string }).sessionId
    expect(first.ctx.agents.get(SessionId(child))!.model.current()).toEqual({ provider: 'alternate', model: 'alternate' })
    await first.ctx.fiber.dispose()
    const second = await f.runtime()
    await second.send(child, 'restored route')
    expect(f.requests.map(call => [call.provider, call.model])).toEqual([['alternate', 'alternate'], ['alternate', 'alternate']])
    await second.ctx.fiber.dispose()
    const revoked = await f.runtime(true)
    await expect(revoked.transport.execute(alice, 'models', { sessionId: child }, signal, authority)).rejects.toThrow()
    expect(f.requests).toHaveLength(2)
  })
  it('allocates a same-owner branch, isolates workspace/history, and resumes after restart', async () => {
    const f = await fixture()
    const first = await f.runtime()
    const parent = (await first.transport.execute(alice, 'create', {}, signal, authority) as { sessionId: string }).sessionId
    await first.send(parent, 'first prompt')
    const child = (await first.transport.execute(alice, 'fork', { sessionId: parent }, signal, authority) as { sessionId: string }).sessionId
    expect(child).not.toBe(parent)
    expect(f.facts.get(child)).toMatchObject({ owner_user_id: 'alice', project_id: 'p', node_id: 'n', parent_session_ref: parent, state: 'active' })
    const childAgent = first.ctx.agents.get(SessionId(child))!
    expect(childAgent.session.header.cwd).not.toBe(first.ctx.agents.get(SessionId(parent))!.session.header.cwd)
    expect(childAgent.session.header.cwd).toContain(child)
    expect(first.meters.resolve(child)?.context).toMatchObject({ userId: 'alice', projectId: 'p' })
    await first.send(parent, 'later in parent')
    await first.send(child, 'branch prompt')
    const branchCall = JSON.stringify(f.requests[2])
    expect(branchCall).toContain('first prompt'); expect(branchCall).toContain('Answer 1')
    expect(branchCall).toContain('branch prompt'); expect(branchCall).not.toContain('later in parent')
    expect(f.requests[2]!.tools ?? []).toEqual([])
    await first.ctx.fiber.dispose()
    const second = await f.runtime()
    await second.send(child, 'resume branch')
    expect(JSON.stringify(f.requests[3])).toContain('branch prompt')
    expect(JSON.stringify(f.requests[3])).toContain('Answer 3')
    expect(JSON.stringify(f.requests[3])).not.toContain('later in parent')
  })

  it('rejects an empty source, foreign users, forged metadata and revoked login before allocation', async () => {
    const f = await fixture(); const r = await f.runtime()
    const parent = (await r.transport.execute(alice, 'create', {}, signal, authority) as { sessionId: string }).sessionId
    await expect(r.transport.execute(alice, 'fork', { sessionId: parent }, signal, authority)).rejects.toMatchObject({ code: 'session_fork_unavailable' })
    await r.send(parent, 'complete first')
    await expect(r.transport.execute({ ...alice, user_id: 'bob' }, 'fork', { sessionId: parent }, signal, authority)).rejects.toThrow('ownership')
    for (const extra of [{ cwd: '/private' }, { parentSessionId: parent }, { model: 'other' }, { atSeq: 0 }, { childSessionId: parent }]) {
      await expect(r.transport.execute(alice, 'fork', { sessionId: parent, ...extra }, signal, authority)).rejects.toThrow('only its source')
    }
    await expect(r.transport.execute(alice, 'fork', { sessionId: parent }, signal, async () => { throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(f.reservations()).toBe(1)
    expect(f.requests).toHaveLength(1)
  })
})
