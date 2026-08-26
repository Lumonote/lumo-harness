import { describe, expect, it } from 'vitest'

import {
  SegmentCorruptError,
  segmentRelativeInfoKey,
  segmentRelativeKey,
} from '../../../shared/seam-contracts/cold-log.ts'
import { MinioObjectStore } from '../../object-store/src/minio-store.ts'
import { minioOptions, testEnabled, uniqueRealm } from '../../object-store/__tests__/minio-helper.ts'
import { PgColdLogArchiver } from '../src/cold-log.ts'
import { PgSessionLog } from '../src/pg-log.ts'
import { schemaDsn } from './pg-schema.ts'

/**
 * 冷层段归档对**真 PG + 真 MinIO** 跑。
 *
 * 契约层（`shared/seam-contracts/__tests__/cold-log.spec.ts`）已锁段键/序列化/保留期的
 * 纯函数；这里断言的才是归档的真实 IO 语义：
 *   - 只读 PG 真源、把段写进 MinIO（经 `ctx.objectStore`），**不占写者租约**；
 *   - 幂等：同段区间重跑不重写对象，靠 `.info` 侧车 stat 跳过；
 *   - 完整性：读回对拍 `.info`（sha256+bytes），字节被改 → `SegmentCorruptError`；
 *   - 保留期：过期段从 MinIO 删对象 + 清 PG 归档行。
 *
 * 两个真依赖（PG 与 MinIO）任一未配置即整组 **skip 且可见**。
 */
const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const minioOk = testEnabled()
const enabled = Boolean(DSN) && minioOk
const t = enabled ? it : it.skip
const suffix = enabled
  ? '已设置'
  : `PG=${DSN ? '已设置' : '未设置'} / MinIO=${minioOk ? '已设置' : '未设置'} → 跳过，非通过`

const REALM = uniqueRealm()

async function withArchiver(fn: (cold: PgColdLogArchiver, log: PgSessionLog) => Promise<void>): Promise<void> {
  const dsn = await schemaDsn(DSN!, 'session_log_cold_test')
  const log = new PgSessionLog(dsn)
  const store = new MinioObjectStore(minioOptions())
  const cold = new PgColdLogArchiver(
    { connectionString: dsn, realm: REALM, maxItems: 2 },
    store,
  )
  try {
    await log.init()
    await cold.init()
    await log.raw('TRUNCATE session_log, session_log_archive')
    await fn(cold, log)
  } finally {
    await log.close()
    await cold.close()
  }
}

/** 直接写进 `session_log`（冷层只读它；fencing/digest 是公有表 NOT NULL 列，给占位即可）。 */
async function seed(log: PgSessionLog, sessionRef: string, seqs: number[], type = 'user_message'): Promise<void> {
  for (const seq of seqs) {
    await log.raw(
      `INSERT INTO session_log
         (session_ref, seq, fencing_token, event_type, payload, digest, event_time, appended_at)
       VALUES ($1,$2,1,$3,$4,'placeholder',$5,$5)`,
      [sessionRef, seq, type, JSON.stringify({ content: `msg-${seq}` }), 1_700_000_000_000 + seq],
    )
  }
}

describe(`冷层归档 —— 对真 PG+MinIO（需 SESSION_LOG_TEST_DSN + OBJECT_STORE_TEST_ENDPOINT，当前${suffix}）`, () => {
  t('archive：按 maxItems 切成无缝段，返回段含键/sha/bytes/items', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-archive-boundary'
      // maxItems=2 → 段 [1-2],[3-4],[5-5]
      await seed(log, s, [1, 2, 3, 4, 5])

      const segs = await cold.archive(s)
      expect(segs).toHaveLength(3)
      expect(segs.map((g) => [g.startSeq, g.endSeq])).toEqual([[1, 2], [3, 4], [5, 5]])
      expect(segs[0]!.items).toBe(2)
      expect(segs[0]!.bytes).toBeGreaterThan(0)
      expect(segs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
      // 段对象与侧车都已落 MinIO
      const store = new MinioObjectStore(minioOptions())
      expect(await store.get(REALM, segmentRelativeKey(s, { startSeq: 1, endSeq: 2 }))).toBeDefined()
      expect(await store.get(REALM, segmentRelativeInfoKey(s, { startSeq: 3, endSeq: 4 }))).toBeDefined()
    })
  })

  t('幂等：同段区间重跑不重写对象、不新增归档行', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-idempotent'
      await seed(log, s, [1, 2, 3])

      const first = await cold.archive(s)
      expect(first).toHaveLength(2) // [1-2],[3-3]
      const second = await cold.archive(s)
      expect(second).toHaveLength(0) // 全被覆盖，无新段
      expect(await cold.list(s)).toHaveLength(2)
      // 对象没有多写：stat 仍能读到、且无 _copy 之类痕迹——这里断言字节与首轮一致即可
      const store = new MinioObjectStore(minioOptions())
      const body = await store.get(REALM, segmentRelativeKey(s, { startSeq: 1, endSeq: 2 }))
      expect(body?.body.toString('utf8')).toContain('msg-1')
      expect(body?.body.toString('utf8')).toContain('msg-2')
    })
  })

  t('增量：追加的事件只补新段，旧段不动', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-incremental'
      await seed(log, s, [1, 2]) // [1-2]
      await cold.archive(s)

      await seed(log, s, [3, 4, 5]) // 补 [3-4],[5-5]
      const inc = await cold.archive(s)
      expect(inc.map((g) => [g.startSeq, g.endSeq])).toEqual([[3, 4], [5, 5]])

      const all = await cold.list(s)
      expect(all.map((g) => [g.startSeq, g.endSeq])).toEqual([[1, 2], [3, 4], [5, 5]])
    })
  })

  t('fetch：读回段与真源一致（含序与 payload 保真）', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-fetch'
      await seed(log, s, [1, 2, 3])
      await cold.archive(s)

      const recs = await cold.fetch(s, { startSeq: 1, endSeq: 2 })
      expect(recs.map((r) => r.seq)).toEqual([1, 2])
      expect(recs[0]!.payload).toEqual({ content: 'msg-1' })
    })
  })

  t('完整性：段字节被改 → SegmentCorruptError（审计事故，不静默）', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-corrupt'
      await seed(log, s, [1, 2, 3])
      await cold.archive(s)

      const store = new MinioObjectStore(minioOptions())
      const rel = segmentRelativeKey(s, { startSeq: 1, endSeq: 2 })
      // 覆盖成另一段字节：内容变了、侧车没变 → 对拍必失败
      await store.put(REALM, rel, 'tampered', 'application/x-ndjson')

      await expect(cold.fetch(s, { startSeq: 1, endSeq: 2 }))
        .rejects.toBeInstanceOf(SegmentCorruptError)
    })
  })

  t('sweep：过期段删对象 + 清 PG 行；未过期保留', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-sweep'
      await seed(log, s, [1, 2, 3])
      const segs = await cold.archive(s)
      expect(segs).toHaveLength(2)

      const store = new MinioObjectStore(minioOptions())
      const keyOf1 = segmentRelativeKey(s, { startSeq: 1, endSeq: 2 })
      const infoOf2 = segmentRelativeInfoKey(s, { startSeq: 3, endSeq: 3 })
      // 把两段的归档时间拨到过期：保留期 60s，now 拨到过去会过期；用 24h 前
      await log.raw('UPDATE session_log_archive SET archived_at = archived_at - $1', [24 * 3600 * 1000])

      const swept = await cold.sweep(Date.now(), 3600 * 1000) // 保留 1h，24h 前的必过期
      expect(swept).toHaveLength(2)
      // 对象已删（.info/.jsonl 都读不到了）
      expect(await store.get(REALM, keyOf1)).toBeUndefined()
      expect(await store.get(REALM, infoOf2)).toBeUndefined()
      expect(await cold.list(s)).toEqual([])
    })
  })

  t('sweep：未过期段（冷档保留期内）不清理', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-keep'
      await seed(log, s, [1, 2, 3])
      await cold.archive(s)

      // 保留期内：now 就在归档即刻附近 → 全部 cold
      const swept = await cold.sweep(Date.now(), 3600 * 1000)
      expect(swept).toHaveLength(0)
      expect(await cold.list(s)).toHaveLength(2)
    })
  })
})