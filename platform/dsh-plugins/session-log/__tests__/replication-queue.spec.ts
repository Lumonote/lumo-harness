import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiskReplicationSpool, ReplicationQueue } from '../src/replication-queue.ts'
import { FencedOutError, type LogRecord } from '../../../shared/seam-contracts/session-log.ts'

const folders: string[] = []
const queues: ReplicationQueue[] = []
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close().catch(() => {})
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const event = (seq: number): LogRecord => ({ sessionRef: 'session', seq, type: 'test', payload: { seq }, time: seq })
function spool() {
  const directory = mkdtempSync(join(tmpdir(), 'lumo-replication-test-'))
  folders.push(directory)
  return new DiskReplicationSpool(directory)
}
function queue(storage: DiskReplicationSpool, write: (event: LogRecord) => Promise<void>) {
  const result = new ReplicationQueue({ spool: storage, write, onFatal() {}, retryMs: 60_000 })
  queues.push(result)
  return result
}

describe('durable ordered session replication', () => {
  it('blocks the failed sequence and retries it before later events', async () => {
    const storage = spool()
    let unavailable = true
    const written: number[] = []
    const replication = queue(storage, async record => {
      if (record.seq === 1 && unavailable) throw new Error('database temporarily unavailable')
      written.push(record.seq)
    })
    for (let seq = 0; seq < 3; seq++) replication.stage(event(seq))
    await expect(replication.flush()).rejects.toThrow('temporarily unavailable')
    expect(written).toEqual([0])
    expect(storage.load().map(record => record.seq).sort()).toEqual([1, 2])
    expect(storage.loadFences()).toEqual([])
    expect(replication.health()).toMatchObject({ ready: false, pending: 2 })
    unavailable = false
    await replication.flush()
    expect(written).toEqual([0, 1, 2])
    expect(storage.load()).toEqual([])
    expect(replication.health()).toEqual({ ready: true, pending: 0 })
  })

  it('reopens the same durable spool after a process stopped during an outage', async () => {
    const storage = spool()
    const first = queue(storage, async () => { throw new Error('offline') })
    first.stage(event(1)); first.stage(event(0))
    await expect(first.close()).rejects.toThrow('offline')
    const written: number[] = []
    const second = queue(new DiskReplicationSpool(storage.directory), async record => { written.push(record.seq) })
    await second.flush()
    expect(written).toEqual([0, 1])
    expect(storage.load()).toEqual([])
  })

  it('retains fenced events for review and refuses to acknowledge a flush', async () => {
    const storage = spool()
    let calls = 0
    const replication = queue(storage, async () => { calls++; throw new FencedOutError('session', 1, 2) })
    replication.stage(event(0))
    await expect(replication.flush()).rejects.toThrow('令牌')
    await expect(replication.flush()).rejects.toThrow('令牌')
    expect(calls).toBe(1)
    expect(storage.load()).toHaveLength(1)
  })

  it('keeps a fenced spool quarantined after restart instead of replaying stale events', async () => {
    const storage = spool()
    const first = queue(storage, async () => { throw new FencedOutError('session', 1, 2) })
    first.stage(event(0))
    await expect(first.close()).rejects.toThrow('令牌')
    let writes = 0
    const restarted = queue(new DiskReplicationSpool(storage.directory), async () => { writes++ })
    await expect(restarted.flush()).rejects.toThrow('令牌')
    expect(writes).toBe(0)
    expect(restarted.health()).toMatchObject({ ready: false, pending: 1 })
    expect(storage.load()).toEqual([event(0)])
  })

  it('rejects conflicting pending content instead of replacing its recovery record', async () => {
    const storage = spool()
    const replication = queue(storage, async () => { throw new Error('offline') })
    replication.stage(event(0))
    expect(() => replication.stage({ ...event(0), payload: { different: true } })).toThrow('分叉')
    expect(storage.load()).toEqual([event(0)])
  })

  it('persists quarantine when a full spool cannot stage an already appended event, including after restart', async () => {
    const storage = spool()
    const onFatal = vi.fn()
    const first = new ReplicationQueue({ spool: storage, maxPending: 1, retryMs: 60_000,
      write: async () => { throw new Error('offline') }, onFatal })
    queues.push(first)
    first.stage(event(0))
    expect(() => first.stage(event(1))).toThrow('backlog is full')
    expect(onFatal).toHaveBeenCalledOnce()
    expect(storage.loadFences()).toEqual([{ sessionRef: 'session', reason: 'Session log replication backlog is full; execution must stop' }])
    await first.close().catch(() => {})
    const write = vi.fn(async () => {})
    const restarted = queue(new DiskReplicationSpool(storage.directory), write)
    await expect(restarted.flush()).rejects.toThrow('backlog is full')
    expect(write).not.toHaveBeenCalled()
    expect(restarted.health()).toMatchObject({ ready: false, pending: 1 })
    expect(storage.load()).toEqual([event(0)])
  })

  it('fences the current process and reports when even the failure marker cannot be persisted', async () => {
    const storage = spool()
    vi.spyOn(storage, 'put').mockImplementation(() => { throw new Error('disk write EIO') })
    vi.spyOn(storage, 'quarantine').mockImplementation(() => { throw new Error('marker write EIO') })
    const onFatal = vi.fn()
    const replication = new ReplicationQueue({ spool: storage, retryMs: 60_000, write: async () => {}, onFatal })
    queues.push(replication)
    expect(() => replication.stage(event(0))).toThrow('disk write EIO')
    expect(onFatal).toHaveBeenCalledWith('session', expect.objectContaining({ message: expect.stringContaining('could not persist quarantine: Error: marker write EIO') }))
    expect(replication.health()).toMatchObject({ ready: false, pending: 0, lastError: expect.stringContaining('marker write EIO') })
    await expect(replication.flush()).rejects.toThrow('could not persist quarantine')
    expect(storage.loadFences()).toEqual([])
  })

  it('does not clear an unstaged-tail failure when an older in-flight write succeeds', async () => {
    const storage = spool()
    let complete!: () => void
    const replication = new ReplicationQueue({ spool: storage, maxPending: 1, retryMs: 60_000,
      write: () => new Promise(resolve => { complete = resolve }), onFatal() {} })
    queues.push(replication)
    replication.stage(event(0))
    await Promise.resolve()
    expect(() => replication.stage(event(1))).toThrow('backlog is full')
    complete()
    await expect(replication.flush()).rejects.toThrow('backlog is full')
    expect(replication.health()).toMatchObject({ ready: false, pending: 0, lastError: expect.stringContaining('backlog is full') })
    expect(storage.loadFences()).toHaveLength(1)
  })
})
