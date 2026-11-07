import { setTimeout as delay } from 'node:timers/promises'

export interface ReplicationHealth { ready: boolean; pending: number; lastError?: string }

/** Admission closes synchronously, before any awaited discovery/network work. */
export class HostLifecycle {
  private draining = false
  private initialized = false
  private withdrawing?: Promise<void>
  private admissions = 0

  constructor(private readonly dependencies: {
    active(): number
    health(): ReplicationHealth
    check(): Promise<void>
    withdraw(): Promise<void>
    pause(): void
    flush(): Promise<void>
  }) {}

  start() { this.initialized = true }
  admitting() { return this.initialized && !this.draining && this.dependencies.health().ready }
  beginAdmission() {
    if (!this.admitting()) throw new Error('execution node is not accepting new work')
    this.admissions++
    let finished = false
    return () => { if (!finished) { finished = true; this.admissions-- } }
  }
  async ready() {
    if (!this.admitting()) return false
    try { await this.dependencies.check(); return this.admitting() } catch { return false }
  }
  status() { return { ready: this.admitting(), draining: this.draining, active: this.dependencies.active() + this.admissions, replication: this.dependencies.health() } }

  async drain(timeoutMS: number): Promise<boolean> {
    this.draining = true
    this.dependencies.pause()
    // Keep a rejected withdrawal retryable; never report a successful drain
    // while the directory still accepts new placements for this node.
    this.withdrawing ??= this.dependencies.withdraw().catch(error => { this.withdrawing = undefined; throw error })
    const deadline = Date.now() + timeoutMS
    if (!await beforeDeadline(this.withdrawing, deadline)) return false
    while (this.dependencies.active() + this.admissions > 0) {
      if (Date.now() >= deadline) return false
      await delay(Math.min(100, Math.max(1, deadline - Date.now())))
    }
    return beforeDeadline(this.dependencies.flush(), deadline)
  }
}

/** Directory withdrawal and log flush share the caller's total drain budget. */
async function beforeDeadline(work: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) { void work.catch(() => {}); return false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining) }),
    ])
  } finally { clearTimeout(timer) }
}
