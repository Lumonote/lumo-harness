import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { FencedOutError, LogForkError, type LogRecord } from '../../../shared/seam-contracts/session-log.ts'

export interface ReplicationHealth { ready: boolean; pending: number; lastError?: string }
export interface SessionLogReplication {
  health(): ReplicationHealth
  flush(): Promise<void>
}

const sessionKey = (sessionRef: string) => createHash('sha256').update(sessionRef).digest('hex')
const fileName = (record: LogRecord) => `${sessionKey(record.sessionRef)}-${record.seq}.json`

/** One fsynced file per unacknowledged event; removal follows the PG commit. */
export class DiskReplicationSpool {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  load(): LogRecord[] {
    return readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => {
      const record = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as LogRecord
      if (!record.sessionRef || !Number.isSafeInteger(record.seq) || record.seq < 0 || fileName(record) !== name) throw new Error(`Invalid replication spool record: ${name}`)
      return record
    })
  }
  loadFences(): Array<{ sessionRef: string; reason: string }> {
    return readdirSync(this.directory).filter(name => name.endsWith('.fenced')).map(name => {
      const item = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as { sessionRef: string; reason: string }
      if (typeof item.sessionRef !== 'string' || typeof item.reason !== 'string' || `${sessionKey(item.sessionRef)}.fenced` !== name) {
        throw new Error(`Invalid replication quarantine record: ${name}`)
      }
      return item
    })
  }
  quarantine(sessionRef: string, reason: string): void {
    this.writeDurable(`${sessionKey(sessionRef)}.fenced`, { sessionRef, reason })
  }
  put(record: LogRecord): void { this.writeDurable(fileName(record), record) }
  private writeDurable(name: string, value: unknown): void {
    const temporary = join(this.directory, `${name}.${randomUUID()}.tmp`)
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, join(this.directory, name))
    this.syncDirectory()
  }
  remove(record: LogRecord): void {
    try { unlinkSync(join(this.directory, fileName(record))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.syncDirectory()
  }
  private syncDirectory(): void {
    const fd = openSync(this.directory, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}

interface ReplicationOptions {
  spool: DiskReplicationSpool
  write(record: LogRecord): Promise<void>
  onFatal(sessionRef: string, error: Error): void
  maxPending?: number
  retryMs?: number
}

/** Stop at the first failed seq; subsequent events can never overtake its retry. */
export class ReplicationQueue implements SessionLogReplication {
  private readonly pending = new Map<string, Map<number, LogRecord>>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly errors = new Map<string, string>()
  private readonly fatal = new Set<string>()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly options: ReplicationOptions) {
    for (const record of options.spool.load()) this.remember(record)
    for (const { sessionRef, reason } of options.spool.loadFences()) {
      this.fatal.add(sessionRef)
      this.errors.set(sessionRef, reason)
      options.onFatal(sessionRef, new Error(reason))
    }
    this.timer = setInterval(() => { for (const session of this.pending.keys()) this.wake(session) }, options.retryMs ?? 1000)
    this.timer.unref()
  }

  stage(record: LogRecord): void {
    if (this.fatal.has(record.sessionRef)) throw new Error(this.errors.get(record.sessionRef) ?? 'Session log replication is quarantined')
    try {
      if (this.closed) throw new Error('Session log replication is closing')
      const previous = this.pending.get(record.sessionRef)?.get(record.seq)
      if (previous) {
        if (!isDeepStrictEqual(previous, record)) throw new LogForkError(record.sessionRef, record.seq, 'pending', 'different event')
        return
      }
      if (this.health().pending >= (this.options.maxPending ?? 4096)) {
        throw new Error('Session log replication backlog is full; execution must stop')
      }
      this.options.spool.put(record)
      this.remember(record)
      this.wake(record.sessionRef)
    } catch (error: unknown) {
      // DSH has already appended this event. Refusing to stage it cannot roll
      // back that append, so an ordinary retry of the earlier spool prefix is
      // insufficient: after restart it would hide the missing tail. Preserve
      // the failure across restarts whenever the disk can still write a marker.
      this.quarantine(record.sessionRef, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private quarantine(sessionRef: string, error: Error): void {
    this.fatal.add(sessionRef)
    let failure = error
    try { this.options.spool.quarantine(sessionRef, error.message) } catch (diskError) {
      failure = new Error(`${error.message}; could not persist quarantine: ${diskError}`, { cause: error })
    }
    this.errors.set(sessionRef, failure.message)
    this.options.onFatal(sessionRef, failure)
  }

  private remember(record: LogRecord): void {
    let records = this.pending.get(record.sessionRef)
    if (!records) this.pending.set(record.sessionRef, records = new Map())
    records.set(record.seq, record)
  }

  wake(sessionRef: string): void {
    if (this.closed || this.running.has(sessionRef) || this.fatal.has(sessionRef)) return
    const work = Promise.resolve().then(async () => {
      const records = this.pending.get(sessionRef)
      while (records?.size && !this.fatal.has(sessionRef)) {
        const seq = Math.min(...records.keys())
        const record = records.get(seq)!
        await this.options.write(record)
        this.options.spool.remove(record)
        records.delete(seq)
      }
      if (this.fatal.has(sessionRef)) return
      this.pending.delete(sessionRef)
      this.errors.delete(sessionRef)
    }).catch((error: unknown) => {
      if (this.fatal.has(sessionRef)) return
      this.errors.set(sessionRef, error instanceof Error ? error.message : String(error))
      if (error instanceof FencedOutError || error instanceof LogForkError) {
        this.quarantine(sessionRef, error)
      }
    }).finally(() => { this.running.delete(sessionRef) })
    this.running.set(sessionRef, work)
  }

  async flushSession(sessionRef: string): Promise<void> {
    this.wake(sessionRef)
    await this.running.get(sessionRef)
    if (this.pending.get(sessionRef)?.size || this.errors.has(sessionRef)) {
      throw new Error(this.errors.get(sessionRef) ?? 'Session log replication is unconfirmed')
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...new Set([...this.pending.keys(), ...this.errors.keys()])].map(session => this.flushSession(session)))
  }

  health(): ReplicationHealth {
    const pending = [...this.pending.values()].reduce((sum, records) => sum + records.size, 0)
    const lastError = this.errors.values().next().value
    return { ready: !this.closed && !pending && !lastError, pending, ...(lastError ? { lastError } : {}) }
  }

  async close(): Promise<void> {
    try { await this.flush() } finally {
      this.closed = true
      clearInterval(this.timer)
      await Promise.allSettled(this.running.values())
    }
  }
}
