/**
 * 复制日志读面的 staleness 信封契约（行 3 —— remote-forms 排序表第 3 行）。
 *
 * 设计原文：查询永远查「已复制到本地」的段——补 staleness：落后超阈值返回显式
 * `stale` 而非半截结果。本契约定死三条：
 *
 * 1. **读面与日志复制同源。** 查询只读本地已复制的段，replicaHead 恒取该段的最大
 *    seq；不另设第二份投影、不发明新的滞后探测基础设施。判别基准与 resume 所用的
 *    历史**同一来源**——resume 能续上的历史，就是查询能返回的历史。
 * 2. **阈值判别纯函数化。** 落后多少算「陈旧」由 {@link stalenessOf} 一处裁决：
 *    纯函数、无 IO、无时钟，同样的输入永远同样的裁决。装配层只负责取数，绝不夹带
 *    自己的滞后判断。
 * 3. **绝不半截结果。** 落后超阈值时返回显式 `stale` 信封（附 replicaHead/liveHead/lag
 *    三数证据），**不携带任何 records**——调用方要么拿到完整的本地历史，要么拿到
 *    「为什么不给」的证据，绝不能拿到一段看似完整、尾部缺截的半截结果。
 */
import { invalid } from './errors.ts'
import type { LogRecord } from './session-log.ts'

/** stale 原因词表闭集：当前唯一原因是复制滞后；新增原因必须先扩词表再扩语义。 */
export const STALE_REASONS = ['replication-lag'] as const
export type StaleReason = (typeof STALE_REASONS)[number]

/**
 * 读面查询信封（闭集）：fresh 全量照回本地已复制段；stale 只带证据不带 records。
 */
export type SessionQueryEnvelope =
  | {
      readonly kind: 'fresh'
      /** 本地已复制段的完整有序历史（空数组 = 真没有，也是诚实的全量）。 */
      readonly records: readonly LogRecord[]
    }
  | {
      readonly kind: 'stale'
      /** 原因词表内取值（{@link STALE_REASONS}）。 */
      readonly reason: StaleReason
      /** 本地已复制段的最大 seq。 */
      readonly replicaHead: number
      /** 调用方供给的 live 会话已知上界。 */
      readonly liveHead: number
      /** lag = liveHead − replicaHead（可复算的信封才是证据）。 */
      readonly lag: number
    }

/**
 * 阈值判别纯函数：lag = live − replica，**严格大于** threshold 才陈旧。
 *
 * 守卫（fail-closed）：三个输入都必须是非负安全整数——NaN/Infinity/非整数会让
 * 「落后多少」失去计量含义，乱输入是调用方错误而非节点故障，入口即拒。
 * replica 领先 live（lag ≤ 0）不算异常：调用方供的是下界探测，比本地旧只说明其
 * 认知滞后，记录本就不少于其已知上界，数值判别自然落入 fresh。
 */
export function stalenessOf(
  liveHead: number,
  replicaHead: number,
  threshold: number,
): { fresh: true } | { fresh: false; lag: number } {
  requireSeqHead(liveHead, 'liveHead')
  requireSeqHead(replicaHead, 'replicaHead')
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw invalid(`session-query: threshold 必须是非负安全整数，收到 ${threshold}`)
  }
  const lag = liveHead - replicaHead
  return lag > threshold ? { fresh: false, lag } : { fresh: true }
}

function requireSeqHead(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`session-query: ${name} 必须是非负安全整数，收到 ${value}`)
  }
}

/**
 * 信封形状校验（fail-closed，抛 `invalid('session-query: …')`）。
 *
 * 两臂各自锁形：fresh 臂锁 records 为合法 LogRecord 行序；stale 臂锁 reason 在词表内、
 * 三个数字为非负安全整数且 **lag 必须恰好等于 live − replica**——数学不可复算的
 * 信封是伪证，直接拒绝。
 */
export function assertSessionQueryEnvelope(v: unknown): asserts v is SessionQueryEnvelope {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw invalid('session-query: 信封必须是对象')
  }
  const env = v as Record<string, unknown>
  if (env['kind'] === 'fresh') {
    assertRecords(env['records'])
    return
  }
  if (env['kind'] === 'stale') {
    const reason = env['reason']
    if (typeof reason !== 'string' || !(STALE_REASONS as readonly string[]).includes(reason)) {
      throw invalid(
        `session-query: stale.reason 必须在词表内（${STALE_REASONS.join('/')}），收到 ${JSON.stringify(reason)}`,
      )
    }
    requireSeqHead(env['liveHead'] as number, 'liveHead')
    requireSeqHead(env['replicaHead'] as number, 'replicaHead')
    const live = env['liveHead']
    const replica = env['replicaHead']
    const lag = env['lag']
    if (
      !Number.isSafeInteger(live) || !Number.isSafeInteger(replica)
      || !Number.isSafeInteger(lag) || lag !== (live as number) - (replica as number)
    ) {
      throw invalid(
        `session-query: stale.lag=${JSON.stringify(lag)} 与 live−replica=`
        + `${JSON.stringify(live)}−${JSON.stringify(replica)} 不自洽`,
      )
    }
    return
  }
  throw invalid(`session-query: kind 闭集外，收到 ${JSON.stringify(env['kind'])}`)
}

/** fresh 臂 records 校验：有序列元素逐条锁最小 LogRecord 形状（一行坏即整信封拒）。 */
function assertRecords(records: unknown): void {
  if (!Array.isArray(records)) {
    throw invalid('session-query: fresh.records 必须是数组')
  }
  for (const rec of records) {
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
      throw invalid('session-query: fresh.records 元素必须是对象')
    }
    const r = rec as Record<string, unknown>
    if (typeof r['sessionRef'] !== 'string' || r['sessionRef'] === '') {
      throw invalid('session-query: record.sessionRef 必须是非空字符串')
    }
    if (!Number.isSafeInteger(r['seq']) || (r['seq'] as number) < 0) {
      throw invalid(`session-query: record.seq 必须是非负安全整数，收到 ${JSON.stringify(r['seq'])}`)
    }
    if (typeof r['type'] !== 'string' || r['type'] === '') {
      throw invalid('session-query: record.type 必须是非空字符串')
    }
    // payload 可以是任何 JSON 值（含 null），但不可缺席/undefined——NUL 等都合法，
    // 缺席才是形状损坏。
    if (r['payload'] === undefined) {
      throw invalid('session-query: record.payload 不可缺席')
    }
    if (typeof r['time'] !== 'number' || !Number.isFinite(r['time'])) {
      throw invalid(`session-query: record.time 必须是有限数字，收到 ${JSON.stringify(r['time'])}`)
    }
  }
}

/** 查询选项。 */
export interface SessionQueryOptions {
  /**
   * 调用方显式供给的 live 会话已知上界（跨节点投影场景）。
   *
   * **v1 诚实边界**：缺省（undefined）⇒ 无判别基准 ⇒ 恒 fresh 全量返回；
   * 不发明新的滞后探测基础设施——跨节点的下界探测归「投影库」后续切片。
   */
  readonly liveHead?: number
  /** 落后阈值（事件条数）：lag > maxLag 判 stale；缺省用装配侧常量（8 个事件）。 */
  readonly maxLag?: number
}

/** 读面 seam（装配方提供 `ctx.sessionLogQuery`）。 */
export interface SessionLogQuerySeam {
  queryWithStaleness(sessionRef: string, opts?: SessionQueryOptions): Promise<SessionQueryEnvelope>
}
