/**
 * `queryWithStaleness` 读面装配对**真 PG** 跑。
 *
 * 断言的全是「读面与日志复制同源、绝不半截」的装配事实：records 全量照回、
 * replicaHead 恒取本地已复制段（PG read）的最大 seq、liveHead 给定时 fresh/stale
 * 两臂与阈值边界、未给 liveHead 恒 fresh（v1 诚实边界）。热层不进本读面——
 * 真相源是 PG，判别基准必须与 resume 同源。
 *
 * 无 DSN 时 skip 且 **skip 可见**：静默 return 会让报告显示「通过」（pg-log.spec 同法）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'
import { apply, PgSessionLog } from '../src/index.ts'
import { schemaDsn } from './pg-schema.ts'

const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const t = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'

/** 每个测试拿独立 schema（TRUNCATE 互不干扰，理由见 pg-schema.ts 注释）。 */
async function withBoot(
  fn: (ctx: Context, pg: PgSessionLog) => Promise<void>,
): Promise<void> {
  const dsn = await schemaDsn(DSN!, 'session_log_query_test')
  const ctx = new Context()
  apply(ctx, {
    connectionString: dsn,
    holder: 'query-test-node',
    leaseTtlMs: 30_000,
  })
  const seeder = new PgSessionLog(dsn)
  try {
    await seeder.init()
    await seeder.raw('TRUNCATE session_log, session_writer_lease')
    await fn(ctx, seeder)
  } finally {
    await ctx.fiber.dispose()
    await seeder.close()
  }
}

/**
 * 向真源种记录：经 ctx.sessionLog seam 的 acquire/append 公开放置面走一遍
 * 真写路径（fencing token / 主键幂等都照实生效），种完即得与 resume 同源的历史。
 */
async function seed(ctx: Context, sessionRef: string, seqs: number[]): Promise<LogRecord[]> {
  const lease = await ctx.sessionLog.acquire(sessionRef, 'query-seeder', 60_000)
  if (!lease) throw new Error(`种数据失败：${sessionRef} 抢不到写者租约`)
  const records: LogRecord[] = seqs.map((seq) => ({
    sessionRef,
    seq,
    type: 'user_message',
    payload: { content: `msg-${seq}` },
    time: 1_700_000_000_000 + seq,
  }))
  for (const record of records) {
    const r = await ctx.sessionLog.append(record, lease.fencingToken)
    if (r.status !== 'appended') throw new Error(`种数据失败：${sessionRef}#${record.seq} 未落库`)
  }
  return records
}

describe(`读面 staleness 信封 —— 对真 PG（需 SESSION_LOG_TEST_DSN，当前${suffix}）`, () => {
  t('records 回返 —— 未给 liveHead 恒 fresh 全量；空日志是诚实空集', async () => {
    await withBoot(async (ctx) => {
      const seeded = await seed(ctx, 'sess-a', [1, 2, 3])
      const env = await ctx.sessionLogQuery.queryWithStaleness('sess-a')
      expect(env.kind).toBe('fresh')
      if (env.kind !== 'fresh') return
      expect(env.records).toEqual(seeded)
      // 空会话同样是全量：空不是「半截」，是真没有
      const empty = await ctx.sessionLogQuery.queryWithStaleness('sess-empty')
      expect(empty).toEqual({ kind: 'fresh', records: [] })
    })
  })

  t('replicaHead 与 PG read 最大 seq 一致 —— stale 臂携证据字段', async () => {
    await withBoot(async (ctx) => {
      // 乱序 append（先 9 后 5）：read 按 seq 升序，head 必须是 max=9——不是「最后写的」
      await seed(ctx, 'sess-b', [9, 5])
      const env = await ctx.sessionLogQuery.queryWithStaleness('sess-b', { liveHead: 20 })
      expect(env.kind).toBe('stale')
      if (env.kind !== 'stale') return
      expect(env.reason).toBe('replication-lag')
      expect(env.replicaHead).toBe(9)
      expect(env.liveHead).toBe(20)
      expect(env.lag).toBe(11)
    })
  })

  t('liveHead 给定时两臂与阈值边界：lag==maxLag fresh（带全量）；lag==maxLag+1 stale（不带 records）', async () => {
    await withBoot(async (ctx) => {
      await seed(ctx, 'sess-c', [1, 2, 3])
      const base = await ctx.sessionLogQuery.queryWithStaleness('sess-c', { liveHead: 7, maxLag: 4 })
      expect(base.kind).toBe('fresh')
      if (base.kind === 'fresh') {
        expect(base.records).toEqual(await readAll(ctx, 'sess-c'))
      }
      const over = await ctx.sessionLogQuery.queryWithStaleness('sess-c', { liveHead: 8, maxLag: 4 })
      expect(over.kind).toBe('stale')
      if (over.kind === 'stale') {
        // 显式 stale 绝不夹带半截 records——调用方拿到的是证据，不是看似完整的历史
        expect(Object.hasOwn(over, 'records')).toBe(false)
        expect(over.lag).toBe(5)
      }
    })
  })

  t('lag=0 恒 fresh；显式 maxLag=0 时任何落后即 stale（阈值边界另一端）', async () => {
    await withBoot(async (ctx) => {
      await seed(ctx, 'sess-d', [1, 2])
      const same = await ctx.sessionLogQuery.queryWithStaleness('sess-d', { liveHead: 2 })
      expect(same.kind).toBe('fresh')
      if (same.kind === 'fresh') expect(same.records).toHaveLength(2)

      const strict = await ctx.sessionLogQuery.queryWithStaleness('sess-d', { liveHead: 3, maxLag: 0 })
      expect(strict).toEqual({
        kind: 'stale',
        reason: 'replication-lag',
        replicaHead: 2,
        liveHead: 3,
        lag: 1,
      })
    })
  })

  t('未给 liveHead 恒 fresh（v1 诚实边界），缺省 maxLag=8 生效', async () => {
    await withBoot(async (ctx) => {
      await seed(ctx, 'sess-e', [1, 2]) // head=2
      // 不带任何 opts：无判别基准 ⇒ 恒 fresh 全量
      const plain = await ctx.sessionLogQuery.queryWithStaleness('sess-e')
      expect(plain.kind).toBe('fresh')

      // 缺省阈值内（lag=8 == 缺省）⇒ fresh；恰好越过（lag=9 > 缺省 8）⇒ stale。
      // 这两臂从外部行为钉死「缺省 maxLag 常量 = 8」。
      const within = await ctx.sessionLogQuery.queryWithStaleness('sess-e', { liveHead: 10 }) // lag=8
      expect(within.kind).toBe('fresh')
      const past = await ctx.sessionLogQuery.queryWithStaleness('sess-e', { liveHead: 11 }) // lag=9
      expect(past.kind).toBe('stale')
      if (past.kind === 'stale') expect(past.lag).toBe(9)
    })
  })
})

/** 读回全量对照（同一真源）。 */
async function readAll(ctx: Context, sessionRef: string): Promise<LogRecord[]> {
  return ctx.sessionLog.read(sessionRef)
}
