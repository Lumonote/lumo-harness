import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'

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
import { parseManagedContentKey } from '../../../shared/seam-contracts/managed-content.ts'

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
    await log.raw('TRUNCATE session_log, session_log_archive, session_log_archive_plans')
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

  t('稀疏大序号和中间退休段不扩展区间、不复活已有内容', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-sparse-retired'
      await seed(log, s, [1, 2, 3, 4, 5, 6, 1_000_000_000_001])
      for (const [start, end] of [[2, 2], [7, 1_000_000_000_000]]) {
        await log.raw(`INSERT INTO session_log_archive(session_ref,start_seq,end_seq,object_key,sha256,bytes,items,archived_at,retired_at)
          VALUES($1,$2,$3,$4,$5,1,1,1,2)`, [s,start,end,`${REALM}/session-log/${s}/${start}-${end}.jsonl`,'a'.repeat(64)])
      }
      const result = await cold.archive(s)
      expect(result.map(row => [row.startSeq,row.endSeq])).toEqual([[1,1],[3,4],[5,6],[1_000_000_000_001,1_000_000_000_001]])
      expect((await cold.fetch(s, { startSeq: 1, endSeq: 1 })).map(row => row.seq)).toEqual([1])
      expect(await cold.archive(s)).toEqual([])
    })
  })

  t('独立归档器采用不同段大小并发时仍只建立一份不重叠布局', async () => {
    await withArchiver(async (cold, log) => {
      const other = new PgColdLogArchiver({ connectionString: await schemaDsn(DSN!, 'session_log_cold_test'), realm: REALM, maxItems: 3 }, new MinioObjectStore(minioOptions()))
      try {
        await other.init()
        const s = 's-concurrent-layout'
        await seed(log, s, [1,2,3,4,5])
        const results = await Promise.all([cold.archive(s),other.archive(s)])
        expect(results.filter(rows => rows.length > 0)).toHaveLength(1)
        const all = await cold.list(s)
        expect(all.reduce((sum,row) => sum + row.items,0)).toBe(5)
        for (let i=1;i<all.length;i++) expect(all[i]!.startSeq).toBeGreaterThan(all[i-1]!.endSeq)
        const records = (await Promise.all(all.map(row => cold.fetch(s,row)))).flat()
        expect(records.map(row => row.seq)).toEqual([1,2,3,4,5])
      } finally { await other.close() }
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

  t('legacy对象和侧车已写但PG归档事务失败时，不把孤立对象当成已提交段读取',async()=>{
    await withArchiver(async(cold,log)=>{
      const session='s-uncommitted-sidecar',range={startSeq:1,endSeq:1}
      await seed(log,session,[1])
      await log.raw(`CREATE FUNCTION reject_legacy_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced legacy metadata failure'; END $$;CREATE TRIGGER reject_legacy_archive BEFORE INSERT ON session_log_archive FOR EACH ROW EXECUTE FUNCTION reject_legacy_archive()`)
      try{
        await expect(cold.archive(session)).rejects.toThrow('forced legacy metadata failure')
        const store=new MinioObjectStore(minioOptions())
        expect(await store.get(REALM,segmentRelativeKey(session,range))).toBeDefined()
        expect(await store.get(REALM,segmentRelativeInfoKey(session,range))).toBeDefined()
        expect(await cold.fetch(session,range)).toEqual([])
      }finally{await log.raw('DROP TRIGGER reject_legacy_archive ON session_log_archive;DROP FUNCTION reject_legacy_archive()')}
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

  t('完整性：已提交归档正文丢失时拒绝返回空历史', async () => {
    await withArchiver(async (cold, log) => {
      const session = 's-missing-committed-body', range = { startSeq: 1, endSeq: 2 }
      await seed(log, session, [1, 2])
      await cold.archive(session)
      const store = new MinioObjectStore(minioOptions())
      await store.delete(REALM, segmentRelativeKey(session, range))
      expect(await store.get(REALM, segmentRelativeInfoKey(session, range))).toBeDefined()
      expect(await cold.list(session)).toHaveLength(1)
      await expect(cold.fetch(session, range)).rejects.toBeInstanceOf(SegmentCorruptError)
    })
  })

  t('完整性：缺失或属于另一范围的侧车均拒绝读取', async () => {
    await withArchiver(async (cold, log) => {
      const s = 's-invalid-sidecar', range = { startSeq: 1, endSeq: 2 }
      await seed(log,s,[1,2]); await cold.archive(s)
      const store = new MinioObjectStore(minioOptions()), key = segmentRelativeInfoKey(s,range)
      const original = await store.get(REALM,key)
      await store.delete(REALM,key)
      await expect(cold.fetch(s,range)).rejects.toBeInstanceOf(SegmentCorruptError)
      await store.put(REALM,key,JSON.stringify({...JSON.parse(original!.body.toString('utf8')),endSeq:3}),'application/json')
      await expect(cold.fetch(s,range)).rejects.toBeInstanceOf(SegmentCorruptError)
      await store.put(REALM,key,'null','application/json')
      await expect(cold.fetch(s,range)).rejects.toBeInstanceOf(SegmentCorruptError)
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
      expect(await cold.archive(s)).toEqual([])
      expect(await cold.fetch(s, { startSeq: 1, endSeq: 2 })).toEqual([])
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

describe('托管冷日志引用与物理回收', () => {
  t('同事务 pin、重启读取、退役 release、显式 GC 与防复活', async () => {
    const realm = uniqueRealm()
    const dsn = await schemaDsn(DSN!, `session_log_cold_managed_${randomBytes(6).toString('hex')}`)
    const log = new PgSessionLog(dsn)
    const store = new MinioObjectStore({ ...minioOptions(), managedContent: { connectionString: dsn, storageId: 'cold-test', retentionMs: 0, graceMs: 0, deleteEnabled: true } })
    const cold = new PgColdLogArchiver({ connectionString: dsn, realm, maxItems: 2 }, store)
    const reopened = new PgColdLogArchiver({ connectionString: dsn, realm, maxItems: 2 }, store)
    const otherRealm = new PgColdLogArchiver({ connectionString: dsn, realm: uniqueRealm() }, store)
    try {
      await log.init(); await store.init(); await store.managedContent!.init(); await cold.init(); await reopened.init(); await otherRealm.init()
      await seed(log, 'managed-session', [1, 2, 3])
      const segments = await cold.archive('managed-session')
      expect(segments).toHaveLength(2)
      const key = parseManagedContentKey(realm, segments[0]!.objectKey)!
      expect(key).toBeDefined()
      expect((await log.raw(`SELECT count(*)::int n FROM managed_content_references WHERE kind='cold-log-segment' AND released_at IS NULL`))[0].n).toBe(2)
      expect(await store.managedContent!.collect(realm)).toMatchObject({ candidates: 0, deleted: 0 })
      expect((await reopened.fetch('managed-session', { startSeq: 1, endSeq: 2 })).map(row => row.seq)).toEqual([1, 2])
      expect(await otherRealm.list()).toEqual([])
      await expect(otherRealm.fetch('managed-session', { startSeq: 1, endSeq: 2 })).rejects.toThrow('identity')
      expect(await reopened.archive('managed-session')).toEqual([])
      expect(await cold.sweep(Date.now(), 0)).toHaveLength(2)
      expect(await cold.list()).toEqual([])
      expect(await reopened.archive('managed-session')).toEqual([])
      expect(await reopened.fetch('managed-session', { startSeq: 1, endSeq: 2 })).toEqual([])
      // Retirement is metadata-only. The managed collector performs the actual
      // physical delete after its own durable fence and retention policy.
      expect(await store.get(realm, key.relativeKey)).toBeDefined()
      expect(await store.managedContent!.collect(realm)).toMatchObject({ candidates: 2, deleted: 2, failed: 0 })
      expect(await store.get(realm, key.relativeKey)).toBeUndefined()
      await seed(log, 'managed-session', [4, 5])
      expect((await cold.archive('managed-session')).map(item => [item.startSeq,item.endSeq])).toEqual([[4,5]])
    } finally { await otherRealm.close(); await reopened.close(); await cold.close(); await log.close(); await store.managedContent!.close() }
  })
  t('元数据失败后追加事件、更换段大小并重开归档器，先恢复冻结计划且不遗留孤立保留对象', async () => {
    const realm = uniqueRealm()
    const dsn = await schemaDsn(DSN!, `session_log_cold_failure_${randomBytes(6).toString('hex')}`)
    const log = new PgSessionLog(dsn)
    const store = new MinioObjectStore({ ...minioOptions(), managedContent: { connectionString: dsn, storageId: 'cold-failure-test', retentionMs: 0, graceMs: 0, deleteEnabled: true } })
    let cold = new PgColdLogArchiver({ connectionString: dsn, realm }, store)
    try {
      await log.init(); await store.init(); await store.managedContent!.init(); await cold.init()
      await seed(log, 'failure-session', [1,2])
      await log.raw(`CREATE FUNCTION reject_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced metadata failure'; END $$;
        CREATE TRIGGER reject_archive BEFORE INSERT ON session_log_archive FOR EACH ROW EXECUTE FUNCTION reject_archive()`)
      await expect(cold.archive('failure-session')).rejects.toThrow('forced metadata failure')
      expect((await log.raw('SELECT count(*)::int n FROM session_log_archive'))[0].n).toBe(0)
      expect((await log.raw('SELECT count(*)::int n FROM managed_content_objects WHERE reservation_active=true'))[0].n).toBe(1)
      const original=(await log.raw('SELECT object_key FROM managed_content_objects'))[0].object_key
      expect((await log.raw('SELECT start_seq::int, end_seq::int FROM session_log_archive_plans'))).toEqual([{start_seq:1,end_seq:2}])
      expect(await store.managedContent!.collect(realm)).toMatchObject({ candidates: 0 })
      await seed(log,'failure-session',[3,4])
      await log.raw('DROP TRIGGER reject_archive ON session_log_archive')
      await cold.close()
      cold=new PgColdLogArchiver({connectionString:dsn,realm,maxItems:1},store);await cold.init()
      const resumed=await cold.archive('failure-session')
      expect(resumed.map(row=>[row.startSeq,row.endSeq])).toEqual([[1,2],[3,3],[4,4]])
      expect(resumed[0]!.objectKey).toBe(original)
      expect((await log.raw('SELECT count(*)::int n FROM managed_content_objects'))[0].n).toBe(3)
      expect((await log.raw('SELECT count(*)::int n FROM managed_content_objects WHERE reservation_active=true'))[0].n).toBe(0)
      expect((await log.raw('SELECT count(*)::int n FROM managed_content_references WHERE released_at IS NULL'))[0].n).toBe(3)
      expect(await cold.archive('failure-session')).toEqual([])
    } finally { await cold.close(); await log.close(); await store.managedContent!.close() }
  })
  t('冻结计划的源事件被篡改时拒绝恢复，也不另建上传身份',async()=>{
    const realm=uniqueRealm(),dsn=await schemaDsn(DSN!,`session_log_cold_plan_tamper_${randomBytes(6).toString('hex')}`)
    const log=new PgSessionLog(dsn),store=new MinioObjectStore({...minioOptions(),managedContent:{connectionString:dsn,storageId:'cold-plan-tamper',retentionMs:0,graceMs:0,deleteEnabled:true}})
    const cold=new PgColdLogArchiver({connectionString:dsn,realm},store)
    try{
      await log.init();await store.init();await store.managedContent!.init();await cold.init();await seed(log,'tamper-session',[1])
      await log.raw(`CREATE FUNCTION reject_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced metadata failure'; END $$;CREATE TRIGGER reject_archive BEFORE INSERT ON session_log_archive FOR EACH ROW EXECUTE FUNCTION reject_archive()`)
      await expect(cold.archive('tamper-session')).rejects.toThrow('forced metadata failure')
      await log.raw(`DROP TRIGGER reject_archive ON session_log_archive;UPDATE session_log SET payload='{"changed":true}' WHERE session_ref='tamper-session'`)
      await seed(log,'tamper-session',[2])
      await expect(cold.archive('tamper-session')).rejects.toThrow('immutable PostgreSQL bytes')
      expect((await log.raw('SELECT count(*)::int n FROM managed_content_objects'))[0].n).toBe(1)
      expect((await log.raw('SELECT count(*)::int n FROM session_log_archive'))[0].n).toBe(0)
    }finally{await cold.close();await log.close();await store.managedContent!.close()}
  })
})
