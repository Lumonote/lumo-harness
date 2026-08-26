/**
 * SessionEvent 日志冷层契约（§4.2：热 Redis → 冷转 MinIO，保留期分级过期）。
 *
 * 定位（seam 远程形态设计 2026-08-26 §1 第 2/3 行 + architecture §4.2 镜头）：
 * 复制式日志的**真相源是 PG**（`session-log.ts` 已锁）；Redis 只读热缓存；
 * Doris/MinIO 冷归档。本文件契约锁**冷转 MinIO 段**的键/序列化/保留期（纯函数，
 * 两侧可测）；归档 IO 语义（幂等、完整侧车、fail closed）由 archiver 颗粒测试承担。
 *
 * 核心不变量：
 * - 段 = 某会话在 `[startSeq, endSeq]` 上的事件组，按 seq 有序、无缝、不重叠；
 * - 段对象键 `<realm>/#/session-log/<session>/<start>-<end>.jsonl`，JSONL 逐行；
 * - 幂等靠「键由段区间派生 + 内容寻址校验」：同区间同内容只写一次；
 * - 完整性靠 `.info` 侧车（sha256+bytes）：读回首验，字节被改即事故。
 */
import { createHash } from 'node:crypto'

import { joinRealmKey } from './object-store.ts'
import type { LogRecord } from './session-log.ts'

/** 段范围（seq 闭区间）。 */
export interface SegmentRange {
  startSeq: number
  endSeq: number
}

/** 段对象的 `.info` 侧车：归档产物的完整性对拍凭据。 */
export interface SegmentMeta {
  sessionRef: string
  startSeq: number
  endSeq: number
  sha256: string
  bytes: number
  items: number
  archivedAt: number
}

/** 归档完成的一段的完整记录（PG `session_log_archive` 行 + MinIO 对象）。 */
export interface ArchivedSegment {
  sessionRef: string
  startSeq: number
  endSeq: number
  /** 段对象键（经 joinRealmKey 派生，含 realm 前缀） */
  objectKey: string
  sha256: string
  bytes: number
  items: number
  archivedAt: number
}

/** 段字节损坏（读回首验 sha256/bytes 不符，或 JSONL 坏行）。 */
export class SegmentCorruptError extends Error {
  constructor(
    readonly sessionRef: string,
    readonly reason: string,
  ) {
    super(`冷层段损坏：会话 ${sessionRef} —— ${reason}`)
    this.name = 'SegmentCorruptError'
  }
}

/** 段上的最大事件数（越界即抛，防止 0/负值把段切成空段）。 */
export const MAX_SEGMENT_ITEMS = 1_000

/**
 * 段边界划分：把按 seq 有序的事件切成不重叠、无缝、封顶 `maxSize` 的段。
 *
 * 每段的 `[seq[i], seq[j]]` 首尾即是真实 seq（允许隔段间的数值不连续——append-only
 * 本是连续的，但键只依赖首尾真实序号，不臆造中间值）。
 *
 * @throws 空的输入或非法 maxSize（<1）——数值一致性问题，不是正常态。
 */
export function segmentRanges(seqs: readonly number[], maxSize = MAX_SEGMENT_ITEMS): SegmentRange[] {
  if (seqs.length === 0) throw new Error('segmentRanges: 空事件集不能划段')
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new Error(`segmentRanges: maxSize 须为正整数，收到 ${maxSize}`)
  }
  const out: SegmentRange[] = []
  for (let i = 0; i < seqs.length; i += maxSize) {
    const j = Math.min(i + maxSize - 1, seqs.length - 1)
    out.push({ startSeq: seqs[i]!, endSeq: seqs[j]! })
  }
  return out
}

/**
 * 段相对键（realm 内）。`ctx.objectStore.put(realm, relativeKey)` 将再拼 realm 前缀，
 * 因此相对键**不含 realm 段**；键形如 `session-log/<session>/<start>-<end>.jsonl`。
 */
export function segmentRelativeKey(sessionRef: string, range: SegmentRange): string {
  return `session-log/${sessionRef}/${range.startSeq}-${range.endSeq}.jsonl`
}

/** 段 `.info` 侧车相对键。 */
export function segmentRelativeInfoKey(sessionRef: string, range: SegmentRange): string {
  return `session-log/${sessionRef}/${range.startSeq}-${range.endSeq}.info`
}

/**
 * 段完整对象键（含 realm 前缀，供跨节点引用/对拍）。`joinRealmKey` 负责越狱段拒绝——
 * sessionRef 若含穿越段会在此抛错。
 */
export function segmentObjectKey(realm: string, sessionRef: string, range: SegmentRange): string {
  return joinRealmKey(realm, segmentRelativeKey(sessionRef, range))
}

/** 段 `.info` 侧车完整对象键。 */
export function segmentInfoKey(realm: string, sessionRef: string, range: SegmentRange): string {
  return joinRealmKey(realm, segmentRelativeInfoKey(sessionRef, range))
}

/** 段序列化成 JSONL（按 seq 有序，一行一条 LogRecord 的 JSON）。 */
export function serializeSegment(records: readonly LogRecord[]): Buffer {
  const sorted = [...records].sort((a, b) => a.seq - b.seq)
  // NUL 字节经 JSON.stringify 转义成 \u0000，无损（同 PG 端 payload TEXT 的取舍）
  const lines = sorted.map((r) => JSON.stringify(r))
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

/** 段 JSONL 反序列化。坏行 → SegmentCorruptError（读侧须按事故处置，不静默跳过）。 */
export function parseSegment(
  sessionRef: string,
  buf: Buffer,
  expected?: SegmentMeta,
): LogRecord[] {
  if (expected) {
    const actualSha = sha256Of(buf)
    if (actualSha !== expected.sha256 || buf.byteLength !== expected.bytes) {
      throw new SegmentCorruptError(
        sessionRef,
        `侧车不符：期望 sha=${expected.sha256}/bytes=${expected.bytes}，`
        + `实得 sha=${actualSha}/bytes=${buf.byteLength}`,
      )
    }
  }
  const text = buf.toString('utf8')
  const records: LogRecord[] = []
  const lines = text.split('\n')
  // 末行是 serialize 附的 `\n` 产生的空串，跳过；中间空行是坏数据
  if (lines[lines.length - 1] === '') lines.pop()
  for (const raw of lines) {
    if (raw === '') throw new SegmentCorruptError(sessionRef, '段内出现空行')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new SegmentCorruptError(
        sessionRef,
        `行非合法 JSON：${error instanceof Error ? error.message : String(error)} -> ${raw.slice(0, 80)}`,
      )
    }
    const rec = parsed as Partial<LogRecord>
    if (
      typeof rec.sessionRef !== 'string' || typeof rec.seq !== 'number'
      || typeof rec.type !== 'string' || typeof rec.time !== 'number'
    ) {
      throw new SegmentCorruptError(sessionRef, `记录形状非法：${raw.slice(0, 120)}`)
    }
    records.push({ sessionRef, seq: rec.seq, type: rec.type, payload: rec.payload, time: rec.time } as LogRecord)
  }
  // 顺序必须与段区间一致：非单调 = 序列化错了或数据被改
  const sorted = [...records].sort((a, b) => a.seq - b.seq)
  for (let i = 0; i < records.length; i++) {
    if (records[i]!.seq !== sorted[i]!.seq) {
      throw new SegmentCorruptError(sessionRef, '段内记录 seq 非单调（顺序被破坏）')
    }
  }
  return records
}

/** 段字节的 sha256（16 进制全 64 位）。 */
export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 保留期分级。`now < archivedAt + coldRetentionMs` → cold；否则 expired。 */
export type RetentionTier = 'cold' | 'expired'

export function retentionOf(archivedAt: number, now: number, coldRetentionMs: number): RetentionTier {
  if (!Number.isFinite(coldRetentionMs) || coldRetentionMs < 0) {
    throw new Error(`coldRetentionMs 须为非负毫秒，收到 ${coldRetentionMs}`)
  }
  return now < archivedAt + coldRetentionMs ? 'cold' : 'expired'
}

/**
 * 冷层 seam（archiver 提供面，接 `ctx.objectStore`）。
 *
 * 只读 PG 真源、只写 MinIO；**不占写者租约**（冷层是归档副本，不动写路径）。
 */
export interface ColdLogSeam {
  /** 归档某会话尚未归档的段（幂等）。返回本次实际写入的段（s 段）。 */
  archive(sessionRef: string): Promise<ArchivedSegment[]>
  /** 已归档段的保留期集合（查 PG `session_log_archive`）。 */
  list(sessionRef?: string): Promise<ArchivedSegment[]>
  /**
   * 过期清理：把超过保留期的段对象从 MinIO 删除并清 PG 归档行。
   * 返回被清理的段。
   */
  sweep(now: number, coldRetentionMs: number): Promise<ArchivedSegment[]>
  /** 读回段（取 .jsonl + .info 侧车对拍，用于 resume 前把冷档装回——目前对拍/调试用）。 */
  fetch(sessionRef: string, range: SegmentRange): Promise<LogRecord[]>
}