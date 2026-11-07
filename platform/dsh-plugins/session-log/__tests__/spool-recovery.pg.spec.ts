import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { PgSessionLog } from '../src/pg-log.ts'
import { DiskReplicationSpool } from '../src/replication-queue.ts'

const dsn = process.env['LUMO_TEST_PG_DSN']
describe.skipIf(!dsn)('durable spool process recovery', () => {
  it('waits for its predecessor lease to expire and then commits the pending event', async () => {
    const schema = 'lumo_spool_' + randomUUID().replaceAll('-', '')
    const admin = new pg.Pool({ connectionString: dsn })
    const directory = mkdtempSync(join(tmpdir(), 'lumo-spool-recovery-'))
    const ctx = new Context()
    let log: PgSessionLog | undefined
    try {
      await admin.query('CREATE SCHEMA ' + schema)
      const url = new URL(dsn!)
      url.searchParams.set('options', '-c search_path=' + schema)
      log = new PgSessionLog(url.toString())
      await log.init()
      await log.acquire('session', 'previous-instance', 60_000)
      const record = { sessionRef: 'session', seq: 0, type: 'test', time: 1, payload: { durable: true } }
      new DiskReplicationSpool(directory).put(record)
      await apply(ctx, { connectionString: url.toString(), holder: 'replacement-instance', spoolDirectory: directory })
      await expect(ctx.sessionLogReplication.flush()).rejects.toThrow('still leased')
      expect(await log.read('session')).toEqual([])
      await log.raw("UPDATE session_writer_lease SET expires_at=0 WHERE session_ref='session'")
      await ctx.sessionLogReplication.flush()
      expect(await log.read('session')).toEqual([record])
      expect(ctx.sessionLogReplication.health()).toEqual({ ready: true, pending: 0 })
    } finally {
      await ctx.fiber.dispose()
      await log?.close()
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
      await admin.end()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
