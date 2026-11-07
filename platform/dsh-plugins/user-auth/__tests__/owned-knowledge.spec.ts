import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
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
import type { AuthenticatedKnowledgeQuery, AuthenticatedKnowledgeRequest, KnowledgeQueryPrincipal } from '../../../shared/seam-contracts/knowledge.ts'
import type { Principal } from '../src/client.ts'
import { createSessionTransport } from '../src/session-transport.ts'
import { USER_SESSION_KNOWLEDGE_TOOL, validateSessionKnowledge } from '../src/session-knowledge.ts'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const alice: Principal = { realm: 'r', user_id: 'alice', username: 'alice', display_name: 'Alice', roles: ['viewer'], session_expires_at: '2099-01-01' }
const bob: Principal = { ...alice, user_id: 'bob', roles: ['editor'] }
const signal = new AbortController().signal

async function fixture(enabled = true) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'owned-knowledge-')))
  closers.push(() => rm(temp, { recursive: true, force: true }))
  const ctx = new Context(); closers.push(() => ctx.fiber.dispose())
  const facts = new Map<string, SessionOwner>()
  const requests: GenerateOptions[] = []
  const queries: Array<{ principal: KnowledgeQueryPrincipal; request: AuthenticatedKnowledgeRequest }> = []
  let revoked = false, reservations = 0, hostCalls = 0
  let nextCall: { name: string; args: object; before?: () => void } | undefined
  let onQuery: (() => void | Promise<void>) | undefined
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === '/v1/session-owners') {
      const owner: SessionOwner = { ...JSON.parse(String(init!.body)), session_ref: `session-${String(++reservations).padStart(32, '0')}`, state: 'reserved', created_at: '2026-11-07T00:00:00Z' }
      facts.set(owner.session_ref, owner)
      return new Response(JSON.stringify({ owner, creation_token: 'c'.repeat(64) }))
    }
    const fact = facts.get(pathname.split('/')[3]!)!
    if (pathname.endsWith('/activate')) fact.state = 'active'
    return new Response(JSON.stringify({ owner: fact }))
  }
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(temp, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      const call = nextCall; nextCall = undefined
      if (call) {
        call.before?.()
        const id = ToolCallId(`query-${requests.length}`), args = JSON.stringify(call.args)
        yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: 'Answer' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  })())
  await ctx.plugin(RemoteAccess); await ctx.plugin(Gateway)
  ctx.provide('connection', { createPeer: options => new Peer(ctx, options) } as never)
  ctx.provide('meteringScope', new SessionMeterRegistry())
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }), saveSelection: async () => {} } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1000, maxImagesPerMessage: 1, maxMessageImageBytes: 1000, maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: [] }, admitPromptContent: async content => content } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => undefined, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }), retirePrompt() {} } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: () => undefined } as never)
  const query: AuthenticatedKnowledgeQuery = { async query(principal, request) {
    queries.push({ principal, request }); await onQuery?.()
    return [{ docId: `doc-${principal.userId}`, sourceVersion: 1, score: 1, text: `PRIVATE-${principal.userId}` }]
  } }
  ctx.provide('knowledgeAuthenticatedQuery', query)
  ctx.tools.register({ name: 'knowledge_query', description: 'deployment admin tool', parameters: { type: 'object', properties: {} }, output: {
    schema: { type: 'object', properties: {} }, render: () => [{ type: 'text', text: 'DEPLOYMENT-SECRET' }],
  }, async execute() { hostCalls++; return {} } })
  new QueryEngine(ctx)
  class TestController extends Controller { initialize() { return this[Service.init]() } }
  await new TestController(ctx, { nativeOpen: false }).initialize()
  const schema = z.object({ sessionId: z.string(), requestId: z.string(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })), mode: z.literal('queue') })
  ctx.typert.register({ package: '@lumo/owned-knowledge-test', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{ id: '@lumo/owned-knowledge-test#session/prompt', service: 'sessionController', namespace: 'session', method: 'prompt', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: '@lumo/owned#Prompt', create: () => schema } }], cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@lumo/owned#Result', create: () => z.object({ accepted: z.literal(true) }) } }] })
  const config = { authorityUrl: 'http://owner', nodeId: 'n', projectId: 'p', workspaceRoot: join(temp, 'workspaces'), provider: 'mock', model: 'mock', ...(enabled ? { knowledge: { realm: 'r', spaces: ['s'] } } : {}) }
  const transport = createSessionTransport(ctx, config, 'test', async () => {}, fetcher)
  const authority = (principal: Principal) => async () => { if (revoked) throw new Error('revoked'); return { ...principal, roles: [...principal.roles] } }
  const create = async (principal: Principal) => (await transport.execute(principal, 'create', {}, signal, authority(principal)) as { sessionId: string }).sessionId
  const send = async (principal: Principal, sessionId: string, name = USER_SESSION_KNOWLEDGE_TOOL, args: object = { question: 'find knowledge' }, before?: () => void) => {
    nextCall = { name, args, before }
    await transport.execute(principal, 'prompt', { sessionId, requestId: `prompt-${requests.length}`, content: [{ type: 'text', text: 'read knowledge' }], mode: 'queue' }, signal, authority(principal))
    await ctx.agents.get(SessionId(sessionId))!.whenIdle()
  }
  return { ctx, config, transport, requests, queries, facts, create, send, revoke: () => { revoked = true }, onQuery: (cb: () => void | Promise<void>) => { onQuery = cb }, hostCalls: () => hostCalls,
    events: (id: string) => JSON.stringify(ctx.agents.get(SessionId(id))!.session.snapshotEvents()) }
}

describe('owned Session knowledge with real AgentLoop', () => {
  it('keeps default text Sessions tool-free and blocks the deployment tool', async () => {
    const f = await fixture(false); const id = await f.create(alice)
    await f.send(alice, id, 'knowledge_query', {})
    expect(f.requests.every(request => (request.tools ?? []).length === 0)).toBe(true)
    expect(f.queries).toEqual([]); expect(f.hostCalls()).toBe(0)
    expect(f.events(id)).not.toContain('DEPLOYMENT-SECRET')
  })
  it('binds Alice and Bob independently and exposes only the read capability', async () => {
    const f = await fixture(); const a = await f.create(alice); const b = await f.create(bob)
    await f.send(alice, a); await f.send(bob, b)
    expect(f.queries).toEqual([
      { principal: { realm: 'r', userId: 'alice', roles: ['viewer'] }, request: { projectId: 'p', text: 'find knowledge', topK: 5, spaces: ['s'] } },
      { principal: { realm: 'r', userId: 'bob', roles: ['editor'] }, request: { projectId: 'p', text: 'find knowledge', topK: 5, spaces: ['s'] } },
    ])
    expect(f.requests.every(request => request.tools?.map(tool => tool.name).join(',') === USER_SESSION_KNOWLEDGE_TOOL)).toBe(true)
    expect(f.events(a)).toContain('PRIVATE-alice'); expect(f.events(a)).not.toContain('PRIVATE-bob')
    expect(f.events(b)).toContain('PRIVATE-bob'); expect(f.events(b)).not.toContain('PRIVATE-alice')
    await expect(f.send(bob, a)).rejects.toThrow('ownership')
    expect(f.hostCalls()).toBe(0)
  })
  it('rejects model-supplied identity/scope and does not reuse a deployment user', async () => {
    const f = await fixture(); const id = await f.create(alice)
    await f.send(alice, id, USER_SESSION_KNOWLEDGE_TOOL, { question: 'q', realm: 'other', userId: 'admin', roles: ['admin'], projectId: 'other', spaces: ['other'] })
    expect(f.queries).toEqual([])
    await f.send(alice, id, 'knowledge_query', {})
    expect(f.hostCalls()).toBe(0)
  })
  it('rechecks login after the model request and before dispatch', async () => {
    const f = await fixture(); const id = await f.create(alice)
    await f.send(alice, id, USER_SESSION_KNOWLEDGE_TOOL, { question: 'q' }, f.revoke)
    expect(f.queries).toEqual([]); expect(f.events(id)).not.toContain('PRIVATE-alice')
  })
  it('discards an in-flight result after login or project authority revocation', async () => {
    const f = await fixture(); const id = await f.create(alice)
    f.onQuery(f.revoke)
    await f.send(alice, id)
    expect(f.queries).toHaveLength(1)
    expect(f.events(id)).not.toContain('PRIVATE-alice')
  })
  it('rechecks persistent owner state before a model-requested read', async () => {
    const f = await fixture(); const id = await f.create(alice)
    await f.send(alice, id, USER_SESSION_KNOWLEDGE_TOOL, { question: 'q' }, () => { f.facts.get(id)!.state = 'failed' })
    expect(f.queries).toEqual([]); expect(f.events(id)).not.toContain('PRIVATE-alice')
  })
  it('stops waiting for an in-flight read when its owning Agent is canceled', async () => {
    const f = await fixture(); const id = await f.create(alice)
    let reached!: () => void
    const started = new Promise<void>(resolve => { reached = resolve })
    f.onQuery(() => { reached(); return new Promise<void>(() => {}) })
    const running = f.send(alice, id)
    await started
    f.ctx.agents.get(SessionId(id))!.cancel({ kind: 'parent' })
    await running
    expect(f.events(id)).not.toContain('PRIVATE-alice')
  })
  it('rejects unavailable authenticated capability and invalid optional configuration', async () => {
    for (const value of [null, {}, { realm: 'other' }, { realm: 'r', actingUserId: 'admin' }, { realm: 'r', roles: ['admin'] }, { realm: 'r', defaultTopK: 0 }, { realm: 'r', spaces: ['s', 's'] }]) expect(() => validateSessionKnowledge(value, 'r')).toThrow()
    const f = await fixture()
    const ctx = { get: (key: string) => key === 'knowledgeAuthenticatedQuery' ? undefined : f.ctx.get(key) } as unknown as Context
    expect(() => createSessionTransport(ctx, f.config, 'test', async () => {})).toThrow('authenticated knowledge')
  })
})
