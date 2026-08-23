/**
 * 持久信箱 / Future-Promise 契约（评审 A3）。
 *
 * §8.1 说 Future/Promise seam「背靠**持久** mailbox，跨节点跨时间成立」，
 * §5.2 却把信箱放在 Redis。Redis Cluster 不是持久消息存储——异步复制在故障切换时
 * 会丢已确认写入。
 *
 * **失效场景**：A 挂起等 `wait(id)`，B 已 `resolve(id)`，Redis 切换丢掉这次 resolve
 * → **A 永不唤醒**。它不崩溃、不报错、不占 CPU，监控上就是一个「还在跑」的任务，
 * 极难发现。这类静默挂起比崩溃危险得多。
 *
 * 本契约用三条把「无限挂起」降级成「重试」：
 *
 * 1. **持久化在 PG**（集群形态可换 RocketMQ，seam 不变）。Redis 只做读穿缓存与
 *    presence，不参与成败判定。
 * 2. **每个等待强制带 TTL**。没有「永远等下去」这个选项——`create` 必须给出
 *    `ttlMs`，到期即进死信，等待方拿到 `expired` 而不是继续悬着。
 * 3. **对账扫描**（`sweep`）兜底。唤醒通知可能丢失（PG 的 NOTIFY 不持久、消息队列
 *    会漏投），因此正确性不能建立在「通知一定到达」上：轮询/对账才是正确性来源，
 *    通知只用来降低延迟。
 *
 * ## resolve 先于 wait 的竞态
 *
 * B 完全可能在 A 调用 `wait` 之前就 `resolve`。若 resolve 只是一次「信号」，那个信号
 * 就落空了，A 随后进入永久等待。所以 **resolve 必须持久化结果值**，而 `wait` 必须
 * 先读既有结果再决定是否等待。这是本设计里 PG 相对于纯信号机制的关键优势。
 */

/** 等待项的状态机。终态三个：resolved / rejected / expired。 */
export type FutureState =
  /** 已创建、等待结果 */
  | 'pending'
  /** 已带值兑现 */
  | 'resolved'
  /** 已带错误兑现（业务失败，不是超时） */
  | 'rejected'
  /** TTL 到期未兑现 —— 死信。等待方据此重试，而不是继续挂着。 */
  | 'expired'

/** 一个等待项的当前快照 */
export interface FutureRecord {
  futureId: string
  realm: string
  state: FutureState
  /** resolved 时的值（原样返回，不做解释） */
  value?: unknown
  /** rejected 时的原因，或 expired 时的超时说明 */
  error?: string
  createdAt: number
  expiresAt: number
  resolvedAt?: number
}

/** 兑现操作的结果 —— 至少一次投递下必须能区分「首次」与「重复」 */
export type SettleOutcome =
  /** 首次兑现 */
  | { status: 'settled' }
  /** 已是终态，本次忽略。`state` 是既有终态——重复投递按首次为准，不覆盖。 */
  | { status: 'already-settled'; state: FutureState }
  /** 该 id 不存在（未 create 或已被清理） */
  | { status: 'unknown' }

/** 等待返回。**没有「一直等」这个返回**——要么终态，要么 expired。 */
export type WaitOutcome =
  | { state: 'resolved'; value: unknown }
  | { state: 'rejected'; error: string }
  /** TTL 到期。等待方应当重试或上报，绝不能再进入等待。 */
  | { state: 'expired'; error: string }

export interface MailboxSeam {
  /**
   * 建立一个等待项。**`ttlMs` 必填**：不提供「永不过期」的选项，
   * 因为那正是 A3 要消灭的失败模式。
   *
   * 同 id 重复 create 视为幂等（返回既有记录），至少一次投递下这是常态。
   */
  create(futureId: string, realm: string, ttlMs: number): Promise<FutureRecord>

  /** 带值兑现。已终态则不覆盖（首次为准）。 */
  resolve(futureId: string, value: unknown): Promise<SettleOutcome>

  /** 带错误兑现（业务失败）。已终态则不覆盖。 */
  reject(futureId: string, error: string): Promise<SettleOutcome>

  /**
   * 等待兑现。先读既有结果（覆盖 resolve 先于 wait 的竞态），未决则轮询到
   * 终态或 TTL 到期为止。
   *
   * @param timeoutMs 调用方自己的等待上限；仍受该项 TTL 约束，取两者更早者。
   */
  wait(futureId: string, timeoutMs?: number): Promise<WaitOutcome>

  /** 非阻塞查询。不存在返回 undefined。 */
  poll(futureId: string): Promise<FutureRecord | undefined>

  /**
   * 对账：把已过 TTL 仍 pending 的项推入死信（`expired`）。
   *
   * 这是正确性的兜底——即使所有唤醒通知都丢了，扫描也会在 TTL 之后把等待方释放。
   * @returns 本次推入死信的条数
   */
  sweep(): Promise<number>

  /** 列出死信（供运维排查「谁没被唤醒」）。 */
  deadLetters(realm: string, limit?: number): Promise<FutureRecord[]>
}
