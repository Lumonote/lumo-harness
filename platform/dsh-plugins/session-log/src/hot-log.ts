/**
 * SessionEvent 日志热层的 Redis 实现（§4.2：每会话 LIST 尾部窗口缓存）。
 *
 * 定位：写路径 + fencing 已在 `pg-log.ts` 落地（真相源是 PG）；本文件做**热加速**——
 * 每会话一条 Redis LIST 缓存 seq 尾部窗口，写后透传镜像（mirror），读路径窗口未覆盖
 * 即回退 PG。Redis 是只读加速器，**绝不参与写路径成败判定**（fail-open / D-Continue）。
 *
 * 四条刻意的取舍：
 *
 * **① 单连接实例。** ioredis 单连接上的命令天然按序执行、MULTI 按提交序原子落盘——
 * 镜像顺序 == 调用顺序 == PG append 顺序，窗口里的 seq 序就是 append 序，无需排序。
 *
 * **② fail-open：单条命令快速失败。** `maxRetriesPerRequest: 1` 让命令在连接抖动时
 * 约 50ms 内拒绝（默认 20 次重试会让读路径挂约 10s 才回退——那就不是「透明加速」
 * 而是读路径事故）。连接本身仍按默认策略后台重连：命令快速失败、连接缓慢恢复。
 * 读方失败回 PG、写方失败只 warn——Redis 任何故障都不放大为日志故障。
 *
 * **③ 窗口完整性先于返回。** read 把整窗 LRANGE 出来先做 contiguousSeq 断言：
 * 不连续 = 缓存有洞（中间丢过元素），宁回 PG 也不返回脏窗口；坏行同样弃用。
 * 正确性是构造性的：要么返回连续升序且覆盖 fromSeq 的窗口，要么返回 undefined。
 *
 * **④ mirror 是三个命令一个事务。** RPUSH + LTRIM 裁剪 + PEXPIRE 续 TTL，MULTI
 * 保证窗口裁剪与写入原子（读方永远不会看到「RPUSH 了但没 LTRIM」的中间态）。
 */
import { Redis } from 'ioredis'

import {
  type HotLogSeam,
  contiguousSeq,
  hotRelativeKey,
  parseHotRecord,
  serializeHotRecord,
  windowCovered,
} from '../../../shared/seam-contracts/hot-log.ts'
import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'

/** 默认窗口长度：2000 条，够 resume 最近一段上下文。 */
export const DEFAULT_HOT_MAX_LEN = 2_000

/** 默认 TTL：6h。窗口是加速器不是存档，过期回 PG 无损失。 */
export const DEFAULT_HOT_TTL_MS = 6 * 3600 * 1000

export interface RedisHotLogOptions {
  url: string
  /** 身份段：热键第一前缀（跨 realm 共用一个 Redis 时隔离） */
  realm: string
  /** 窗口最大长度；默认 {@link DEFAULT_HOT_MAX_LEN} */
  maxLen?: number
  /** 窗口 TTL（毫秒）；默认 {@link DEFAULT_HOT_TTL_MS} */
  ttlMs?: number
  /** 内部告警出口（坏行/窗口有洞/连接错误等）；缺省静默 */
  onWarn?: (message: string) => void
}

export class RedisHotLog implements HotLogSeam {
  private redis: Redis
  private readonly realm: string
  private readonly maxLen: number
  private readonly ttlMs: number
  private readonly onWarn: (message: string) => void

  constructor(options: RedisHotLogOptions) {
    const maxLen = options.maxLen ?? DEFAULT_HOT_MAX_LEN
    const ttlMs = options.ttlMs ?? DEFAULT_HOT_TTL_MS
    if (!Number.isInteger(maxLen) || maxLen < 1) {
      throw new Error(`RedisHotLog: maxLen 须为正整数，收到 ${maxLen}`)
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new Error(`RedisHotLog: ttlMs 须为正整数毫秒，收到 ${ttlMs}`)
    }
    this.realm = options.realm
    this.maxLen = maxLen
    this.ttlMs = ttlMs
    this.onWarn = options.onWarn ?? (() => {})
    // 单连接（见文件头 ①）+ 命令快速失败（见文件头 ②）
    this.redis = new Redis(options.url, { maxRetriesPerRequest: 1 })
    // 连接错误走 warn 出口；挂上监听也避免 ioredis 默认的 "Unhandled error event" 噪音
    this.redis.on('error', (error: Error) => {
      this.onWarn(`Redis 连接错误：${error.message}`)
    })
  }

  /**
   * 写后透传镜像：RPUSH + LTRIM 裁剪 + PEXPIRE 续 TTL 一个事务完成。
   *
   * 调用方契约：**仅在 PG 提交成功后调用**（append resolve 为 appended），且调用序
   * == append 序——单连接保证镜像按序落盘。失败由调用方 catch 处置（只 warn，
   * 绝不 fence、绝不改 AppendResult）。
   */
  async mirror(record: LogRecord): Promise<void> {
    const key = hotRelativeKey(this.realm, record.sessionRef)
    const multi = this.redis.multi()
    multi.rpush(key, serializeHotRecord(record))
    multi.ltrim(key, -this.maxLen, -1)
    multi.pexpire(key, this.ttlMs)
    await multi.exec()
  }

  async read(sessionRef: string, fromSeq: number): Promise<LogRecord[] | undefined> {
    const lines = await this.redis.lrange(hotRelativeKey(this.realm, sessionRef), 0, -1)
    if (lines.length === 0) return undefined
    const records: LogRecord[] = []
    for (const line of lines) {
      try {
        records.push(parseHotRecord(line, sessionRef))
      } catch (error) {
        // 坏行按事故处置：弃用缓存回 PG，不静默跳过（跳行 = 返回被篡改的历史）
        this.onWarn(`热层窗口含坏行（会话 ${sessionRef}），弃用缓存回 PG：${
          error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    if (!contiguousSeq(records.map((r) => r.seq))) {
      this.onWarn(`热层窗口 seq 不连续（会话 ${sessionRef}），缓存有洞弃用回 PG：${
        records.map((r) => r.seq).join(',')}`)
      return undefined
    }
    const firstSeq = records[0]!.seq
    const lastSeq = records[records.length - 1]!.seq
    if (!windowCovered(firstSeq, lastSeq, fromSeq)) return undefined
    return records.filter((r) => r.seq >= fromSeq)
  }

  async head(sessionRef: string): Promise<{ seq: number; time: number } | undefined> {
    const line = await this.redis.lindex(hotRelativeKey(this.realm, sessionRef), -1)
    if (line === null) return undefined
    try {
      const rec = parseHotRecord(line, sessionRef)
      return { seq: rec.seq, time: rec.time }
    } catch (error) {
      this.onWarn(`热层 head 坏行（会话 ${sessionRef}），视为无缓存：${
        error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect()
  }
}
