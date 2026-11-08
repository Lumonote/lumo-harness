import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as ComputerUse from '../src/index.ts'

const contexts: Context[] = []
const folders: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type Reply = StreamChunk[] | ((options: GenerateOptions) => Promise<StreamChunk[]>)
const textResponse = (text: string): StreamChunk[] => [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }]
function toolCallResponse(id: string, name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

/** A scripted model and a fake Provider exercise production lifecycle boundaries without desktop input. */
async function fixture(script: Reply[], body: ToolDefinition['execute'] = async () => ({ ok: true })) {
  const ctx = new Context()
  contexts.push(ctx)
  const folder = await mkdtemp(join(tmpdir(), 'lumo-computer-lifecycle-'))
  folders.push(folder)
  const lockFile = join(folder, 'desktop')
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ComputerUse, { lockFile })
  const requests: GenerateOptions[] = []
  ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
    override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      const reply = script.shift()
      if (reply === undefined) throw Error('lifecycle model script exhausted')
      const chunks = typeof reply === 'function' ? await reply(options) : reply
      for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
    }
  }())
  const backend = vi.fn(body)
  ctx.tools.register({ name: 'cua', description: 'Fake desktop provider; no real input', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: backend })
  const agent = await ctx.agentLoop.create(SessionId('lifecycle-owner'), { provider: 'mock', model: 'mock' })
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
  ctx.lumoComputerUse.enable(String(agent.session.id))
  const start = () => agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise the fake desktop provider' }], source: { kind: 'user' } }))
  return { ctx, agent, backend, requests, events, lockFile, start }
}

it('closes an aborted real turn immediately but holds the desktop lock until its Provider drains', async () => {
  const entered = deferred()
  const drain = deferred()
  let signal!: AbortSignal
  const f = await fixture([toolCallResponse('observe', 'cua', { method: 'getState', params: {} })], async (_args, execution) => {
    signal = execution.signal
    entered.resolve()
    await drain.promise
    signal.throwIfAborted()
    return { ok: true }
  })
  try {
    f.start()
    await entered.promise
    f.agent.cancel({ kind: 'user' })
    expect(signal.aborted).toBe(true)
    expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'stopping', ownerSessionId: 'lifecycle-owner', inFlight: 1 })
    expect(await readFile(f.lockFile + '.lock', 'utf8')).toBe(`${process.pid}\n`)
    expect(() => f.ctx.lumoComputerUse.enable('another-session')).toThrow('COMPUTER_USE_STOPPING')
  } finally { drain.resolve() }
  await f.agent.whenIdle()
  await vi.waitFor(() => expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null, inFlight: 0 }))
  expect(f.events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted' } } })
  expect(f.backend).toHaveBeenCalledTimes(1)
})

it('releases the lease at real turn/end when the model fails after a desktop action', async () => {
  const f = await fixture([
    toolCallResponse('observe', 'cua', { method: 'getState', params: {} }),
    async () => { throw Error('scripted model failure') },
  ])
  const stopping = vi.fn()
  f.ctx.on('agent/turn-stopping', stopping)
  f.start()
  await f.agent.whenIdle()
  expect(stopping).not.toHaveBeenCalled()
  expect(f.backend).toHaveBeenCalledTimes(1)
  expect(f.events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error' } } })
  await vi.waitFor(() => expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null }))
})

it('releases the lease at real turn/end when a turn-stopping extension throws', async () => {
  const f = await fixture([
    toolCallResponse('observe', 'cua', { method: 'getState', params: {} }),
    textResponse('Completed the fake observation'),
  ])
  f.ctx.on('agent/turn-stopping', () => { throw Error('scripted stopping failure') })
  f.start()
  await f.agent.whenIdle()
  expect(f.backend).toHaveBeenCalledTimes(1)
  expect(f.events.findLast(event => event.type === 'turn/end')).toMatchObject({
    data: { reason: { kind: 'error', error: { message: 'scripted stopping failure' } } },
  })
  await vi.waitFor(() => expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null }))
})

it('retains the desktop when turn-stopping is steered into another step of the same real turn', async () => {
  const continued = deferred()
  const finish = deferred()
  const f = await fixture([
    toolCallResponse('observe', 'cua', { method: 'getState', params: {} }),
    textResponse('Would normally end the turn'),
    async () => { continued.resolve(); await finish.promise; return textResponse('Finished the continued turn') },
  ])
  let steered = false
  f.ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent !== f.agent || steered) return
    steered = true
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'Continue in this same turn' }], source: { kind: 'user' } }))
  })
  try {
    f.start()
    await continued.promise
    expect(f.requests).toHaveLength(3)
    expect(f.events.filter(event => event.type === 'turn/end')).toHaveLength(0)
    expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'running', ownerSessionId: 'lifecycle-owner', inFlight: 0 })
    expect(await readFile(f.lockFile + '.lock', 'utf8')).toBe(`${process.pid}\n`)
    expect(() => f.ctx.lumoComputerUse.enable('another-session')).toThrow('COMPUTER_USE_BUSY')
  } finally { finish.resolve() }
  await f.agent.whenIdle()
  expect(f.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(f.events.filter(event => event.type === 'turn/end')).toHaveLength(1)
  await vi.waitFor(() => expect(f.ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null }))
})
