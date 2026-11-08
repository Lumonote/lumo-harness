import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolDefinition, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as ComputerUse from '../src/index.ts'

const contexts: Context[] = []
const folders: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})
function agent(id: string): Agent { return { id, session: { id } } as unknown as Agent }
function input(owner: Agent, callId = 'c1', name = 'cua'): ToolExecutionInput {
  return { agent: owner, callId: ToolCallId(callId), name, arguments: { method: 'click', params: {} }, signal: new AbortController().signal }
}
async function fixture(body: ToolDefinition['execute'] = async () => ({ ok: true })) {
  const ctx = new Context()
  contexts.push(ctx)
  const folder = await mkdtemp(join(tmpdir(), 'lumo-computer-pipeline-'))
  folders.push(folder)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(ComputerUse, { lockFile: join(folder, 'desktop') })
  const backend = vi.fn(body)
  for (const name of ['cua', 'cua_driver_native__click', 'mcp__cua-driver-mcp__click']) {
    ctx.tools.register({ name, description: 'Fake desktop provider; no real input', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: backend })
  }
  return { ctx, backend }
}

it('enforces a final guard even after pre-execute allows, then runs through the real native pipeline', async () => {
  const { ctx, backend } = await fixture()
  ctx.on('tools/pre-execute', async (_exec, _next) => ({ kind: 'allow' }))
  const first = agent('a')
  const denied = await executeToolFixture(ctx, input(first))
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied)).toContain('COMPUTER_USE_DISABLED')
  expect(backend).not.toHaveBeenCalled()
  ctx.lumoComputerUse.enable('a')
  const accepted = await executeToolFixture(ctx, input(first, 'c2'))
  expect(accepted.isError).toBe(false)
  expect(backend).toHaveBeenCalledTimes(1)
  expect(ctx.lumoComputerUse.snapshot().ownerSessionId).toBe('a')
  const refused = await executeToolFixture(ctx, input(agent('b'), 'c3'))
  expect(JSON.stringify(refused)).toContain('COMPUTER_USE_SESSION_NOT_AUTHORIZED')
  const impersonator = await executeToolFixture(ctx, input(agent('a'), 'same-session'))
  expect(JSON.stringify(impersonator)).toContain('COMPUTER_USE_BUSY')
  await ctx.serial('agent/turn-stopping', { agent: first, turn: 1, signal: new AbortController().signal })
  expect(ctx.lumoComputerUse.snapshot().phase).toBe('running')
  ctx.emit('session/event', first.session as Session, { type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
  await vi.waitFor(() => expect(ctx.lumoComputerUse.snapshot().phase).toBe('ready'))
  ctx.lumoComputerUse.enable('b')
  expect((await executeToolFixture(ctx, input(agent('b'), 'c4'))).isError).toBe(false)
})

it('refuses unconfirmed driver transports before dispatch even for the authorized Session', async () => {
  const { ctx, backend } = await fixture()
  const first = agent('a')
  ctx.lumoComputerUse.enable('a')
  for (const name of ['cua_driver_native__click', 'mcp__cua-driver-mcp__click']) {
    const result = await executeToolFixture(ctx, input(first, name, name))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('COMPUTER_USE_PROVIDER_NOT_SUPPORTED')
  }
  expect(backend).not.toHaveBeenCalled()
  expect(ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null, inFlight: 0 })
})

it('guards nested program tool calls through their genuine parent execution token', async () => {
  const { ctx, backend } = await fixture()
  const first = agent('nested')
  ctx.tools.register({ name: 'program_transport', description: 'Test-only PTC-style nested dispatcher', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, execution) {
      const result = await executeToolFixture(ctx, { ...input(first, 'nested-call'), signal: execution.signal,
        parent: execution.token, rootCallId: execution.rootCallId })
      return { nestedError: result.isError }
    } })
  const result = await executeToolFixture(ctx, input(first, 'outer', 'program_transport'))
  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ nestedError: true })
  expect(backend).not.toHaveBeenCalled()
  ctx.lumoComputerUse.enable('nested')
  const accepted = await executeToolFixture(ctx, input(first, 'outer2', 'program_transport'))
  expect(accepted.value).toEqual({ nestedError: false })
  expect(backend).toHaveBeenCalledTimes(1)
})

it('fuses stop with caller cancellation and waits for the fake provider before disposal', async () => {
  let signal!: AbortSignal
  let release!: () => void
  const pending = new Promise<void>(done => { release = done })
  const { ctx, backend } = await fixture(async (_args, execution) => { signal = execution.signal; await pending; execution.signal.throwIfAborted(); return { ok: true } })
  ctx.lumoComputerUse.enable('a')
  const run = executeToolFixture(ctx, input(agent('a')))
  await vi.waitFor(() => expect(backend).toHaveBeenCalledTimes(1))
  expect(ctx.lumoComputerUse.stop().phase).toBe('stopping')
  expect(signal.aborted).toBe(true)
  let disposed = false
  const disposing = ctx.fiber.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release()
  expect((await run).isError).toBe(true)
  await disposing
  expect(disposed).toBe(true)
})
