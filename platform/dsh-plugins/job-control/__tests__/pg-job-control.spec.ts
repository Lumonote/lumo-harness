/** Real-PG coverage for the control mailbox and result-event source of truth. */
import { describe, expect, it } from 'vitest'
import pg from 'pg'

import { PgJobControlSeam } from '../src/pg-job-control.ts'
import { schemaDsn } from '../../session-log/__tests__/pg-schema.ts'

const DSN = process.env['JOB_CONTROL_TEST_DSN'] ?? process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const t = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'
const ref = { sessionRef: 'sess-1', node: 'node-1', jobId: 'bash-1' }

async function withSeam(fn: (seam: PgJobControlSeam) => Promise<void>): Promise<void> {
  const dsn = await schemaDsn(DSN!, 'job_control_test')
  const seam = new PgJobControlSeam(dsn)
  const cleaner = new pg.Client({ connectionString: dsn })
  try {
    await seam.init()
    await cleaner.connect()
    await cleaner.query(
      'TRUNCATE job_control_command, job_result_event, job_event_seq, job_execution',
    )
    await fn(seam)
  } finally {
    await cleaner.end()
    await seam.close()
  }
}

describe(`job-control —— 对真 PG（需 JOB_CONTROL_TEST_DSN，当前${suffix}）`, () => {
  t('授权+幂等下发、节点消费、本地终态与事件流按同一 JobRef 收口', async () => {
    await withSeam(async (seam) => {
      await seam.record({ ref, kind: 'bash', label: 'sleep 60', status: 'running', startedAt: 100 })

      const first = await seam.dispatch({
        ref, command: 'kill', actor: 'alice', role: 'operator', reason: 'cancel', correlationId: 'c-1',
      })
      expect(first).toEqual({ allowed: true, effect: 'requested' })
      expect(await seam.take('node-1')).toEqual([{
        correlationId: 'c-1', ref, command: 'kill', reason: 'cancel',
      }])
      await seam.ack('c-1')
      expect(await seam.take('node-1')).toEqual([])

      // Local executor, not dispatch(), owns this state transition.
      await seam.record({
        ref, kind: 'bash', label: 'sleep 60', status: 'killed', detail: 'cancel', startedAt: 100, finishedAt: 200,
      })
      expect(await seam.events('sess-1')).toEqual([
        { type: 'job/started', seq: 1, ref, kind: 'bash', label: 'sleep 60', startedAt: 100 },
        { type: 'job/finished', seq: 2, ref, status: 'killed', detail: 'cancel', finishedAt: 200 },
      ])
      expect(await seam.snapshot(ref)).toEqual({
        ref, kind: 'bash', status: 'killed', detail: 'cancel', startedAt: 100, finishedAt: 200,
      })

      // Same idempotency key returns its original decision and cannot enqueue again.
      expect(await seam.dispatch({
        ref, command: 'kill', actor: 'alice', role: 'operator', reason: 'cancel', correlationId: 'c-1',
      })).toEqual(first)
      expect(await seam.take('node-1')).toEqual([])
      expect(await seam.dispatch({
        ref, command: 'kill', actor: 'alice', role: 'operator', reason: 'again', correlationId: 'c-2',
      })).toEqual({ allowed: true, effect: 'already-terminal' })
    })
  })

  t('先鉴权、status 不进入执行 inbox、unknown-job 诚实拒绝', async () => {
    await withSeam(async (seam) => {
      await seam.record({ ref, kind: 'bash', label: 'build', status: 'running', startedAt: 10 })
      expect(await seam.dispatch({
        ref, command: 'kill', actor: 'eve', role: 'viewer', reason: 'probe', correlationId: 'c-viewer',
      })).toEqual({ allowed: false, reason: 'not-authorized' })
      expect(await seam.dispatch({
        ref, command: 'status', actor: 'alice', role: 'operator', reason: 'inspect', correlationId: 'c-status',
      })).toEqual({ allowed: true, effect: 'observed' })
      expect(await seam.take('node-1')).toEqual([])
      expect(await seam.dispatch({
        ref: { ...ref, jobId: 'bash-404' }, command: 'kill', actor: 'alice', role: 'operator', reason: 'missing', correlationId: 'c-missing',
      })).toEqual({ allowed: false, reason: 'unknown-job' })
    })
  })
})
