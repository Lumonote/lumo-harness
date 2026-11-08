/** Real AgentLoop/tool lifecycle with a scripted model. No OS input or native SDK. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import * as Control from '../src/index.ts'
import { RemoteComputerBroker, remoteComputerToolAllowed, type RemoteComputerEnvelope, type RemoteComputerLeaseInput, type RemoteComputerPlan } from '../src/remote-broker.ts'

const contexts: Context[] = [], roots: string[] = [], brokers: RemoteComputerBroker[] = []
afterEach(async () => { await Promise.all(brokers.splice(0).map(b => b.dispose())); await Promise.all(contexts.splice(0).map(c => c.fiber.dispose())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const id = 'A'.repeat(43)
function envelope(patch: Partial<RemoteComputerPlan> = {}): RemoteComputerEnvelope {
 const plan: RemoteComputerPlan = { realm: 'realm', node_id: 'device', owner_user_id: 'owner', project_id: 'project', session_ref: 'session-a', capability: 'computer.observe', expires_at: new Date(Date.now() + 30_000).toISOString(), intent: 'Read the dedicated fixture window', channel: 'channel', subject: 'subject', sender_user_id: 'sender', team_id: 'team', agent_id: 'agent', ...patch }
 const plan_json = JSON.stringify(plan)
 return { version: 1, request_id: id, plan_json, digest: `sha256:${createHash('sha256').update(plan_json).digest('hex')}` }
}
function call(name: string, args: unknown): StreamChunk[] { return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(Math.random().toString()), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }] }
const text: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'Verified fixture state' }, { type: 'finish', reason: { kind: 'stop' } }]
async function fixture(script: StreamChunk[][], execute: ToolDefinition['execute'] = async () => ({ observed: true })) {
 const ctx = new Context(); contexts.push(ctx)
 const root = await mkdtemp(join(tmpdir(), 'lumo-remote-computer-')); roots.push(root)
 await mountAgentLoopTestDependencies(ctx); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Control, { lockFile: join(root, 'desktop') })
 ctx.provide('computerUse', { providerName: 'dsh-cua' } as never)
 ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { const response = script.shift() ?? text; for (const chunk of response) { options.signal?.throwIfAborted(); yield chunk } }
 }())
 const backend = vi.fn(execute)
 for (const name of ['cua', 'shell', 'cua_driver_native__click', 'lumo_cua_windows__elevate']) ctx.tools.register({ name, description: 'Process-only test fixture', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: backend })
 const agent = await ctx.agentLoop.create(SessionId('session-a'), { provider: 'fixture', model: 'fixture' })
 let revision = 1; let current: ReturnType<typeof envelope>
 const authorize = vi.fn(async (requestId: string, input: RemoteComputerLeaseInput) => {
  expect(requestId).toBe(id); expect(input.expected_revision).toBe(revision); expect(input.digest).toBe(current.digest)
  revision++
  return { request_id: id, digest: input.digest, revision, expires_at: (JSON.parse(current.plan_json) as RemoteComputerPlan).expires_at, state: input.phase === 'deny' ? 'denied' as const : input.phase === 'finish' ? input.state! : input.phase === 'cancel' ? 'cancelled' as const : 'running' as const }
 })
 const options = { ctx, enabled: true, realm: 'realm', nodeId: 'device', ownerUserId: 'owner', ledgerDir: join(root, 'ledger'), authorize }
 const broker = await RemoteComputerBroker.create(options); brokers.push(broker)
 current = envelope(); await broker.ingest(current)
 return { ctx, root, options, broker, agent, backend, authorize, request: current }
}
it('requires exact local owner, immutable request digest and explicit human approval before any Agent turn', async () => {
 const f = await fixture([call('cua', { method: 'getState', params: {} }), text])
 expect(f.backend).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled()
 await expect(f.broker.ingest(envelope({ owner_user_id: 'someone-else' }))).rejects.toThrow('TARGET_MISMATCH')
 await expect(f.broker.ingest({ ...f.request, plan_json: f.request.plan_json + ' ' })).rejects.toThrow('INVALID_REQUEST')
 await f.broker.decide(id, { digest: f.request.digest, approve: true })
 await vi.waitFor(() => expect(f.broker.list()[0]!.state).toBe('completed'))
 expect(f.authorize.mock.calls.map(c => c[1].phase)).toEqual(['approve', 'check', 'finish'])
 expect(f.backend).toHaveBeenCalledTimes(1)
 expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'disabled', ownerSessionId: null })
 const receipt = JSON.parse(await readFile(join(f.options.ledgerDir, `${id}.json`), 'utf8'))
 expect(receipt.state).toBe('completed'); expect(receipt.summary).toContain('1 approved')
})
it.each([['cua', { method: 'click', params: {} }], ['shell', { command: 'never-run' }], ['cua_driver_native__click', {}], ['lumo_cua_windows__elevate', {}]])('denies unapproved operations in the real AgentLoop (%s)', async (name, args) => {
 const f = await fixture([call(name as string, args), text])
 await f.broker.decide(id, { digest: f.request.digest, approve: true })
 await vi.waitFor(() => expect(f.broker.list()[0]!.state).toBe('failed'))
 expect(f.backend).not.toHaveBeenCalled()
})
it('never replays an approval whose reply was lost, including after Host restart', async () => {
 const f = await fixture([call('cua', { method: 'getState', params: {} }), text])
 f.authorize.mockRejectedValueOnce(Error('lost response'))
 await expect(f.broker.decide(id, { digest: f.request.digest, approve: true })).rejects.toThrow('lost response')
 expect(f.broker.list()[0]!.state).toBe('unknown'); expect(f.backend).not.toHaveBeenCalled()
 await f.broker.dispose(); const restored = await RemoteComputerBroker.create(f.options); brokers.push(restored)
 expect(restored.list()[0]!.state).toBe('unknown')
 await expect(restored.decide(id, { digest: f.request.digest, approve: true })).rejects.toThrow('CONFLICT')
 expect(f.authorize).toHaveBeenCalledTimes(1)
})
it('reserves the broker across the authority await so two requests cannot approve concurrently', async () => {
 const f = await fixture([call('cua', { method: 'getState', params: {} }), text])
 const second = { ...f.request, request_id: 'B'.repeat(43) }; await f.broker.ingest(second)
 let release!: () => void; const waiting = new Promise<void>(done => { release = done })
 const authorize = f.authorize.getMockImplementation()!
 f.authorize.mockImplementationOnce(async (...args) => { await waiting; return authorize(...args) })
 const first = f.broker.decide(id, { digest: f.request.digest, approve: true })
 try {
  await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce())
  await expect(f.broker.decide(second.request_id, { digest: second.digest, approve: true })).rejects.toThrow('BUSY')
  expect(f.broker.list().find(row => row.envelope.request_id === second.request_id)!.state).toBe('pending')
  expect(f.backend).not.toHaveBeenCalled()
 } finally { release() }
 await first; await vi.waitFor(() => expect(f.broker.list()[0]!.state).toBe('completed'))
 expect(f.backend).toHaveBeenCalledOnce()
})
it.each(['revoke', 'dispose', 'local-enable', 'local-stop'] as const)('joins and cancels a pending authority approval after %s without starting an Agent turn', async action => {
 const f = await fixture([call('cua', { method: 'getState', params: {} }), text])
 let release!: () => void; const waiting = new Promise<void>(done => { release = done })
 const authorize = f.authorize.getMockImplementation()!
 f.authorize.mockImplementationOnce(async (...args) => { await waiting; return authorize(...args) })
 const approval = f.broker.decide(id, { digest: f.request.digest, approve: true }).catch(error => error)
 await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce())
 let joined = false
 const closing = action === 'revoke' ? f.broker.revoke(id, f.request.digest) : action === 'dispose' ? f.broker.dispose() : action === 'local-enable' ? Promise.resolve(f.ctx.lumoComputerUse.enable('local-session')) : Promise.resolve(f.ctx.lumoComputerUse.stop())
 void closing.then(() => { joined = true })
 try {
  if (action === 'revoke' || action === 'dispose') { await new Promise(resolve => setTimeout(resolve, 10)); expect(joined).toBe(false) }
  expect(f.backend).not.toHaveBeenCalled()
 } finally { release() }
 expect(await approval).toBeInstanceOf(Error)
 await closing
 expect(f.broker.list()[0]!.state).toBe('cancelled')
 expect(f.authorize.mock.calls.map(call => call[1].phase)).toEqual(['approve', 'cancel'])
 expect(f.backend).not.toHaveBeenCalled()
 expect(f.agent.inbox.nextTurn).toHaveLength(0)
 if (action === 'local-enable') expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'ready', authorizedSessionId: 'local-session' })
})
it('keeps cancellation and the terminal receipt pending while the native provider has not drained', async () => {
 let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve })
 const f = await fixture([call('cua', { method: 'getState', params: {} }), text], async (_args, execution) => { await blocked; execution.signal.throwIfAborted(); return {} })
 await f.broker.decide(id, { digest: f.request.digest, approve: true })
 await vi.waitFor(() => expect(f.backend).toHaveBeenCalledTimes(1))
 let stopped = false; const stopping = f.broker.revoke(id, f.request.digest).then(() => { stopped = true })
 try {
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(stopped).toBe(false); expect(f.ctx.lumoComputerUse.snapshot().phase).toBe('stopping')
  expect(f.authorize.mock.calls.some(c => c[1].phase === 'finish')).toBe(false)
 } finally { release() }
 await stopping; expect(f.broker.list()[0]!.state).toBe('cancelled')
})
it('refuses an idle Agent with an already queued prompt', async () => {
 const f = await fixture([text])
 f.agent.inbox.append('next-turn', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An earlier local task' }] }))
 expect(f.agent.status).toBe('idle')
 await expect(f.broker.decide(id, { digest: f.request.digest, approve: true })).rejects.toThrow('SESSION_NOT_READY')
 expect(f.authorize).not.toHaveBeenCalled()
})
it('cancels on a foreign steering message before it can enter the approved turn', async () => {
 let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve })
 const f = await fixture([call('cua', { method: 'getState', params: {} }), call('cua', { method: 'getState', params: {} }), text], async (_args, execution) => { await blocked; execution.signal.throwIfAborted(); return {} })
 await f.broker.decide(id, { digest: f.request.digest, approve: true })
 await vi.waitFor(() => expect(f.backend).toHaveBeenCalledTimes(1))
 try {
  f.agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Different task that was never approved' }] }))
  expect(f.ctx.lumoComputerUse.snapshot().phase).toBe('stopping')
 } finally { release() }
 await vi.waitFor(() => expect(f.broker.list()[0]!.state).toBe('cancelled'))
 expect(f.backend).toHaveBeenCalledTimes(1)
 expect(f.agent.inbox.nextTurn).toHaveLength(0); expect(f.agent.inbox.nextStep).toHaveLength(0)
})
it('uses explicit method capability lists and passive Windows permission checks', () => {
 expect(remoteComputerToolAllowed('computer.observe', 'lumo_cua_windows__check_permissions', { prompt: true })).toBe(false)
 expect(remoteComputerToolAllowed('computer.observe', 'lumo_cua_windows__get_window_state', {})).toBe(true)
 expect(remoteComputerToolAllowed('computer.interact', 'lumo_cua_windows__click', {})).toBe(true)
 expect(remoteComputerToolAllowed('computer.interact', 'cua', { method: 'activate', params: {} })).toBe(false)
})
