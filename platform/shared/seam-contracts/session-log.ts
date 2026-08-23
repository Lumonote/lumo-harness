/**
 * 复制式 SessionEvent 日志契约（评审 A1 —— 写路径强一致 + 单写者 fencing）。
 *
 * 评审指出的自相矛盾：§13.1 把日志复制归入**最终一致**（Redis），§4.2 又称它是
 * 「多端一致性唯一 reconcile 源」、§7.1 还靠它做崩溃恢复。**不能既是权威恢复源、
 * 又允许失活丢写**——Redis Cluster 异步复制在故障切换时会丢已确认写入。
 *
 * 故本契约定死三条：
 *
 * 1. **真相源是 PG**，写路径同步落库才算 append 成功。Redis 只读热缓存，
 *    Doris/MinIO 冷归档；**Redis 不是日志真相源**（§13.1 硬规矩）。
 * 2. **每会话单写者**，由带 fencing token 的写者租约保证。RocketMQ 至少一次投递
 *    会让两个节点同时 resume 同一任务，若无此约束两者都会 append → 日志分叉。
 * 3. **序号用 dsh 原生的 `SessionEvent.seq`**（会话内单调），不另造一套。
 *    `(session, seq)` 主键因此天然是分叉探测器：同一 seq 出现两个不同事件即分叉。
 *
 * ## fencing 为什么不能省
 *
 * 光有租约不够：持租节点可能 GC 长停顿或网络分区，租约到期被人接管，而它**醒来后
 * 仍以为自己持租**并继续写。fencing token 是每次易主就 +1 的单调整数，append 必须
 * 带上它；旧持有者带着过期 token 回来时，存储层直接拒绝——这是唯一不依赖时钟正确性
 * 的防线（时钟只决定「何时允许接管」，不决定「谁的写有效」）。
 */

/** 写者租约。`fencingToken` 每次**易主**递增；同一持有者续租不变。 */
export interface WriterLease {
  sessionRef: string
  /** 持有者标识（节点 id + 进程实例，须能区分同机重启） */
  holder: string
  /** 单调递增的隔离令牌；append 必须携带 */
  fencingToken: number
  /** 租约到期时刻（毫秒，**存储端时钟**——跨节点比较不能用各自的本地时钟） */
  expiresAt: number
}

/** 一条待复制的日志记录（`SessionEvent` 的存储投影） */
export interface LogRecord {
  sessionRef: string
  /** dsh 原生的会话内单调序号 —— 权威顺序，不重编 */
  seq: number
  type: string
  /** 事件原文（`SessionEvent` 整体 JSON） */
  payload: unknown
  /** 事件时刻（取自 `SessionEvent.time`） */
  time: number
}

/** append 的结果分类 —— 调用方必须区分处置，不能一律当成功 */
export type AppendResult =
  /** 首次写入成功 */
  | { status: 'appended'; seq: number }
  /**
   * 同一 (session, seq) 已存在且内容一致 —— 至少一次投递造成的良性重复，
   * 幂等吸收，不是错误。
   */
  | { status: 'duplicate'; seq: number }

/**
 * 日志分叉：同一 (session, seq) 上出现内容**不同**的两个事件。
 *
 * 这是数据完整性事故，不是可重试故障：说明单写者约束已被突破（两个节点同时
 * resume 了同一会话）。必须响亮失败并告警，**绝不允许覆盖或静默择一**——
 * 两条分支都可能已经产生了外部副作用，机器无权替人选一条。
 */
export class LogForkError extends Error {
  constructor(
    readonly sessionRef: string,
    readonly seq: number,
    readonly existingDigest: string,
    readonly incomingDigest: string,
  ) {
    super(
      `日志分叉：会话 ${sessionRef} 的 seq=${seq} 上已存在不同事件`
      + `（已存 ${existingDigest} ≠ 新写 ${incomingDigest}）。`
      + '单写者约束已被突破，需人工裁定保留哪条分支。',
    )
    this.name = 'LogForkError'
  }
}

/** 租约被抢占：本节点的 fencing token 已过期，写入被拒。 */
export class FencedOutError extends Error {
  constructor(
    readonly sessionRef: string,
    readonly presentedToken: number,
    readonly currentToken: number | undefined,
  ) {
    super(
      `写者租约已失效：会话 ${sessionRef} 当前令牌 ${currentToken ?? '（无租约）'}，`
      + `本次携带 ${presentedToken}。本节点已被接管，必须立即停止对该会话的一切写入。`,
    )
    this.name = 'FencedOutError'
  }
}

export interface SessionLogSeam {
  /**
   * 抢占/续租写者租约。
   *
   * 语义：无租约 → 建租（token=1）；租约在手 → 续期，**token 不变**（否则自己在途的
   * 写会被自己的新 token 挤掉）；他人持租且未过期 → 返回 undefined（拒绝，不等待）；
   * 他人持租但已过期 → 接管，**token +1**。
   */
  acquire(sessionRef: string, holder: string, ttlMs: number): Promise<WriterLease | undefined>

  /** 主动让出租约（正常收尾）。非持有者调用无效果。 */
  release(sessionRef: string, holder: string): Promise<void>

  /**
   * 追加一条日志。必须携带 fencing token。
   *
   * @throws {FencedOutError} 令牌过期（已被接管）
   * @throws {LogForkError} 同 seq 上已有不同事件
   */
  append(record: LogRecord, fencingToken: number): Promise<AppendResult>

  /** 读取日志（用于跨节点 resume：结果直接喂 `CreateSessionOptions.seed`） */
  read(sessionRef: string, fromSeq?: number): Promise<LogRecord[]>

  /** 当前租约（无则 undefined）；用于监控与接管判断 */
  lease(sessionRef: string): Promise<WriterLease | undefined>
}
