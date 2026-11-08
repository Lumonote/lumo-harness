import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

export interface ComputerUseConfig { idleLeaseMs?: number; lockFile?: string }
export type ComputerUseState = 'started' | 'succeeded' | 'failed' | 'cancelled' | 'denied'
export interface ComputerUseEvent {
  id: number
  at: number
  sessionId: string
  callId: string
  tool: string
  method: string | null
  state: ComputerUseState
  code?: string
}
export interface ComputerUseSnapshot {
  enabled: boolean
  authorizedSessionId: string | null
  phase: 'disabled' | 'ready' | 'running' | 'stopping'
  ownerSessionId: string | null
  startedAt: number | null
  lastActivityAt: number | null
  inFlight: number
  events: ComputerUseEvent[]
}
export interface ComputerUseAgent { session: { id: unknown } }
export interface ComputerUseExecution {
  name: string
  callId: unknown
  agent?: ComputerUseAgent
  arguments: unknown
  signal: AbortSignal
}
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
export type DesktopWorkflowLock = (filename: string, operation: () => Promise<void>, signal: AbortSignal) => Promise<void>
interface CoordinatorDependencies {
  now?: () => number
  lock?: DesktopWorkflowLock
  supportsIsolatedWindowsTool?(name: string): boolean
}
interface Lease {
  agent: ComputerUseAgent
  sessionId: string
  turn: number | undefined
  controller: AbortController
  ready: Deferred<void>
  release: Deferred<void>
  settled: Promise<void>
  inFlight: number
  startedAt: number
  lastActivityAt: number
  closing: boolean
  turnEnded: boolean
  tool: string
  draining: boolean
  callers: Map<AbortSignal, () => void>
  timer?: ReturnType<typeof setTimeout>
}

const METHODS = new Set(['getCapabilities', 'listApps', 'findApps', 'getApp', 'activate', 'show', 'listWindows',
  'getState', 'hover', 'click', 'setValue', 'selectText', 'performSecondaryAction', 'typeText', 'paste', 'pressKey',
  'scroll', 'drag', 'screenshot'])

/** Browser providers have independent ownership rules and are not implicitly desktop drivers. */
export function isComputerUseTool(name: string): boolean {
  return name === 'cua' || /^lumo_cua_windows__[A-Za-z0-9_-]+$/u.test(name) || /^cua_driver_native__[A-Za-z0-9_-]+$/u.test(name) || /^mcp__cua-driver-mcp__[A-Za-z0-9_-]+$/u.test(name)
}

/** Same-user, same-host processes share this path across profiles and application versions. */
export function defaultDesktopLockFile(): string { return join(homedir(), '.lumo', 'computer-use', 'desktop') }

/** No age-based lock takeover: upstream only reclaims a lock after its recorded PID has exited. */
export const holdDesktopWorkflowLock: DesktopWorkflowLock = async (filename, operation, signal) => {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
  await withFileLock(filename, operation, { signal, waitMs: 250 })
}

function sessionId(execution: ComputerUseExecution): string | undefined {
  const value = execution.agent?.session?.id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
function method(execution: ComputerUseExecution): string | null {
  if (execution.name !== 'cua' || execution.arguments === null || typeof execution.arguments !== 'object') return null
  const value = (execution.arguments as { method?: unknown }).method
  return typeof value === 'string' && METHODS.has(value) ? value : null
}
class ComputerUseDenied extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ComputerUseDenied' }
}

/** Whole observe/act/verify turns retain one desktop lease, including between tool calls. */
export class ComputerUseCoordinator {
  private enabled = false
  private authorizedSessionId: string | null = null
  private disposed = false
  private owner: Lease | undefined
  private readonly events: ComputerUseEvent[] = []
  private sequence = 0
  private readonly denied = new WeakSet<object>()
  private readonly expired = new WeakSet<ComputerUseAgent>()
  private readonly turns = new WeakMap<object, number>()
  private readonly turnAgents = new WeakMap<object, { agent: ComputerUseAgent; turn: number | undefined }>()
  private readonly now: () => number
  private readonly lock: DesktopWorkflowLock
  private readonly supportsIsolatedWindowsTool: (name: string) => boolean
  private windowsCleanup?: () => Promise<void>
  readonly idleLeaseMs: number
  readonly lockFile: string

  constructor(config: ComputerUseConfig = {}, dependencies: CoordinatorDependencies = {}) {
    this.idleLeaseMs = config.idleLeaseMs ?? 120_000
    this.lockFile = config.lockFile ?? defaultDesktopLockFile()
    if (!Number.isSafeInteger(this.idleLeaseMs) || this.idleLeaseMs < 100 || this.idleLeaseMs > 3_600_000) throw Error('INVALID_IDLE_LEASE')
    if (!isAbsolute(this.lockFile) || this.lockFile.includes('\0')) throw Error('INVALID_DESKTOP_LOCK_PATH')
    this.now = dependencies.now ?? Date.now
    this.lock = dependencies.lock ?? holdDesktopWorkflowLock
    this.supportsIsolatedWindowsTool = dependencies.supportsIsolatedWindowsTool ?? (() => false)
  }

  snapshot(): ComputerUseSnapshot {
    const owner = this.owner
    return { enabled: this.enabled, authorizedSessionId: this.authorizedSessionId, phase: owner?.closing ? 'stopping' : !this.enabled ? 'disabled' : owner ? 'running' : 'ready',
      ownerSessionId: owner?.sessionId ?? null, startedAt: owner?.startedAt ?? null,
      lastActivityAt: owner?.lastActivityAt ?? null, inFlight: owner?.inFlight ?? 0,
      events: this.events.map(event => ({ ...event })) }
  }

  enable(authorizedSessionId: string): ComputerUseSnapshot {
    if (this.disposed) throw Error('COMPUTER_USE_DISPOSED')
    if (this.owner?.closing) throw Error('COMPUTER_USE_STOPPING')
    if (typeof authorizedSessionId !== 'string' || !authorizedSessionId.trim() || authorizedSessionId.length > 256 || authorizedSessionId.includes('\0')) throw Error('COMPUTER_USE_SESSION_REQUIRED')
    if (this.owner && this.owner.sessionId !== authorizedSessionId) throw Error('COMPUTER_USE_BUSY')
    this.authorizedSessionId = authorizedSessionId
    this.enabled = true
    return this.snapshot()
  }

  stop(): ComputerUseSnapshot {
    this.enabled = false
    this.authorizedSessionId = null
    if (this.owner) this.close(this.owner, 'COMPUTER_USE_STOPPED')
    return this.snapshot()
  }

  /** Retain cleanup even while Cordis withdraws a provider's service during unload. */
  bindWindowsCleanup(cleanup: () => Promise<void>): () => void {
    if (this.windowsCleanup !== undefined) throw Error('COMPUTER_USE_WINDOWS_PROVIDER_ALREADY_BOUND')
    this.windowsCleanup = cleanup
    return () => { if (this.windowsCleanup === cleanup) delete this.windowsCleanup }
  }

  /** Final monotonic guard covers native and nested PTC calls without rewriting their arguments. */
  guard(execution: ComputerUseExecution): string | undefined {
    if (!isComputerUseTool(execution.name)) return undefined
    const code = this.denial(execution)
    if (code !== undefined) this.recordDenied(execution, code)
    return code
  }

  private denial(execution: ComputerUseExecution): string | undefined {
    if (!this.enabled || this.disposed) return 'COMPUTER_USE_DISABLED'
    if (execution.agent === undefined || sessionId(execution) === undefined) return 'COMPUTER_USE_AGENT_REQUIRED'
    if (sessionId(execution) !== this.authorizedSessionId) return 'COMPUTER_USE_SESSION_NOT_AUTHORIZED'
    // These transports can settle cancellation before their native/remote work is quiet.
    // Recognize them so a configuration change cannot bypass the desktop guard.
    if (execution.name !== 'cua' && !this.supportsIsolatedWindowsTool(execution.name)) return 'COMPUTER_USE_PROVIDER_NOT_SUPPORTED'
    if (this.expired.has(execution.agent)) return 'COMPUTER_USE_LEASE_EXPIRED'
    if (this.owner?.closing) return this.drainingPreviousTurn(execution) ? undefined : 'COMPUTER_USE_STOPPING'
    if (this.owner && this.owner.agent !== execution.agent) return 'COMPUTER_USE_BUSY'
    if (this.owner && this.owner.inFlight > 0) return 'COMPUTER_USE_ACTION_IN_FLIGHT'
    return undefined
  }

  private drainingPreviousTurn(execution: ComputerUseExecution): boolean {
    const owner = this.owner
    if (!owner?.turnEnded || owner.inFlight !== 0 || owner.agent !== execution.agent || owner.turn === undefined) return false
    const turn = this.turns.get(owner.agent.session)
    return turn !== undefined && turn !== owner.turn
  }

  /** Observe committed boundaries; turn-stopping is only a proposal and may be steered. */
  observeTurn(session: object, type: 'turn/start' | 'turn/end', turn: number): void {
    if (type === 'turn/start') {
      this.turns.set(session, turn)
      return
    }
    const last = this.turnAgents.get(session)
    if (last && (last.turn === undefined || last.turn === turn)) {
      this.expired.delete(last.agent)
      this.turnAgents.delete(session)
    }
    const owner = this.owner
    if (owner?.agent.session !== session || (owner.turn !== undefined && owner.turn !== turn)) return
    owner.turnEnded = true
    this.close(owner, 'COMPUTER_USE_TURN_FINISHED')
  }

  private record(execution: ComputerUseExecution, state: ComputerUseState, code?: string): void {
    this.events.push({ id: ++this.sequence, at: this.now(), sessionId: sessionId(execution) ?? '',
      callId: String(execution.callId), tool: execution.name, method: method(execution), state, ...(code ? { code } : {}) })
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100)
  }
  private recordDenied(execution: ComputerUseExecution, code: string): void {
    if (this.denied.has(execution)) return
    this.denied.add(execution)
    this.record(execution, 'denied', code)
  }

  private refresh(lease: Lease): void {
    if (lease.timer !== undefined) clearTimeout(lease.timer)
    lease.lastActivityAt = this.now()
    if (lease.closing) return
    lease.timer = setTimeout(() => {
      this.expired.add(lease.agent)
      this.close(lease, 'COMPUTER_USE_LEASE_EXPIRED')
    }, this.idleLeaseMs)
    lease.timer.unref?.()
  }
  private close(lease: Lease, code: string): void {
    if (lease.closing) return
    lease.closing = true
    if (lease.timer !== undefined) clearTimeout(lease.timer)
    lease.controller.abort(new ComputerUseDenied(code))
    // Persistent providers can still own a native process when no call is in
    // flight. Join that generation before another process can acquire the lock.
    lease.draining = true
    try {
      const cleanup = lease.tool.startsWith('lumo_cua_windows__') ? this.windowsCleanup?.() : undefined
      if (cleanup === undefined) lease.draining = false
      else void cleanup.then(() => {
        lease.draining = false
        if (lease.inFlight === 0) lease.release.resolve()
      }, () => { /* Unconfirmed cleanup retains the desktop lease until Host restart. */ })
    } catch { /* A failed cleanup initiation cannot attest backend silence. */ }
    if (lease.inFlight === 0 && !lease.draining) lease.release.resolve()
  }

  private claim(execution: ComputerUseExecution): Lease {
    if (this.owner) return this.owner
    const startedAt = this.now()
    const lease: Lease = { agent: execution.agent!, sessionId: sessionId(execution)!, turn: this.turns.get(execution.agent!.session), controller: new AbortController(),
      ready: deferred<void>(), release: deferred<void>(), settled: Promise.resolve(), inFlight: 0,
      startedAt, lastActivityAt: startedAt, closing: false, turnEnded: false, tool: execution.name, draining: false, callers: new Map() }
    // Synchronous assignment precedes all awaits, including filesystem lock acquisition.
    this.owner = lease
    this.turnAgents.set(lease.agent.session, { agent: lease.agent, turn: lease.turn })
    const operation = this.lock(this.lockFile, async () => {
      lease.controller.signal.throwIfAborted()
      lease.ready.resolve()
      await lease.release.promise
    }, AbortSignal.any([execution.signal, lease.controller.signal]))
    lease.settled = operation.catch(() => {
      lease.closing = true
      lease.controller.abort(new ComputerUseDenied('COMPUTER_USE_LOCK_UNAVAILABLE'))
      lease.ready.reject(new ComputerUseDenied('COMPUTER_USE_LOCK_UNAVAILABLE'))
    }).finally(() => {
      if (lease.timer !== undefined) clearTimeout(lease.timer)
      for (const [signal, abort] of lease.callers) signal.removeEventListener('abort', abort)
      lease.callers.clear()
      if (this.owner === lease) this.owner = undefined
    })
    this.refresh(lease)
    return lease
  }

  /** Surround the existing provider call and await its settlement before unlocking. */
  async execute<T extends { isError: boolean }>(execution: ComputerUseExecution, dispatch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.drainingPreviousTurn(execution)) await this.owner!.settled
    const code = this.denial(execution)
    if (code !== undefined) { this.recordDenied(execution, code); throw new ComputerUseDenied(code) }
    execution.signal.throwIfAborted()
    const lease = this.claim(execution)
    lease.inFlight++
    if (!lease.callers.has(execution.signal)) {
      const abort = () => this.close(lease, 'COMPUTER_USE_CALLER_CANCELLED')
      lease.callers.set(execution.signal, abort)
      execution.signal.addEventListener('abort', abort, { once: true })
      if (execution.signal.aborted) abort()
    }
    const signal = AbortSignal.any([execution.signal, lease.controller.signal])
    let dispatched = false
    let recordedOutcome = false
    try {
      await lease.ready.promise
      signal.throwIfAborted()
      dispatched = true
      this.refresh(lease)
      this.record(execution, 'started')
      const result = await dispatch(signal)
      this.record(execution, signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'succeeded',
        signal.aborted ? 'COMPUTER_USE_CANCELLED' : result.isError ? 'COMPUTER_USE_BACKEND_FAILED' : undefined)
      recordedOutcome = true
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (!dispatched) this.recordDenied(execution, signal.aborted ? 'COMPUTER_USE_CANCELLED' : 'COMPUTER_USE_LOCK_UNAVAILABLE')
      else if (!recordedOutcome) this.record(execution, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? 'COMPUTER_USE_CANCELLED' : 'COMPUTER_USE_BACKEND_FAILED')
      throw error
    } finally {
      lease.inFlight--
      if (lease.closing && lease.inFlight === 0 && !lease.draining) lease.release.resolve()
      else if (!lease.closing) this.refresh(lease)
    }
  }

  async releaseOwner(agent: ComputerUseAgent): Promise<void> {
    this.expired.delete(agent)
    const owner = this.owner
    if (owner?.agent !== agent) return
    this.close(owner, 'COMPUTER_USE_TURN_FINISHED')
    await owner.settled
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.stop()
    await this.owner?.settled
  }
}
