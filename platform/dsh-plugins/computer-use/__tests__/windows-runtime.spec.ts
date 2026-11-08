/** Process/IPC fixtures only. These tests never load a desktop SDK or send OS input. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsCuaRuntime, parseWindowsCatalog } from '../src/windows-runtime.ts'
import { ComputerUseCoordinator } from '../src/coordinator.ts'
const catalog = { tools: ['check_permissions', 'get_window_state', 'click', 'type_text'].map(name => ({ name, inputSchema: { type: 'object' } })) }
const runtimes: WindowsCuaRuntime[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); for (const child of children.splice(0)) child.kill() })
function fixture(options: { delay?: number; quiet?: boolean; crash?: boolean; cleanupTimeoutMs?: number } = {}) {
  const spawned: ChildProcessWithoutNullStreams[] = []
  const source = `
import {createInterface} from 'node:readline'
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n')
send({kind:'catalog',value:${JSON.stringify(catalog)}})
const input=createInterface({input:process.stdin})
input.on('line',line=>{
 if(line==='{"supervisor":"stop"}') {setTimeout(()=>{${options.quiet === false ? '' : "send({supervisor:'quiet'});"}process.exit(0)},${options.delay ?? 30});return}
 const request=JSON.parse(line)
 if(${options.crash ?? false}) {process.exit(2);return}
 if(request.args?.hang) return
 send({kind:'result',id:request.id,value:{content:[{type:'text',text:JSON.stringify({name:request.name,args:request.args,pid:process.pid})}]}})
})
`
  const runtime = new WindowsCuaRuntime({ cleanupTimeoutMs: options.cleanupTimeoutMs ?? 1000, spawnWorker: () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child); spawned.push(child); return child
  } })
  if (options.quiet !== false && !options.crash) runtimes.push(runtime)
  return { runtime, spawned }
}
describe('Windows isolated SDK transport (fixtures, no desktop)', () => {
  it('discovers and forwards exact args through a real subprocess while retaining its generation', async () => {
    const { runtime, spawned } = fixture()
    expect(await runtime.catalog()).toEqual(catalog)
    const signal = new AbortController().signal
    const first = await runtime.call('get_window_state', { target: { pid: 123, window_id: '7' } }, signal, 'session-a') as { content: { text: string }[] }
    const second = await runtime.call('click', { element_token: 'fresh-token', delivery: 'background' }, signal, 'session-a') as { content: { text: string }[] }
    expect(JSON.parse(first.content[0]!.text)).toMatchObject({ name: 'get_window_state', args: { target: { pid: 123, window_id: '7' } } })
    expect(JSON.parse(second.content[0]!.text).pid).toBe(JSON.parse(first.content[0]!.text).pid)
    expect(spawned).toHaveLength(1)
  })
  it('waits for quiet AND subprocess close on cancellation, then creates a fresh generation', async () => {
    const { runtime, spawned } = fixture({ delay: 100 })
    const controller = new AbortController(); await runtime.catalog()
    let settled = false
    const calling = runtime.call('click', { hang: true }, controller.signal, 'session-a').catch(error => { settled = true; throw error })
    const outcome = calling.catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 20)); controller.abort()
    await new Promise(resolve => setTimeout(resolve, 30)); expect(settled).toBe(false)
    expect((await outcome) instanceof Error).toBe(true)
    expect(spawned[0]!.exitCode).toBe(0)
    await runtime.call('get_window_state', {}, new AbortController().signal, 'session-a')
    expect(spawned).toHaveLength(2); expect(runtime.quarantined).toBe(false)
  })
  it('joins the prior driver before another authorized Session gets a fresh worker', async () => {
    const { runtime, spawned } = fixture()
    const signal = new AbortController().signal
    await runtime.call('get_window_state', {}, signal, 'session-a')
    await runtime.call('get_window_state', {}, signal, 'session-b')
    expect(spawned).toHaveLength(2); expect(spawned[0]!.exitCode).toBe(0)
    expect(spawned[1]!.exitCode).toBeNull()
  })
  it('quarantines unconfirmed cleanup and never resolves an active dispatch or admits another', async () => {
    const { runtime, spawned } = fixture({ quiet: false, cleanupTimeoutMs: 20 })
    await runtime.catalog(); const controller = new AbortController()
    let settled = false
    void runtime.call('click', { hang: true }, controller.signal).finally(() => { settled = true }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort()
    await vi.waitFor(() => expect(spawned[0]!.exitCode).toBe(0))
    expect(runtime.quarantined).toBe(true); expect(settled).toBe(false)
    await expect(runtime.call('click', {}, new AbortController().signal)).rejects.toThrow('CLEANUP')
  })
  it('does not consider a native crash a completed action', async () => {
    const { runtime, spawned } = fixture({ crash: true })
    await runtime.catalog(); let settled = false
    void runtime.call('click', {}, new AbortController().signal).finally(() => { settled = true }).catch(() => {})
    await vi.waitFor(() => expect(spawned[0]!.exitCode).toBe(2))
    expect(runtime.quarantined).toBe(true); expect(settled).toBe(false)
  })
  it('rejects absent capabilities, invalid names and duplicate tool definitions', () => {
    for (const value of [{ tools: [] }, { tools: [{ name: 'click', inputSchema: {} }] }, { tools: [...catalog.tools, catalog.tools[0]] }, { tools: [...catalog.tools, { name: 'shell.execute', inputSchema: {} }] }]) expect(() => parseWindowsCatalog(value)).toThrow()
  })
  it('requires an explicitly passive OS permission probe', async () => {
    const { runtime } = fixture()
    for (const args of [{}, { prompt: true }, null]) await expect(runtime.call('check_permissions', args, new AbortController().signal)).rejects.toThrow('PASSIVE_PERMISSIONS')
    await expect(runtime.call('check_permissions', { prompt: false }, new AbortController().signal)).resolves.toBeDefined()
  })
  it('only recognizes the isolated prefix when its registered provider attests availability', () => {
    const supported = vi.fn(() => true)
    const control = new ComputerUseCoordinator({}, { supportsIsolatedWindowsTool: supported })
    control.enable('session-a')
    const execution = { name: 'lumo_cua_windows__click', callId: 'call', agent: { session: { id: 'session-a' } }, arguments: {}, signal: new AbortController().signal }
    expect(control.guard(execution)).toBeUndefined(); supported.mockReturnValue(false)
    expect(control.guard({ ...execution })).toBe('COMPUTER_USE_PROVIDER_NOT_SUPPORTED')
    expect(new ComputerUseCoordinator().guard(execution)).toBe('COMPUTER_USE_DISABLED')
    expect(control.guard({ ...execution, name: 'cua_driver_native__click' })).toBe('COMPUTER_USE_PROVIDER_NOT_SUPPORTED')
  })
})
