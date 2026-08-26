/**
 * 复制式 SessionEvent 日志热层契约（§4.2「热层 Redis → 冷转 MinIO」）。
 *
 * 契约定位先与 session-log.ts 对齐：真相源是 PG（写路径 + fencing 在 session-log 契约
 * 已锁），Redis 只读热缓存、不参与写路径成败（§13.1 硬规矩）。本契约锁**缓存自身的
 * 形状**：每会话一条 LIST 尾部窗口，纯函数可测，实现 `RedisHotLog` 只要套用即可。
 */
import type { LogRecord } from './session-log.ts'

/** 会话热窗口在 Redis 中的相对键（realm 是身份段；与冷层/对象存储的隔离语义一致）。 */
export function hotRelativeKey(realm: string, sessionRef: string): string {
  return `session-log/hot/${realm}/${sessionRef}`
}

/**
 * 窗口覆盖判定：覆盖当且仅当 `firstSeq <= fromSeq <= lastSeq`。
 *
 * **`fromSeq > lastSeq` 不算覆盖** —— 缓存写落后于 PG 的瞬时窗口（PG 已提交、镜像未完成）
 * 必须回 PG，否则会把「比缓存新」误当成「已齐」而返回半截历史。
 */
export function windowCovered(firstSeq: number, lastSeq: number, fromSeq: number): boolean {
  return firstSeq <= fromSeq && fromSeq <= lastSeq
}

/** 记录序列化为单行 JSON（NUL 由 JSON.stringify 转义，parse 精确还原——同 pg-log 的 TEXT 理由）。 */
export function serializeHotRecord(record: LogRecord): string {
  return JSON.stringify(record)
}

/** 单行 JSON 还原为记录。坏行/坏形状必须抛错——窗口里一行损坏即整窗不可信。 */
export function parseHotRecord(line: string, sessionRef: string): LogRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(
      `热层行非合法 JSON：${error instanceof Error ? error.message : String(error)} -> ${line.slice(0, 80)}`,
    )
  }
  const rec = parsed as Partial<LogRecord> | null
  if (
    rec === null || typeof rec !== 'object'
    || typeof rec.seq !== 'number' || typeof rec.type !== 'string' || typeof rec.time !== 'number'
  ) {
    throw new Error(`热层记录形状非法：${line.slice(0, 120)}`)
  }
  return { sessionRef, seq: rec.seq, type: rec.type, payload: rec.payload, time: rec.time }
}

/** 窗口完整性断言：seq 连续升序、无重复。不连续 = 缓存有洞（中间丢过元素），不可信任。 */
export function contiguousSeq(seqs: readonly number[]): boolean {
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1]! + 1) return false
  }
  return true
}

/**
 * 热层 seam（实现方 `RedisHotLog`）。**读路径的可选加速层**：
 * 命中即返回 seq>=fromSeq 的完整有序记录；未命中返回 undefined，调用方回退 PG。
 * 任何读都不许返回「半截窗口」——窗口连续性校验不通过即弃，宁回 PG。
 * 无热层时提供方为空，读路径 100% 由 PG 承担（行为与未配置完全一致）。
 */
export interface HotLogSeam {
  /** 窗口覆盖时返回 seq >= fromSeq 的有序完整记录；`undefined` = 未覆盖或窗口有洞。 */
  read(sessionRef: string, fromSeq: number): Promise<LogRecord[] | undefined>

  /**
   * watermark = 缓存的最新一条 (seq, time)；`undefined` = 无缓存。
   * serve「证据不够新」探测：跨节点 resume/多端判定以它判落后阈值——声称「最新」
   * 的前提是缓存被写路径连续镜像；迟滞本身就是探测的对象。
   */
  head(sessionRef: string): Promise<{ seq: number; time: number } | undefined>
}
