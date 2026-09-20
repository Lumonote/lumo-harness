/**
 * 线程的唤醒接线（§24.2.1 的「事件订阅集合」+ §8.1 的三条纪律）。
 *
 * ## 为什么「事件订阅」就是 mailbox 的等待项，而不是新机制
 *
 * §24.2.1 把 Thread 定义成 `(稳定 sessionRef, 承载节点, 事件订阅集合)`，而 §8.1 已经给了
 * 这个集合的载体：**持久 Future/Promise**（`A await(team.mailbox.wait(id))`，
 * `B/human resolve(id)`）。订阅一个事件 = 开一个等待项，事件到达 = 兑现它。本模块因此
 * 只是 `courier.ts` 的一层使用纪律，**不新建消息机制**（不新增表、不新增服务）。
 *
 * ## 三条纪律逐条落在哪
 *
 * | §8.1 的纪律 | 落点 |
 * |---|---|
 * | 每个等待强制带 TTL | `arm()` 必经 `resolveWakeTtlMs`（这个函数不存在「无限」这个返回） |
 * | TTL 到期进死信 | `@lumo/mailbox` 的 `sweep()`（其插件自带定时扫描）把过期项推入 `expired`；本层只**消费**这个结论，不自己造一套过期判定 |
 * | 对账扫描兜底 | `reconcile()`：读每个等待项的状态并分桶。正确性建立在轮询上，通知只降低延迟 |
 *
 * ## 为什么 reconcile 只扫 `awaiting` 的线程
 *
 * 没进过 `awaiting` 的线程**没有等待项**，`state()` 对它会返回 `unknown`。若不筛掉，
 * 一条正常在跑的线程会被报成「搁浅」——一个每次对账都会出现的假警报，会让人开始忽略
 * 这个桶，而它恰恰是「谁没被唤醒」这类事故的唯一出口。
 *
 * ## 绝不重新等待
 *
 * `expired` 的语义是「这次等待已经不可能被兑现」（§8.1：TTL 到期进死信，等待方据此
 * 重试或上报）。所以本模块**不提供「再等一次」**：`reconcile` 把这类线程放进 `stranded`
 * 桶交给调用方处置，`wait()` 也照原样把 `expired` 返回上去。重试的正确形态是**新的一轮
 * Run**（新通道），不是在同一条等待上再挂一次。
 */

import type { ChannelState, CourierSettle, CourierWait, TeamCourier } from './courier.ts'
import { resolveWakeTtlMs, threadWakeChannel, type ThreadRound, type ThreadRow } from './thread.ts'

/** 一条待对账的线程（含它当前那一轮的 Run 身份）。 */
export interface ThreadWakeEntry {
  thread: ThreadRow
  round: ThreadRound
}

/** 对账结果的三个桶（互斥，合起来是全部**进过等待**的线程）。 */
export interface ThreadReconcileResult {
  /** 通道仍是 `pending`：还在等，成员/事件尚未到达。 */
  running: string[]
  /** 通道已兑现（`resolved`/`rejected`）：结局已落盘，等调用方处理。 */
  settling: string[]
  /**
   * 通道 `expired`（TTL 到期）或 `unknown`（从未 arm / 已被清理）：**等待不可能再被兑现**。
   * 必须处置（上报、或按新 Run 重派），但**不是**自动标 failed —— TTL 到期与「承载节点丢失」
   * 是两类事故，把前者写成 failed 会把「没人应答」伪装成「现场没了」，于是重派会带上
   * 「现场已经没了」的错误前提。
   */
  stranded: string[]
}

/** 构造参数。 */
export interface ThreadWakerOptions {
  /**
   * 会合面**解析器**，不是实例：`mailbox` 的挂载顺序不由本插件决定（与
   * `AgentTeamsService` 的 `resolveCourier` 同一条理由）。构造时快照一次会把
   * 「mailbox 晚一步挂上」永久固化成进程内兜底——等待项重启即丢，却看起来一切正常。
   */
  resolveCourier: () => TeamCourier
  /** 覆盖默认唤醒有效期（仍受 `MAX_WAKE_TTL_MS` 约束）。 */
  defaultTtlMs?: number
  warn?: (message: string) => void
}

/**
 * 线程唤醒的传输层。
 *
 * 它**不做判据**：该不该唤醒由 `threadActionDecision`（`thread.ts`）定，本类只负责把
 * 结论落到会合面上。这样「判据只有一处」与「挂点只消费输出」两件事同时成立。
 */
export class ThreadWaker {
  private readonly options: ThreadWakerOptions
  private readonly defaultTtlMs: number
  private readonly warn: (message: string) => void

  constructor(options: ThreadWakerOptions) {
    this.options = options
    this.defaultTtlMs = resolveWakeTtlMs(options.defaultTtlMs)
    this.warn = options.warn ?? (() => {})
  }

  /** 当前会合面（每次现取，见构造参数的说明）。 */
  private get courier(): TeamCourier {
    return this.options.resolveCourier()
  }

  /** 底层等待项是否持久（false = 进程内兜底，重启即丢）。 */
  get durable(): boolean {
    return this.courier.durable
  }

  /**
   * 上线一个等待项：线程进入 `awaiting` **之前**必须先 arm。
   *
   * 顺序是硬的：先挂起再 arm 会存在一个窗口——事件在这一刻到达，而等待项还不存在，
   * 那次事件就落空了（§8.1 明写要防的「resolve 先于 wait」是同一类竞态；mailbox 用
   * 「resolve 持久化结果值」兜住它，但**前提是等待项已经存在**）。
   */
  async arm(threadId: string, round: ThreadRound, ttlMs?: number): Promise<{ channel: string; ttlMs: number }> {
    const ttl = resolveWakeTtlMs(ttlMs ?? this.defaultTtlMs)
    const channel = threadWakeChannel(threadId, round)
    await this.courier.open(channel, ttl)
    return { channel, ttlMs: ttl }
  }

  /** 兑现一次唤醒（事件到达）。首次为准：重复兑现由会合面按 `already-settled` 回报。 */
  wake(threadId: string, round: ThreadRound, event: unknown): Promise<CourierSettle> {
    return this.courier.settle(threadWakeChannel(threadId, round), event)
  }

  /** 带错误兑现：这一轮不会再来了（任务被取消、上游失败）。 */
  abandon(threadId: string, round: ThreadRound, reason: string): Promise<CourierSettle> {
    return this.courier.fail(threadWakeChannel(threadId, round), reason)
  }

  /**
   * 通知：把一个**外部事实**（节点失联、上游取消）投进线程的唤醒通道。
   *
   * 顺序是硬的：**先 arm，再兑现**。等待项可能还不存在 —— 协调者未必正好在等（它可能刚被
   * 别的线程唤醒，或还没开始等），而 §8.1 的「resolve 先于 wait」是既有能力：mailbox 把
   * 兑现值**持久化**，后到的 `wait` 先读既有结果再决定是否进入等待。前提是等待项存在，
   * 所以这里必须自己把它建出来（`arm` 对已存在的项是幂等的，且**不会**重置 TTL ——
   * 否则一次反复重投的通知就能把等待项无限续命）。
   *
   * `ttlMs` 强制走 `resolveWakeTtlMs`（那里不存在「无限」这个返回）：通知是**有寿命的
   * 事实**。一条半年后才被读到的「这个节点没了」，会让协调者去重派一件早就被别的路径
   * 处理完的工作 —— TTL 到期进死信，比一条永生的事实安全。
   *
   * 重复通知（至少一次投递下必然出现）不会改写结局：会合面的兑现「首次为准」，
   * 第二次按 `already-settled` 回报。
   */
  async announce(threadId: string, round: ThreadRound, event: unknown, ttlMs?: number): Promise<{
    channel: string
    ttlMs: number
    settled: CourierSettle
  }> {
    const armed = await this.arm(threadId, round, ttlMs)
    const settled = await this.wake(threadId, round, event)
    return { channel: armed.channel, ttlMs: armed.ttlMs, settled }
  }

  /**
   * 等待一次唤醒（挂起点）。
   *
   * `expired` 是**正常返回**而不是异常：它表示这次等待到期了，调用方据此上报或按新 Run
   * 重派。这里绝不吞掉它、也绝不自动再等一轮 —— 那会把 §8.1 的「没有无限等待」变成
   * 「无限重试」，而重试烧的是配额（§6.4）。
   */
  wait(threadId: string, round: ThreadRound, timeoutMs?: number): Promise<CourierWait> {
    return this.courier.await(threadWakeChannel(threadId, round), timeoutMs)
  }

  /** 非阻塞读一个等待项的状态（对账用）。 */
  state(threadId: string, round: ThreadRound): Promise<ChannelState> {
    return this.courier.state(threadWakeChannel(threadId, round))
  }

  /**
   * 对账扫描：把进过等待的线程分到三个桶里。
   *
   * 判定口径与会合面**逐字一致**（`pending` → 还在等；`resolved`/`rejected` → 已落盘；
   * 其余 → 搁浅）。这里刻意不引入「多久没消息算搁浅」这类时间判据：会合面已经有 TTL，
   * 再加一套本地时钟判据就会出现「通道说 pending、本地说搁浅」的双真相。
   */
  async reconcile(entries: readonly ThreadWakeEntry[]): Promise<ThreadReconcileResult> {
    const result: ThreadReconcileResult = { running: [], settling: [], stranded: [] }
    for (const entry of entries) {
      if (entry.thread.state !== 'awaiting') continue
      const state = await this.courier.state(threadWakeChannel(entry.thread.id, entry.round))
      if (state === 'pending') {
        result.running.push(entry.thread.id)
        continue
      }
      if (state === 'resolved' || state === 'rejected') {
        result.settling.push(entry.thread.id)
        continue
      }
      // expired / unknown：等待不可能再被兑现。
      if (state === 'unknown') {
        // 从未 arm 过就进了 awaiting，说明状态被谁推过头了——这值得留痕（读路径上它
        // 与「已被清理」分不开，所以只能告警，不能自动改状态）。
        this.warn(`agent-teams: 线程 ${entry.thread.id} 处于 awaiting 但没有对应的唤醒通道 ${threadWakeChannel(entry.thread.id, entry.round)}`)
      }
      result.stranded.push(entry.thread.id)
    }
    return result
  }
}
