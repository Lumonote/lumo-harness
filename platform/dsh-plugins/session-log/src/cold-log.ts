/**
 * SessionEvent 日志冷层的 PG 真相源读取 + MinIO 段归档（§4.2 冷转）。
 *
 * 定位：复制式日志主体（写路径 + fencing）已在 `pg-log.ts` 落地；本文件做**冷转**——
 * 把已提交的 PG 日志按 segment 归档进 MinIO（经 `ctx.objectStore`），并做保留期过期清理。
 *
 * 三条刻意的取舍：
 *
 * **① 只读 PG、只写 MinIO，不占写者租约。** 冷层是归档副本，不是第二个写入口、不是
 * 真相源（`session-log.ts` 契约已锁）。它是在已提交数据上的后台聚合，无需也不许进入
 * 写路径的 fencing 协议。
 *
 * **② 有界归档与幂等**：同一会话按 PG advisory lock 串行切段，每页最多 1000 条。
 * 不枚举 seq 区间，也不重新读取全部历史；退役范围继续屏蔽，缺口不会跨越已有段。
 * 托管段使用确定性 reservation，旧段继续兼容 `.info` 侧车协议。
 *
 * **③ 完整性靠 `.info` 侧车 + 读回首验**：段对象以 sha256+bytes 为凭据，`fetch` 回读时
 * 对拍，字节被改即 `SegmentCorruptError`（弄错内容是审计事故，不是功能 bug）。
 */
import pg from 'pg'
import { createHash } from 'node:crypto'
import { pinManagedContent, releaseManagedContent } from '../../../shared/managed-content.ts'
import { isManagedContentKey, parseManagedContentKey } from '../../../shared/seam-contracts/managed-content.ts'

import {
  type ArchivedSegment,
  type ColdLogSeam,
  type SegmentMeta,
  SegmentCorruptError,
  parseSegment,
  retentionOf,
  segmentObjectKey,
  segmentRelativeInfoKey,
  segmentRelativeKey,
  serializeSegment,
  sha256Of,
} from '../../../shared/seam-contracts/cold-log.ts'
import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'

/** 归档推进记录表：让下次扫描只处理未归档段 + 保留期过期的依据。 */
export const ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS session_log_archive (
  session_ref  TEXT   NOT NULL,
  start_seq    BIGINT NOT NULL,
  end_seq      BIGINT NOT NULL,
  object_key   TEXT   NOT NULL,
  sha256       TEXT   NOT NULL,
  bytes        BIGINT NOT NULL,
  items        BIGINT NOT NULL,
  archived_at  BIGINT NOT NULL,
  retired_at   BIGINT,
  PRIMARY KEY (session_ref, start_seq, end_seq)
);
ALTER TABLE session_log_archive ADD COLUMN IF NOT EXISTS retired_at BIGINT;
CREATE TABLE IF NOT EXISTS session_log_archive_plans (
  session_ref TEXT NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  realm TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  bytes BIGINT NOT NULL CHECK(bytes > 0),
  items INTEGER NOT NULL CHECK(items BETWEEN 1 AND 1000),
  planned_at BIGINT NOT NULL,
  PRIMARY KEY(session_ref,start_seq,end_seq),
  CHECK(start_seq >= 0 AND end_seq >= start_seq)
);
`

function segmentReference(sessionRef: string, range: { startSeq: number; endSeq: number }): string {
  return createHash('sha256').update(JSON.stringify([sessionRef, range.startSeq, range.endSeq])).digest('hex')
}

export interface ColdLogOptions {
  connectionString: string
  /** 归档归属 realm（对象键第一段；身份语义，与 object-store 给定值应一致） */
  realm: string
  /** 每段最大事件数；默认取契约 MAX_SEGMENT_ITEMS */
  maxItems?: number
}

export class PgColdLogArchiver implements ColdLogSeam {
  private pool: pg.Pool
  private objectStore: ObjectStoreSeam
  private realm: string
  private maxItems: number

  constructor(options: ColdLogOptions, objectStore: ObjectStoreSeam) {
    this.pool = new pg.Pool({ connectionString: options.connectionString, max: 4,
      connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 })
    this.objectStore = objectStore
    this.realm = options.realm
    this.maxItems = options.maxItems ?? 1_000
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > 1_000) throw new RangeError('Archive maxItems must be an integer in 1..1000')
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lumo.session-log.archive.schema.v1'))")
      await client.query(ARCHIVE_DDL)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** Read one bounded page and never span an existing (including retired) range. */
  private async readPage(client: pg.PoolClient, sessionRef: string, after: number, through: number): Promise<LogRecord[]> {
    const res = await client.query<{ seq: string; event_type: string; payload: string; event_time: string }>(
      `SELECT l.seq,l.event_type,l.payload,l.event_time FROM session_log l
       WHERE l.session_ref=$1 AND l.seq>$2 AND l.seq<=$3
       AND NOT EXISTS(SELECT 1 FROM session_log_archive a WHERE a.session_ref=l.session_ref AND l.seq BETWEEN a.start_seq AND a.end_seq)
       ORDER BY l.seq LIMIT $4`, [sessionRef,after,through,this.maxItems])
    if (!res.rows.length) return []
    const boundary = (await client.query<{ next_start: string | null }>(
      `SELECT min(start_seq) next_start FROM session_log_archive WHERE session_ref=$1 AND start_seq>$2`, [sessionRef,res.rows[0]!.seq])).rows[0]?.next_start
    return res.rows.filter(row => boundary === null || boundary === undefined || Number(row.seq) < Number(boundary))
      .map(row => ({ sessionRef,seq:Number(row.seq),type:row.event_type,payload:JSON.parse(row.payload) as unknown,time:Number(row.event_time) }))
  }

  async archive(sessionRef: string): Promise<ArchivedSegment[]> {
    segmentObjectKey(this.realm, sessionRef, { startSeq: 1, endSeq: 1 })
    const client = await this.pool.connect()
    let locked = false
    let connectionError: Error | undefined
    try {
      // This lock serializes archive layout only; it never grants a Session writer lease.
      // Keep a single connection for the lock, bounded reads and metadata transactions.
      const claim = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) acquired`, ['lumo.cold-archive/' + sessionRef])
      locked = claim.rows[0]?.acquired === true
      if (!locked) return []
      const written: ArchivedSegment[] = []
      // A successful object write may precede a failed metadata commit. Resume
      // its durable range before considering new appends or a changed page size.
      // Never abandon/reallocate a deterministic reservation after ambiguous IO.
      for (;;) {
        const plan = (await client.query<{ start_seq:string;end_seq:string;realm:string;sha256:string;bytes:string;items:number }>(
          `SELECT p.start_seq,p.end_seq,p.realm,p.sha256,p.bytes,p.items FROM session_log_archive_plans p
           WHERE p.session_ref=$1 AND NOT EXISTS(SELECT 1 FROM session_log_archive a
             WHERE a.session_ref=p.session_ref AND a.start_seq=p.start_seq AND a.end_seq=p.end_seq)
           ORDER BY p.start_seq LIMIT 1`, [sessionRef])).rows[0]
        if (!plan) break
        const range = {startSeq:Number(plan.start_seq),endSeq:Number(plan.end_seq)}
        if (plan.realm!==this.realm || !Number.isSafeInteger(range.startSeq) || !Number.isSafeInteger(range.endSeq)
          || !Number.isSafeInteger(plan.items) || plan.items<1 || plan.items>1000 || !this.objectStore.managedContent) throw new Error('Pending archive plan requires its original realm and managed store')
        const rows = (await client.query<{seq:string;event_type:string;payload:string;event_time:string}>(
          `SELECT seq,event_type,payload,event_time FROM session_log WHERE session_ref=$1 AND seq BETWEEN $2 AND $3 ORDER BY seq LIMIT $4`,
          [sessionRef,range.startSeq,range.endSeq,plan.items+1])).rows
        const records = rows.map(row=>({sessionRef,seq:Number(row.seq),type:row.event_type,payload:JSON.parse(row.payload) as unknown,time:Number(row.event_time)}))
        const bytes = serializeSegment(records)
        if (records.length!==plan.items || records[0]?.seq!==range.startSeq || records.at(-1)?.seq!==range.endSeq
          || bytes.byteLength!==Number(plan.bytes) || sha256Of(bytes)!==plan.sha256) throw new Error('Pending archive plan differs from its immutable PostgreSQL bytes')
        const segment=await this.archiveRange(client,sessionRef,range,records)
        if(segment)written.push(segment)
      }
      const upper = (await client.query<{ end_seq: string | null }>(`SELECT max(seq) end_seq FROM session_log WHERE session_ref=$1`, [sessionRef])).rows[0]?.end_seq
      if (upper === null || upper === undefined) return written
      const through = Number(upper)
      if (!Number.isSafeInteger(through) || through < 0) throw new Error('Archive sequence exceeds the supported range')
      let after = -1
      for (;;) {
        const records = await this.readPage(client, sessionRef, after, through)
        if (!records.length) break
        const range = { startSeq: records[0]!.seq, endSeq: records.at(-1)!.seq }
        const segment = await this.archiveRange(client, sessionRef, range, records)
        if (segment) written.push(segment)
        after = range.endSeq
      }
      return written
    } catch (error) {
      connectionError = error instanceof Error ? error : new Error('Archive operation failed')
      throw error
    } finally {
      if (locked) {
        try { await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, ['lumo.cold-archive/' + sessionRef]) }
        catch (error) { connectionError = error instanceof Error ? error : new Error('Archive lock cleanup failed') }
      }
      // A connection with an unconfirmed session lock must never return to the pool.
      client.release(connectionError)
    }
  }

  private async archiveRange(client: pg.PoolClient, sessionRef: string, range: { startSeq: number; endSeq: number }, records: LogRecord[]): Promise<ArchivedSegment | undefined> {
      const buf = serializeSegment(records)
      const relKey = segmentRelativeKey(sessionRef, range)

      // 幂等：`.info` 侧车已在 → 已归档（同键同内容，跳过重写），但仍确保推进行在 PG。
      const infoRel = segmentRelativeInfoKey(sessionRef, range)
      const meta: SegmentMeta = {
        sessionRef,
        startSeq: range.startSeq,
        endSeq: range.endSeq,
        sha256: sha256Of(buf),
        bytes: buf.byteLength,
        items: records.length,
        archivedAt: Date.now(),
      }
      if (this.objectStore.managedContent) {
        // Plan independently commits before the external upload. A later page
        // cannot silently replace this range while its reservation remains live.
        await client.query(`INSERT INTO session_log_archive_plans(session_ref,start_seq,end_seq,realm,sha256,bytes,items,planned_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_ref,start_seq,end_seq) DO NOTHING`,
          [sessionRef,range.startSeq,range.endSeq,this.realm,meta.sha256,meta.bytes,meta.items,meta.archivedAt])
        const plan=(await client.query(`SELECT realm,sha256,bytes,items FROM session_log_archive_plans WHERE session_ref=$1 AND start_seq=$2 AND end_seq=$3`,[sessionRef,range.startSeq,range.endSeq])).rows[0]
        if(!plan || plan.realm!==this.realm || plan.sha256!==meta.sha256 || Number(plan.bytes)!==meta.bytes || Number(plan.items)!==meta.items)throw new Error('Archive plan identity differs from its immutable segment')
        const reference = { realm: this.realm, kind: 'cold-log-segment' as const, referenceId: segmentReference(sessionRef, range) }
        const receipt = await this.objectStore.managedContent.put(reference, buf, 'application/x-ndjson')
        const tx = client
        try {
          await tx.query('BEGIN')
          const inserted = await tx.query(`INSERT INTO session_log_archive(session_ref,start_seq,end_seq,object_key,sha256,bytes,items,archived_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_ref,start_seq,end_seq)DO NOTHING RETURNING session_ref`,
          [sessionRef, range.startSeq, range.endSeq, receipt.objectKey, meta.sha256, meta.bytes, meta.items, meta.archivedAt])
          const current = (await tx.query(`SELECT object_key,sha256,bytes,items,retired_at FROM session_log_archive WHERE session_ref=$1 AND start_seq=$2 AND end_seq=$3 FOR UPDATE`, [sessionRef,range.startSeq,range.endSeq])).rows[0]
          if (!current || current.retired_at !== null || current.object_key !== receipt.objectKey || current.sha256 !== meta.sha256 || Number(current.bytes) !== meta.bytes || Number(current.items) !== meta.items) throw new Error('Archive identity is retired or differs from its immutable segment')
          await pinManagedContent(tx, { ...reference, objectKey: receipt.objectKey, sha256: meta.sha256, byteSize: meta.bytes })
          await tx.query('COMMIT')
          return inserted.rowCount ? { ...meta, objectKey: receipt.objectKey } : undefined
        } catch (error) {
          await tx.query('ROLLBACK')
          // The deterministic reservation remains protected. The next scan
          // retries only the metadata transaction against the same ready bytes;
          // collecting it here would make that stable identity unrecoverable.
          throw error
        }
      }
      const existing = await this.objectStore.stat(this.realm, infoRel)
      const archivedAt = existing ? await this.archivedAtOf(client, sessionRef, range) ?? meta.archivedAt : meta.archivedAt

      if (!existing) {
        await this.objectStore.put(this.realm, relKey, buf, 'application/x-ndjson')
        await this.objectStore.put(this.realm, infoRel, JSON.stringify(meta), 'application/json')
      }

      // 推进水位（ON CONFLICT DO NOTHING：幂等，不起覆盖竞争）
      await client.query(
        `INSERT INTO session_log_archive
           (session_ref, start_seq, end_seq, object_key, sha256, bytes, items, archived_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (session_ref, start_seq, end_seq) DO NOTHING`,
        [sessionRef, range.startSeq, range.endSeq,
         segmentObjectKey(this.realm, sessionRef, range),
         meta.sha256, meta.bytes, meta.items, archivedAt],
      )
      return {
        sessionRef,
        startSeq: range.startSeq,
        endSeq: range.endSeq,
        objectKey: segmentObjectKey(this.realm, sessionRef, range),
        sha256: meta.sha256,
        bytes: meta.bytes,
        items: meta.items,
        archivedAt,
      }
  }

  private async archivedAtOf(client: pg.PoolClient, sessionRef: string, range: { startSeq: number; endSeq: number }): Promise<number | undefined> {
    const res = await client.query<{ archived_at: string }>(
      `SELECT archived_at FROM session_log_archive
       WHERE session_ref = $1 AND start_seq = $2 AND end_seq = $3`,
      [sessionRef, range.startSeq, range.endSeq],
    )
    const row = res.rows[0]
    return row ? Number(row.archived_at) : undefined
  }

  async list(sessionRef?: string): Promise<ArchivedSegment[]> {
    const params = sessionRef === undefined ? [`${this.realm}/`] : [`${this.realm}/`, sessionRef]
    const where = `WHERE retired_at IS NULL AND left(object_key,length($1))=$1${sessionRef === undefined ? '' : ' AND session_ref=$2'}`
    const res = await this.pool.query<{
      session_ref: string; start_seq: string; end_seq: string; object_key: string
      sha256: string; bytes: string; items: string; archived_at: string
    }>(`SELECT session_ref, start_seq, end_seq, object_key, sha256, bytes, items, archived_at
        FROM session_log_archive ${where} ORDER BY session_ref, start_seq`, params)
    return res.rows.map((r) => ({
      sessionRef: r.session_ref,
      startSeq: Number(r.start_seq),
      endSeq: Number(r.end_seq),
      objectKey: r.object_key,
      sha256: r.sha256,
      bytes: Number(r.bytes),
      items: Number(r.items),
      archivedAt: Number(r.archived_at),
    }))
  }

  /**
   * 过期退役：托管段释放引用，旧段删除对象；均保留 PG 墓碑防止重新归档。
   * 返回被清理的段。
   */
  async sweep(now: number, coldRetentionMs: number): Promise<ArchivedSegment[]> {
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Archive sweep requires a valid millisecond timestamp')
    retentionOf(0, now, coldRetentionMs)
    const all = await this.list()
    const swept: ArchivedSegment[] = []
    for (const seg of all) {
      if (retentionOf(seg.archivedAt, now, coldRetentionMs) !== 'expired') continue
      const range = { startSeq: seg.startSeq, endSeq: seg.endSeq }
      if (isManagedContentKey(seg.objectKey)) {
        const parsed = parseManagedContentKey(this.realm, seg.objectKey)
        if (!parsed || parsed.sha256 !== seg.sha256) throw new Error('Invalid managed archive identity')
        const tx = await this.pool.connect()
        try {
          await tx.query('BEGIN')
          const current = (await tx.query(`SELECT object_key,archived_at,retired_at FROM session_log_archive WHERE session_ref=$1 AND start_seq=$2 AND end_seq=$3 FOR UPDATE`, [seg.sessionRef,range.startSeq,range.endSeq])).rows[0]
          if (current?.retired_at === null && current.object_key === seg.objectKey && retentionOf(Number(current.archived_at), now, coldRetentionMs) === 'expired') {
            await releaseManagedContent(tx, { realm: this.realm, kind: 'cold-log-segment', referenceId: segmentReference(seg.sessionRef, range), objectKey: seg.objectKey })
            await tx.query(`UPDATE session_log_archive SET retired_at=$4 WHERE session_ref=$1 AND start_seq=$2 AND end_seq=$3`, [seg.sessionRef,range.startSeq,range.endSeq,now])
            swept.push(seg)
          }
          await tx.query('COMMIT')
        } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
        continue
      }
      await this.objectStore.delete(this.realm, segmentRelativeKey(seg.sessionRef, range))
      await this.objectStore.delete(this.realm, segmentRelativeInfoKey(seg.sessionRef, range))
      await this.pool.query(
        `UPDATE session_log_archive SET retired_at=$4
         WHERE session_ref = $1 AND start_seq = $2 AND end_seq = $3`,
        [seg.sessionRef, seg.startSeq, seg.endSeq, now],
      )
      swept.push(seg)
    }
    return swept
  }

  /** 读回段原始字节 + 侧车对拍（供 resume 前把冷档装回 / 调试对拍用）。 */
  async fetch(sessionRef: string, range: { startSeq: number; endSeq: number }): Promise<LogRecord[]> {
    const stored = (await this.pool.query(`SELECT object_key,sha256,bytes,items,archived_at,retired_at FROM session_log_archive WHERE session_ref=$1 AND start_seq=$2 AND end_seq=$3`, [sessionRef,range.startSeq,range.endSeq])).rows[0]
    segmentObjectKey(this.realm, sessionRef, range)
    // Uncommitted legacy objects/sidecars are not an authoritative archive.
    if (!stored) return []
    if (stored && !stored.object_key.startsWith(this.realm + '/')) throw new Error('Invalid archive realm identity')
    if (stored?.retired_at !== null && stored?.retired_at !== undefined) return []
    if (stored && isManagedContentKey(stored.object_key)) {
      const parsed = parseManagedContentKey(this.realm, stored.object_key)
      if (!parsed || parsed.sha256 !== stored.sha256) throw new Error('Invalid managed archive identity')
      const body = await this.objectStore.get(this.realm, parsed.relativeKey)
      if (!body) throw new Error('Pinned archive object is unavailable')
      return parseSegment(sessionRef, body.body, { sessionRef, ...range, sha256: stored.sha256, bytes: Number(stored.bytes), items: Number(stored.items), archivedAt: Number(stored.archived_at) })
    }
    const relKey = segmentRelativeKey(sessionRef, range)
    const infoRel = segmentRelativeInfoKey(sessionRef, range)
    const [body, info] = await Promise.all([
      this.objectStore.get(this.realm, relKey),
      this.objectStore.get(this.realm, infoRel),
    ])
    if (!body) throw new SegmentCorruptError(sessionRef, '已提交的归档正文缺失')
    if (!info) throw new SegmentCorruptError(sessionRef, '归档侧车缺失')
    let meta: SegmentMeta
    try { meta = JSON.parse(info.body.toString('utf8')) as SegmentMeta }
    catch { throw new SegmentCorruptError(sessionRef, '归档侧车非合法 JSON') }
    if (!meta || meta.sessionRef !== sessionRef || meta.startSeq !== range.startSeq || meta.endSeq !== range.endSeq
      || typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(meta.sha256) || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1
      || !Number.isSafeInteger(meta.items) || meta.items < 1 || !Number.isSafeInteger(meta.archivedAt) || meta.archivedAt < 0
      || stored && (stored.object_key !== segmentObjectKey(this.realm, sessionRef, range) || stored.sha256 !== meta.sha256 || Number(stored.bytes) !== meta.bytes || Number(stored.items) !== meta.items)) {
      throw new SegmentCorruptError(sessionRef, '归档侧车与持久元数据不符')
    }
    return parseSegment(sessionRef, body.body, meta)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
