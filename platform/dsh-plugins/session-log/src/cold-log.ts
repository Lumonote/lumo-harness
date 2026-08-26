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
 * **② 幂等靠「段键由 (session, 段区间) 派生 + 侧车确定性」**：同一段区间重跑产生的
 * 字节与键必同，`.info` 已存在即视为已归档（stat 跳过，不重复写）。意外产生的孤儿对象
 * 内容寻址同键，下次归档自然复用，不会产生漂移。
 *
 * **③ 完整性靠 `.info` 侧车 + 读回首验**：段对象以 sha256+bytes 为凭据，`fetch` 回读时
 * 对拍，字节被改即 `SegmentCorruptError`（弄错内容是审计事故，不是功能 bug）。
 */
import pg from 'pg'

import {
  type ArchivedSegment,
  type ColdLogSeam,
  type SegmentMeta,
  parseSegment,
  retentionOf,
  segmentObjectKey,
  segmentRelativeInfoKey,
  segmentRelativeKey,
  segmentRanges,
  serializeSegment,
  sha256Of,
} from '../../../shared/seam-contracts/cold-log.ts'
import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'

/** 归档推进记录表：让下次扫描只处理未归档段 + 保留期过期的依据。 */
const ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS session_log_archive (
  session_ref  TEXT   NOT NULL,
  start_seq    BIGINT NOT NULL,
  end_seq      BIGINT NOT NULL,
  object_key   TEXT   NOT NULL,
  sha256       TEXT   NOT NULL,
  bytes        BIGINT NOT NULL,
  items        BIGINT NOT NULL,
  archived_at  BIGINT NOT NULL,
  PRIMARY KEY (session_ref, start_seq, end_seq)
);
`

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
    this.pool = new pg.Pool({ connectionString: options.connectionString })
    this.objectStore = objectStore
    this.realm = options.realm
    this.maxItems = options.maxItems ?? 1_000
  }

  async init(): Promise<void> {
    await this.pool.query(ARCHIVE_DDL)
  }

  /** 只读真源，按 seq 有序。 */
  private async readEvents(sessionRef: string): Promise<LogRecord[]> {
    const res = await this.pool.query<{
      seq: string; event_type: string; payload: string; event_time: string
    }>(
      `SELECT seq, event_type, payload, event_time FROM session_log
       WHERE session_ref = $1 ORDER BY seq`,
      [sessionRef],
    )
    return res.rows.map((r) => ({
      sessionRef,
      seq: Number(r.seq),
      type: r.event_type,
      payload: JSON.parse(r.payload) as unknown,
      time: Number(r.event_time),
    }))
  }

  private async archivedRanges(sessionRef: string): Promise<Array<{ startSeq: number; endSeq: number }>> {
    const res = await this.pool.query<{ start_seq: string; end_seq: string }>(
      `SELECT start_seq, end_seq FROM session_log_archive WHERE session_ref = $1`,
      [sessionRef],
    )
    return res.rows.map((r) => ({ startSeq: Number(r.start_seq), endSeq: Number(r.end_seq) }))
  }

  async archive(sessionRef: string): Promise<ArchivedSegment[]> {
    const events = await this.readEvents(sessionRef)
    if (events.length === 0) return []

    // 已归档 seq 覆盖集 → 未归档事件 = 真源的补集（append-only 下通常是尾部一段，
    // 这样处理也对中间缺档健壮）
    const covered = new Set<number>()
    for (const { startSeq, endSeq } of await this.archivedRanges(sessionRef)) {
      for (let s = startSeq; s <= endSeq; s++) covered.add(s)
    }
    const unarchived = events.filter((e) => !covered.has(e.seq))
    if (unarchived.length === 0) return []

    const seqs = unarchived.map((e) => e.seq)
    const ranges = segmentRanges(seqs, this.maxItems)
    const written: ArchivedSegment[] = []

    for (const range of ranges) {
      const records = events
        .filter((e) => e.seq >= range.startSeq && e.seq <= range.endSeq)
        .sort((a, b) => a.seq - b.seq)
      const buf = serializeSegment(records)
      const relKey = segmentRelativeKey(sessionRef, range)

      // 幂等：`.info` 侧车已在 → 已归档（同键同内容，跳过重写），但仍确保推进行在 PG。
      const infoRel = segmentRelativeInfoKey(sessionRef, range)
      const existing = await this.objectStore.stat(this.realm, infoRel)
      const meta: SegmentMeta = {
        sessionRef,
        startSeq: range.startSeq,
        endSeq: range.endSeq,
        sha256: sha256Of(buf),
        bytes: buf.byteLength,
        items: records.length,
        archivedAt: Date.now(),
      }
      const archivedAt = existing ? await this.archivedAtOf(sessionRef, range) ?? meta.archivedAt : meta.archivedAt

      if (!existing) {
        await this.objectStore.put(this.realm, relKey, buf, 'application/x-ndjson')
        await this.objectStore.put(this.realm, infoRel, JSON.stringify(meta), 'application/json')
      }

      // 推进水位（ON CONFLICT DO NOTHING：幂等，不起覆盖竞争）
      await this.pool.query(
        `INSERT INTO session_log_archive
           (session_ref, start_seq, end_seq, object_key, sha256, bytes, items, archived_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (session_ref, start_seq, end_seq) DO NOTHING`,
        [sessionRef, range.startSeq, range.endSeq,
         segmentObjectKey(this.realm, sessionRef, range),
         meta.sha256, meta.bytes, meta.items, archivedAt],
      )
      written.push({
        sessionRef,
        startSeq: range.startSeq,
        endSeq: range.endSeq,
        objectKey: segmentObjectKey(this.realm, sessionRef, range),
        sha256: meta.sha256,
        bytes: meta.bytes,
        items: meta.items,
        archivedAt,
      })
    }
    return written
  }

  private async archivedAtOf(sessionRef: string, range: { startSeq: number; endSeq: number }): Promise<number | undefined> {
    const res = await this.pool.query<{ archived_at: string }>(
      `SELECT archived_at FROM session_log_archive
       WHERE session_ref = $1 AND start_seq = $2 AND end_seq = $3`,
      [sessionRef, range.startSeq, range.endSeq],
    )
    const row = res.rows[0]
    return row ? Number(row.archived_at) : undefined
  }

  async list(sessionRef?: string): Promise<ArchivedSegment[]> {
    const params = sessionRef === undefined ? [] : [sessionRef]
    const where = sessionRef === undefined ? '' : 'WHERE session_ref = $1'
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
   * 过期清理：超过保留期的段从 MinIO 删对象（.jsonl+.info）+ 清 PG 推进行。
   * 返回被清理的段。
   */
  async sweep(now: number, coldRetentionMs: number): Promise<ArchivedSegment[]> {
    const all = await this.list()
    const swept: ArchivedSegment[] = []
    for (const seg of all) {
      if (retentionOf(seg.archivedAt, now, coldRetentionMs) !== 'expired') continue
      const range = { startSeq: seg.startSeq, endSeq: seg.endSeq }
      await this.objectStore.delete(this.realm, segmentRelativeKey(seg.sessionRef, range))
      await this.objectStore.delete(this.realm, segmentRelativeInfoKey(seg.sessionRef, range))
      await this.pool.query(
        `DELETE FROM session_log_archive
         WHERE session_ref = $1 AND start_seq = $2 AND end_seq = $3`,
        [seg.sessionRef, seg.startSeq, seg.endSeq],
      )
      swept.push(seg)
    }
    return swept
  }

  /** 读回段原始字节 + 侧车对拍（供 resume 前把冷档装回 / 调试对拍用）。 */
  async fetch(sessionRef: string, range: { startSeq: number; endSeq: number }): Promise<LogRecord[]> {
    const relKey = segmentRelativeKey(sessionRef, range)
    const infoRel = segmentRelativeInfoKey(sessionRef, range)
    const [body, info] = await Promise.all([
      this.objectStore.get(this.realm, relKey),
      this.objectStore.get(this.realm, infoRel),
    ])
    if (!body) return []
    const meta = info ? JSON.parse(info.body.toString('utf8')) as SegmentMeta : undefined
    return parseSegment(sessionRef, body.body, meta)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}