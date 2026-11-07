import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId, SessionSeq } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
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
import { createSessionTransport } from '../src/session-transport.ts'
import { createAuthProxy, listenAuthProxy, closeAuthProxy } from '../src/proxy.ts'
import type { GovernanceAuthClient } from '../src/client.ts'
const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const modes = ['clean', 'next-turn', 'next-step', ...(process.env.LUMO_AUTH_PROXY_TEST === '1' ? ['http'] as const : [])] as const
it.each(modes)('real Gateway + access + AgentLoop preserves history and refuses unaccounted pending input: %s', async pending => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'owned-runtime-')))
  closers.push(() => rm(temp, { recursive: true, force: true }))
  const ref = `session-${'b'.repeat(32)}`
  const fact = { session_ref: ref, realm: 'r', owner_user_id: 'alice', project_id: 'p', node_id: 'n', parent_session_ref: '', state: 'reserved', created_at: '2026-11-06' }
  const requests: GenerateOptions[] = []
  let responseBarrier = Promise.resolve()
  async function runtime() {
    const ctx = new Context(); closers.push(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlPersistence, { root: join(temp, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new (class extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { requests.push(options); if (pending === 'http') await responseBarrier; yield { type: 'text-delta', index: 0, text: `Answer ${requests.length}` }; yield { type: 'finish', reason: { kind: 'stop' } } } })())
    await ctx.plugin(RemoteAccess)
    await ctx.plugin(Gateway)
    ctx.provide('connection', { createPeer: options => new Peer(ctx, options) } as never)
    const meters = new SessionMeterRegistry(); ctx.provide('meteringScope', meters)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }), saveSelection: async () => {} } as never)
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1000, maxImagesPerMessage: 1, maxMessageImageBytes: 1000, maxImagePixels: 1000, maxImageDimension: 1000, mediaTypes: [] }, admitPromptContent: async content => content } as never)
    ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => undefined, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }), retirePrompt() {} } as never)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], get: () => undefined } as never)
    new QueryEngine(ctx)
    class TestController extends Controller { initialize() { return this[Service.init]() } }
    await new TestController(ctx, { nativeOpen: false }).initialize()
    const schema = z.object({ sessionId: z.string(), requestId: z.string(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })), mode: z.literal('queue') })
    ctx.typert.register({ package: '@lumo/owned-runtime-test', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{ id: '@lumo/owned-runtime-test#session/prompt', service: 'sessionController', namespace: 'session', method: 'prompt', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: '@lumo/owned#Prompt', create: () => schema } }], cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@lumo/owned#Result', create: () => z.object({ accepted: z.literal(true) }) } }] })
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/activate')) fact.state = 'active'
      const body = url.endsWith('/session-owners') ? { owner: fact, creation_token: 'c'.repeat(64) } : { owner: fact }
      return new Response(JSON.stringify(body))
    }
    const transport = createSessionTransport(ctx, { authorityUrl: 'http://owner', nodeId: 'n', projectId: 'p', workspaceRoot: join(temp, 'workspaces'), provider: 'mock', model: 'mock' }, 'token', async () => {}, fetcher as typeof fetch)
    if (pending === 'http') {
      const proxy = createAuthProxy({ host: '127.0.0.1', port: 0, secureCookie: false, realm: 'r', projectId: 'p', identityAssertionSecret: 'a'.repeat(32), upstreamPort: 1,
        client: { session: async token => ({ ...alice, user_id: token }), authorizeSessionProject: async () => {} } as unknown as GovernanceAuthClient,
        sessionTransport: transport, logger: { info() {}, warn() {}, error() {} } })
      const port = await listenAuthProxy(proxy, '127.0.0.1', 0)
      closers.push(() => closeAuthProxy(proxy))
      const execute: typeof transport.execute = async (principal, action, request) => {
        const completed = Promise.withResolvers<void>()
        if (action === 'prompt') responseBarrier = completed.promise
        try {
          const response = await fetch(`http://127.0.0.1:${port}/lumo/sessions/${action}`, { method: 'POST', headers: { cookie: `lumo_auth_session=${principal.user_id}`, 'x-lumo-auth-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(request) })
          const body = await response.json() as { error?: string }
          if (!response.ok) throw Object.assign(new Error(body.error), { code: body.error })
          return body
        } finally { completed.resolve() }
      }
      return { ctx, transport: { ...transport, execute }, meters }
    }
    return { ctx, transport, meters }
  }
  const alice = { realm: 'r', user_id: 'alice', username: 'a', display_name: 'Alice', roles: ['operator'], session_expires_at: '2099-01-01' }
  const signal = new AbortController().signal
  const first = await runtime()
  await expect(first.transport.execute(alice, 'create', {}, signal, async () => {})).resolves.toEqual({ sessionId: ref })
  const request = { sessionId: ref, requestId: 'first', content: [{ type: 'text', text: 'first prompt' }], mode: 'queue' }
  await expect(first.transport.execute({ ...alice, user_id: 'bob' }, 'prompt', request, signal, async () => {})).rejects.toThrow()
  await expect(first.transport.execute(alice, 'prompt', request, signal, async () => {})).resolves.toEqual({ accepted: true })
  await first.ctx.agents.get(SessionId(ref))!.whenIdle()
  expect(requests).toHaveLength(1)
  expect(first.meters.resolve(ref)?.context.userId).toBe('alice')
  const events = first.ctx.agents.get(SessionId(ref))!.session.snapshotEvents()
  expect(JSON.stringify(events)).toContain('lumo-user')
  expect(JSON.stringify(events)).toContain('alice')
  await first.ctx.fiber.dispose()
  const second = await runtime()
  if (pending === 'next-turn' || pending === 'next-step') {
    const writer = await second.ctx.sessionPersistence.open(SessionId(ref), 'write')
    const log = await writer.read()
    await writer.append([{ type: 'agent/inbox/spliced', seq: SessionSeq(log.events.length), time: Date.now(),
      data: { target: pending, start: 0, removedCount: 0, inserted: [createUserMessage({ content: [{ type: 'text', text: 'uncertain queued input' }], source: { kind: 'user' } })] } }])
    await writer.close()
    await expect(second.transport.execute(alice, 'prompt', { ...request, requestId: 'second' }, signal, async () => {})).rejects.toMatchObject({ code: 'session_pending_input' })
    expect(requests).toHaveLength(1)
    expect(second.ctx.agents.get(SessionId(ref))).toBeUndefined()
    return
  }
  await second.transport.execute(alice, 'prompt', { ...request, requestId: 'second', content: [{ type: 'text', text: 'continue' }] }, signal, async () => {})
  await second.ctx.agents.get(SessionId(ref))!.whenIdle()
  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests[1])).toContain('first prompt')
  expect(JSON.stringify(requests[1])).toContain('Answer 1')
  expect(requests[1]!.tools ?? []).toEqual([])
})
