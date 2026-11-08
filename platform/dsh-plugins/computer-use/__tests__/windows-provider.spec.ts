/** Real Cordis/MCP pipeline with Node process fixtures. Never imports the native desktop SDK. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Registry from '@deepseek-ai/dsh-computer-use'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import * as Control from '../src/index.ts'
import { WindowsCuaRuntime } from '../src/windows-runtime.ts'
import { inject, mountWindowsProvider } from '../src/windows.ts'

const contexts: Context[] = []
const folders: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const child of children.splice(0)) child.kill()
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const folder = await mkdtemp(join(tmpdir(), 'lumo-windows-pipeline-')); folders.push(folder)
  const spawned: ChildProcessWithoutNullStreams[] = []
  const source = `
import {createInterface} from 'node:readline'
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n')
send({kind:'catalog',value:{tools:['check_permissions','get_window_state','click'].map(name=>({name,inputSchema:{type:'object'}}))}})
createInterface({input:process.stdin}).on('line',line=>{
 if(line==='{"supervisor":"stop"}') {setTimeout(()=>send({supervisor:'quiet'}),10);setTimeout(()=>process.exit(0),120);return}
 const request=JSON.parse(line);if(request.args?.hang)return
 send({kind:'result',id:request.id,value:{content:request.args?.image?[{type:'image',mimeType:'image/png',data:'AQ=='}]:[{type:'text',text:JSON.stringify({name:request.name,args:request.args,pid:process.pid})}]}})
})`
  const runtime = new WindowsCuaRuntime({ spawnWorker: () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child); spawned.push(child); return child
  } })
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(NativeExecutor)
  await ctx.plugin(Registry); await ctx.plugin(Control, { lockFile: join(folder, 'desktop') })
  const provider = await ctx.plugin({ name: 'windows-process-fixture', inject, apply: (ctx: Context) => mountWindowsProvider(ctx, runtime) })
  const owner = { id: 'agent-a', options: { provider: 'fixture', model: 'vision' }, session: { id: 'session-a', requestHeader: () => undefined } } as unknown as Agent
  let count = 0
  const run = (args: Record<string, unknown>, name = 'lumo_cua_windows__get_window_state') => executeToolFixture(ctx, {
    name, callId: ToolCallId(`fixture-${++count}`), arguments: args, signal: new AbortController().signal, agent: owner,
  })
  return { ctx, runtime, provider, spawned, run }
}

it('adapts canonical SDK values through the genuine guarded tool pipeline', async () => {
  const { ctx, run } = await fixture()
  expect(JSON.stringify(await run({}))).toContain('COMPUTER_USE_DISABLED')
  ctx.lumoComputerUse.enable('session-a')
  const accepted = await run({ target: { pid: 123, window_id: 7 } })
  expect(accepted.isError).toBe(false)
  expect(JSON.stringify(accepted.value)).toContain('get_window_state')
  expect(JSON.stringify(accepted.value)).toContain('window_id')
  expect(ctx.lumoComputerUse.snapshot()).toMatchObject({ phase: 'running', inFlight: 0, ownerSessionId: 'session-a' })
})

it('retains an idle desktop lease through quiet acknowledgement AND supervisor exit', async () => {
  const { ctx, spawned, run } = await fixture()
  ctx.lumoComputerUse.enable('session-a'); await run({})
  expect(ctx.lumoComputerUse.stop()).toMatchObject({ phase: 'stopping', inFlight: 0 })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(spawned[0]!.exitCode).toBeNull()
  expect(ctx.lumoComputerUse.snapshot().phase).toBe('stopping')
  expect(() => ctx.lumoComputerUse.enable('session-a')).toThrow('STOPPING')
  await vi.waitFor(() => expect(ctx.lumoComputerUse.snapshot().phase).toBe('disabled'))
  expect(spawned[0]!.exitCode).toBe(0)
  ctx.lumoComputerUse.enable('session-a'); expect((await run({})).isError).toBe(false)
  expect(spawned).toHaveLength(2)
})

it('keeps an in-flight dispatch and root disposal pending until job cleanup joins', async () => {
  const { ctx, spawned, run } = await fixture()
  ctx.lumoComputerUse.enable('session-a')
  const running = run({ hang: true })
  await vi.waitFor(() => expect(ctx.lumoComputerUse.snapshot().inFlight).toBe(1))
  expect(ctx.lumoComputerUse.stop().phase).toBe('stopping')
  let closed = false
  const disposing = ctx.fiber.dispose().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(closed).toBe(false); expect(spawned[0]!.exitCode).toBeNull()
  expect((await running).isError).toBe(true)
  await disposing; expect(closed).toBe(true); expect(spawned[0]!.exitCode).toBe(0)
})

it('retains provider ownership while the public MCP adapter is still storing an image', async () => {
  const { ctx, provider, run } = await fixture()
  let finish!: () => void
  const storing = new Promise<void>(resolve => { finish = resolve })
  const saveImages = vi.fn(async () => { await storing; return [{ attachmentId: `sha256:${'1'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 }] })
  ctx.provide('attachments', { saveImages } as unknown as typeof ctx.attachments)
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } as unknown as typeof ctx.llm)
  ctx.lumoComputerUse.enable('session-a')
  const running = run({ image: true })
  try {
    await vi.waitFor(() => expect(saveImages).toHaveBeenCalledTimes(1))
    const service = ctx.lumoWindowsComputerUse
    let closed = false
    const disposing = provider.dispose().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(closed).toBe(false)
    expect(ctx.computerUse.providerName).toBe('lumo-cua-windows')
    expect(service.available).toBe(false)
    finish(); await running; await disposing
    expect(ctx.computerUse.providerName).toBeUndefined()
  } finally { finish() }
})
