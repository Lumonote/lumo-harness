import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ComputerUseCoordinator, isComputerUseTool, type ComputerUseExecution, type DesktopWorkflowLock } from '../src/coordinator.ts'

const coordinators: ComputerUseCoordinator[] = []
const folders: string[] = []
const immediate: DesktopWorkflowLock = async (_file, work, signal) => { signal.throwIfAborted(); await work() }
const owner = (id = 'session-a') => ({ session: { id } })
function execution(agent = owner(), callId = 'call-1', extra: Partial<ComputerUseExecution> = {}): ComputerUseExecution {
  return { name: 'cua', callId, agent, arguments: { method: 'getState', params: {} }, signal: new AbortController().signal, ...extra }
}
function coordinator(config: { idleLeaseMs?: number; lockFile?: string } = {}, lock = immediate) {
  const item = new ComputerUseCoordinator({ lockFile: '/tmp/lumo-computer-use-unit', ...config }, { lock })
  coordinators.push(item)
  return item
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve() }
const success = async () => ({ isError: false })

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(coordinators.splice(0).map(item => item.dispose()))
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

describe('desktop workflow coordination', () => {
  it('starts disabled, only recognizes the explicit desktop providers, and never changes browser tools', () => {
    const item = coordinator()
    expect(item.snapshot()).toMatchObject({ enabled: false, authorizedSessionId: null, phase: 'disabled', ownerSessionId: null, inFlight: 0 })
    for (const name of ['cua', 'cua_driver_native__click', 'mcp__cua-driver-mcp__capture']) expect(isComputerUseTool(name)).toBe(true)
    for (const name of ['bash', 'run_code', 'cua_driver_native__', 'mcp__playwright-mcp__browser_click']) {
      expect(isComputerUseTool(name)).toBe(false)
      expect(item.guard(execution(undefined, 'c', { name }))).toBeUndefined()
    }
    expect(item.guard(execution())).toBe('COMPUTER_USE_DISABLED')
    item.enable('session-a')
    expect(item.guard(execution(undefined, 'c', { agent: undefined }))).toBe('COMPUTER_USE_AGENT_REQUIRED')
  })

  it('retains ownership between observations and actions, even against another Agent with the same Session id', async () => {
    const item = coordinator()
    const first = owner()
    item.enable('session-a')
    await item.execute(execution(first), success)
    expect(item.snapshot()).toMatchObject({ phase: 'running', ownerSessionId: 'session-a', inFlight: 0 })
    expect(item.guard(execution(owner(), 'other-agent'))).toBe('COMPUTER_USE_BUSY')
    expect(item.guard(execution(owner('session-b'), 'other-session'))).toBe('COMPUTER_USE_SESSION_NOT_AUTHORIZED')
    await item.execute(execution(first, 'call-2'), success)
    await item.releaseOwner(first)
    expect(item.snapshot()).toMatchObject({ enabled: true, authorizedSessionId: 'session-a', phase: 'ready', ownerSessionId: null })
    item.enable('session-b')
    await item.execute(execution(owner('session-b'), 'call-3'), success)
    expect(item.snapshot().ownerSessionId).toBe('session-b')
  })

  it('rejects concurrent actions by the same Agent rather than interleaving their snapshots', async () => {
    const item = coordinator()
    const agent = owner()
    const release = deferred()
    item.enable('session-a')
    const first = item.execute(execution(agent), async () => { await release.promise; return { isError: false } })
    await settle()
    await expect(item.execute(execution(agent, 'second'), success)).rejects.toThrow('COMPUTER_USE_ACTION_IN_FLIGHT')
    release.resolve()
    await first
  })

  it('stops immediately but retains the desktop until cancelled native work actually settles', async () => {
    const item = coordinator()
    const cleanup = deferred()
    let signal: AbortSignal | undefined
    item.enable('session-a')
    const pending = item.execute(execution(), async active => { signal = active; await cleanup.promise; active.throwIfAborted(); return { isError: false } })
    const outcome = pending.catch(error => error)
    await settle()
    expect(item.stop()).toMatchObject({ enabled: false, authorizedSessionId: null, phase: 'stopping', inFlight: 1 })
    expect(signal?.aborted).toBe(true)
    expect(() => item.enable('session-a')).toThrow('COMPUTER_USE_STOPPING')
    expect(item.guard(execution(owner('b')))).toBe('COMPUTER_USE_DISABLED')
    cleanup.resolve()
    await outcome
    await settle()
    expect(item.snapshot()).toMatchObject({ enabled: false, phase: 'disabled', ownerSessionId: null, inFlight: 0 })
    expect(item.snapshot().events.filter(event => event.state === 'cancelled')).toHaveLength(1)
    item.enable('b')
    await item.execute(execution(owner('b')), success)
    expect(item.snapshot().ownerSessionId).toBe('b')
  })

  it('expires idle workflows, waits for cleanup, and never replays the cancelled action', async () => {
    vi.useFakeTimers()
    const item = coordinator({ idleLeaseMs: 100 })
    const agent = owner()
    const cleanup = deferred()
    const dispatch = vi.fn(async (signal: AbortSignal) => { await cleanup.promise; signal.throwIfAborted(); return { isError: false } })
    item.observeTurn(agent.session, 'turn/start', 1)
    item.enable('session-a')
    const pending = item.execute(execution(agent), dispatch).catch(error => error)
    await settle()
    await vi.advanceTimersByTimeAsync(101)
    expect(item.snapshot()).toMatchObject({ enabled: true, phase: 'stopping', inFlight: 1 })
    expect(item.guard(execution(owner('session-a')))).toBe('COMPUTER_USE_STOPPING')
    cleanup.resolve()
    await pending
    await settle()
    expect(item.snapshot().phase).toBe('ready')
    expect(item.guard(execution(agent))).toBe('COMPUTER_USE_LEASE_EXPIRED')
    item.observeTurn(agent.session, 'turn/end', 1)
    item.observeTurn(agent.session, 'turn/start', 2)
    expect(item.guard(execution(agent, 'next-turn'))).toBeUndefined()
    item.enable('b')
    await item.execute(execution(owner('b')), success)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('joins owner teardown and only releases after backend work has settled', async () => {
    const item = coordinator()
    const agent = owner()
    const cleanup = deferred()
    item.enable('session-a')
    const pending = item.execute(execution(agent), async signal => { await cleanup.promise; signal.throwIfAborted(); return { isError: false } }).catch(error => error)
    await settle()
    let released = false
    const release = item.releaseOwner(agent).then(() => { released = true })
    await settle()
    expect(released).toBe(false)
    expect(item.snapshot().phase).toBe('stopping')
    cleanup.resolve()
    await Promise.all([pending, release])
    expect(item.snapshot().phase).toBe('ready')
  })

  it('releases promptly when the original caller is cancelled between desktop calls', async () => {
    const item = coordinator()
    const agent = owner()
    const controller = new AbortController()
    item.enable('session-a')
    await item.execute(execution(agent, 'first', { signal: controller.signal }), success)
    expect(item.snapshot()).toMatchObject({ phase: 'running', inFlight: 0 })
    controller.abort()
    expect(item.snapshot().phase).toBe('stopping')
    await settle()
    expect(item.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null, authorizedSessionId: 'session-a' })
  })

  it('uses the exact Session and turn boundary and waits for the prior lock cleanup before the next turn', async () => {
    const cleanup = deferred()
    let locks = 0
    const lock: DesktopWorkflowLock = async (_file, work) => { const first = ++locks === 1; await work(); if (first) await cleanup.promise }
    const item = coordinator({}, lock)
    const agent = owner()
    item.observeTurn(agent.session, 'turn/start', 2)
    item.enable('session-a')
    await item.execute(execution(agent), success)
    item.observeTurn(owner().session, 'turn/end', 2)
    item.observeTurn(agent.session, 'turn/end', 1)
    expect(item.snapshot().phase).toBe('running')
    item.observeTurn(agent.session, 'turn/end', 2)
    item.observeTurn(agent.session, 'turn/start', 3)
    const dispatch = vi.fn(success)
    expect(item.guard(execution(agent, 'next-turn'))).toBeUndefined()
    const next = item.execute(execution(agent, 'next-turn'), dispatch)
    try {
      await settle()
      expect(dispatch).not.toHaveBeenCalled()
      expect(locks).toBe(1)
    } finally { cleanup.resolve() }
    await next
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(locks).toBe(2)
    expect(item.snapshot()).toMatchObject({ phase: 'running', inFlight: 0 })
  })

  it('keeps a bounded metadata-only audit even when arguments and backend errors contain secrets', async () => {
    const item = coordinator()
    const agent = owner()
    item.enable('session-a')
    await expect(item.execute(execution(agent, 'failed', { arguments: { method: 'typeText', params: { text: 'secret-typed-content' } } }), async () => { throw Error('secret-error-message') })).rejects.toThrow('secret-error-message')
    for (let index = 0; index < 60; index++) await item.execute(execution(agent, `call-${index}`), success)
    const snapshot = item.snapshot()
    expect(snapshot.events).toHaveLength(100)
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-typed-content|secret-error-message|params|arguments/u)
    snapshot.events.length = 0
    expect(item.snapshot().events).toHaveLength(100)
  })

  it('does not transfer the lock when caller cancellation precedes lock acquisition', async () => {
    const waiting = deferred()
    const lock: DesktopWorkflowLock = async (_file, _work, signal) => { await new Promise<void>((_done, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); await waiting.promise }
    const item = coordinator({}, lock)
    const controller = new AbortController()
    const dispatch = vi.fn(success)
    item.enable('session-a')
    const pending = item.execute(execution(owner(), 'c', { signal: controller.signal }), dispatch).catch(error => error)
    controller.abort()
    await pending
    await settle()
    expect(dispatch).not.toHaveBeenCalled()
    expect(item.snapshot()).toMatchObject({ phase: 'ready', ownerSessionId: null })
  })

  it('coordinates with a separate process and never steals its live lock', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'lumo-computer-lock-'))
    folders.push(folder)
    const lockFile = join(folder, 'desktop')
    const module = new URL('../../../../deepseek-harness/packages/util/atomic-write/lib/index.js', import.meta.url).href
    const source = `import { withFileLock } from ${JSON.stringify(module)}; await withFileLock(process.argv[1], async () => { process.stdout.write('locked\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause(); });`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, lockFile], { stdio: ['pipe', 'pipe', 'pipe'] })
    let error = ''
    child.stderr.on('data', value => { error += value })
    try {
      const [chunk] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error(error || 'lock process exited') })])
      expect(String(chunk)).toContain('locked')
      const item = new ComputerUseCoordinator({ lockFile })
      coordinators.push(item)
      item.enable('session-a')
      const dispatch = vi.fn(success)
      await expect(item.execute(execution(), dispatch)).rejects.toThrow('COMPUTER_USE_LOCK_UNAVAILABLE')
      expect(dispatch).not.toHaveBeenCalled()
      expect(await readFile(lockFile + '.lock', 'utf8')).toBe(`${child.pid}\n`)
      const exited = once(child, 'exit')
      child.stdin.write('release')
      await exited
      await settle()
      item.enable('next')
      await item.execute(execution(owner('next')), success)
      expect(item.snapshot().ownerSessionId).toBe('next')
    } finally {
      child.stdin.end()
      if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    }
  })
})
