import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { describe, it, expect } from 'vitest'
import { PgSessionLog } from '../src/pg-log.ts'
import { FencedOutError } from '../../../shared/seam-contracts/session-log.ts'
import { schemaDsn } from './pg-schema.ts'

const dsn = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const live = dsn ? it : it.skip
const record = { sessionRef: 'owned', seq: 0, type: 'test', payload: { text: 'late' }, time: 1 }

async function prepare(schema: string) {
  const scoped = await schemaDsn(dsn!, schema)
  const log = new PgSessionLog(scoped)
  await log.init()
  for (const migration of ['017_session_owners.sql', '027_session_execution_leases.sql']) {
    await log.raw(await readFile(new URL(`../../../deploy/migrations/${migration}`, import.meta.url), 'utf8'))
  }
  await log.raw(`TRUNCATE session_log,session_writer_lease,session_log_heads,
    session_execution_leases,session_execution_nodes,session_owners;
    INSERT INTO session_owners(session_ref,realm,owner_user_id,project_id,node_id,state,creation_token_hash)
      VALUES('owned','r','alice','p','n','active','hash');
    INSERT INTO session_execution_nodes
      VALUES('r','n','p','process','','hash',1,clock_timestamp()+interval '1 minute');
    INSERT INTO session_execution_leases
      VALUES('owned','r','n','p','process',1,1,'writer',clock_timestamp()+interval '1 minute')`)
  return { log, scoped }
}

async function waitForBlockedOperation(blocker: pg.Client) {
  const deadline = Date.now() + 800
  while (Date.now() < deadline) {
    await blocker.query('SELECT pg_stat_clear_snapshot()')
    const state = await blocker.query<{ waiting: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM pg_stat_activity a WHERE pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) AS waiting`)
    if (state.rows[0]!.waiting) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('operation did not reach the held database lock before its deadline')
}

describe('dynamic Session execution generation fences PG log writes', () => {
  live('rejects expired and previous processes even while the writer lease is still valid', async () => {
    const { log } = await prepare('session_execution_fence')
    try {
      const first = (await log.acquire('owned', 'writer', 60000))!
      expect(first.fencingToken).toBe(1)
      await log.append({ ...record, payload: { text: 'before' } }, first.fencingToken)
      await log.raw(`UPDATE session_execution_nodes SET expires_at=clock_timestamp()-interval '1 second'`)
      await expect(log.acquire('owned', 'writer', 60000)).rejects.toBeInstanceOf(FencedOutError)
      await expect(log.append({ ...record, seq: 1 }, first.fencingToken)).rejects.toBeInstanceOf(FencedOutError)
      await expect(log.publishHead('owned', 1, first.fencingToken)).rejects.toBeInstanceOf(FencedOutError)
      await log.raw(`UPDATE session_execution_nodes SET process_id='process-b',fence=2,
          expires_at=clock_timestamp()+interval '1 minute';
        UPDATE session_execution_leases SET process_id='process-b',node_fence=2,fencing_token=2,
          writer_holder='writer-b',expires_at=clock_timestamp()+interval '1 minute';
        UPDATE session_writer_lease SET expires_at=0 WHERE session_ref='owned'`)
      const second = (await log.acquire('owned', 'writer-b', 60000))!
      expect(second.fencingToken).toBe(2)
      await expect(log.acquire('owned', 'writer', 60000)).rejects.toBeInstanceOf(FencedOutError)
      await expect(log.append({ ...record, seq: 1 }, first.fencingToken)).rejects.toBeInstanceOf(FencedOutError)
      await log.append({ ...record, seq: 1, payload: { text: 'current' } }, second.fencingToken)
      expect((await log.read('owned')).map(row => row.payload)).toEqual([{ text: 'before' }, { text: 'current' }])
      expect((await log.acquire('unowned', 'legacy', 60000))?.fencingToken).toBe(1)
    } finally { await log.close() }
  })

  live('denies a registered owner with no execution authority', async () => {
    const log = new PgSessionLog(await schemaDsn(dsn!, 'session_execution_missing'))
    try {
      await log.init()
      await log.raw(await readFile(new URL('../../../deploy/migrations/017_session_owners.sql', import.meta.url), 'utf8'))
      await log.raw(`TRUNCATE session_log,session_writer_lease,session_log_heads,session_owners CASCADE;
        INSERT INTO session_owners(session_ref,realm,owner_user_id,project_id,node_id,state,creation_token_hash)
        VALUES('owned','r','alice','p','n','active','hash')`)
      await expect(log.acquire('owned', 'writer', 60000)).rejects.toBeInstanceOf(FencedOutError)
    } finally { await log.close() }
  })

  live.each(['append', 'head', 'acquire'])('rejects %s when execution expires while waiting for the writer lock', async operation => {
    const { log, scoped } = await prepare(`session_execution_wait_${operation}`)
    const blocker = new pg.Client({ connectionString: scoped })
    try {
      await blocker.connect()
      const writer = (await log.acquire('owned', 'writer', 60000))!
      await log.raw(`UPDATE session_execution_nodes SET expires_at=clock_timestamp()+interval '1 second'`)
      await blocker.query('BEGIN')
      await blocker.query(`SELECT 1 FROM session_writer_lease WHERE session_ref='owned' FOR UPDATE`)
      const pending = (operation === 'append' ? log.append(record, writer.fencingToken)
        : operation === 'head' ? log.publishHead('owned', 1, writer.fencingToken)
        : log.acquire('owned', 'writer', 60000)).then(() => undefined, error => error)
      await waitForBlockedOperation(blocker)
      await blocker.query('SELECT pg_sleep(1.1)')
      await blocker.query('COMMIT')
      expect(await pending).toBeInstanceOf(FencedOutError)
      expect(await log.read('owned')).toEqual([])
      expect(await log.head('owned')).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await blocker.end()
      await log.close()
    }
  })

  live.each([
    ['head', 'execution'], ['append', 'execution'], ['head', 'writer'], ['append', 'writer'],
  ])('rolls back %s after a content lock wait crosses the %s deadline', async (operation, authority) => {
    const { log, scoped } = await prepare(`session_execution_content_${operation}_${authority}`)
    const blocker = new pg.Client({ connectionString: scoped })
    try {
      await blocker.connect()
      const writer = (await log.acquire('owned', 'writer', 60000))!
      if (operation === 'head') await log.publishHead('owned', 0, writer.fencingToken)
      await log.raw(authority === 'execution'
        ? `UPDATE session_execution_nodes SET expires_at=clock_timestamp()+interval '1 second'`
        : `UPDATE session_writer_lease SET expires_at=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint+1000`)
      await blocker.query('BEGIN')
      if (operation === 'head') {
        await blocker.query(`SELECT 1 FROM session_log_heads WHERE session_ref='owned' FOR UPDATE`)
      } else {
        await blocker.query(`INSERT INTO session_log VALUES('owned',0,1,'test','{}','repair',1,1)`)
      }
      const pending = (operation === 'head' ? log.publishHead('owned', 1, writer.fencingToken)
        : log.append(record, writer.fencingToken)).then(() => undefined, error => error)
      await waitForBlockedOperation(blocker)
      await blocker.query('SELECT pg_sleep(1.1)')
      // Remove the tentative repair row, allowing append to reach its write.
      await blocker.query(operation === 'head' ? 'COMMIT' : 'ROLLBACK')
      expect(await pending).toBeInstanceOf(FencedOutError)
      expect(await log.read('owned')).toEqual([])
      expect(await log.head('owned')).toBe(0)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await blocker.end()
      await log.close()
    }
  })
})
