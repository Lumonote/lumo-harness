/**
 * @lumo/agent-teams 的 courier —— 团队成员之间的消息/会合面。
 *
 * ## 为什么是「等待项」而不是「消息队列」
 *
 * §7.3 的第三种拓扑是「议会 Deliberation：多 agent 向同一 mailbox 发观点，planner
 * 收敛」。这里的通信形态是**扇入**：planner 开 N 个收集槽，N 个成员各自兑现，planner
 * 等齐。§8.1 的 Future/Promise seam 正是这个形状 ——
 * `agent A await(team.mailbox.wait(id))`，`B resolve(id)`。
 *
 * 用「消息队列」建模反而错位：队列语义是「投递即忘」，而协同要的是「可等待的兑现」，
 * 且必须**跨节点跨时间**成立（成员可能在别的承载节点上，也可能在 planner 挂起期间才
 * 回来）。平台已有的 `@lumo/mailbox` 恰好是持久 Future/Promise 且强制 TTL + 死信，
 * 因此集群形态直接用它，不另造一套。
 *
 * ## 单机形态的兜底
 *
 * `mailbox` 插件只在 server 形态挂载（`dsh-node/src/index.ts` 的 local 分支注释：
 * 「SQLite only. No PostgreSQL, Redis, MinIO, RocketMQ or Nacos」）。单机上
 * `ctx.mailbox` 不存在，因此回落进程内实现 —— 语义相同（含 TTL 与「绝不无限等」），
 * 只是不跨进程。这是**能力降级**：调用方能从 `durable` 标志看出来。
 *
 * ## 绝不无限等
 *
 * 契约里没有「一直等」这个选项（`shared/seam-contracts/mailbox.ts` 的 A3 结论：
 * 无限挂起比崩溃危险得多）。所以 `open` 必须给 TTL，`await` 要么拿到终态、要么拿到
 * `expired` 去重试或上报。
 */

/** 等待项的终态返回。**没有「一直等」这个返回**。 */
export type CourierWait =
  | { state: 'resolved'; value: unknown }
  | { state: 'rejected'; error: string }
  /** TTL 到期。调用方应重试或上报，绝不能再进入等待。 */
  | { state: 'expired'; error: string }

/** 兑现结果。至少一次投递下必须能区分「首次」与「重复」。 */
export type CourierSettle =
  | { status: 'settled' }
  | { status: 'already-settled' }
  /** 该等待项不存在（未 open 或已清理）。 */
  | { status: 'unknown' }

/** 等待项的状态（`state` 探针用）。`unknown` = 从未 open 或已被清理。 */
export type ChannelState = 'pending' | 'resolved' | 'rejected' | 'expired' | 'unknown'

/** 团队会合面。 */
export interface TeamCourier {
  /** 底层是否持久（false = 进程内兜底，重启即丢）。 */
  readonly durable: boolean
  /** 开一个等待项。同 id 重复 open 幂等。 */
  open(channelId: string, ttlMs: number): Promise<void>
  /** 带值兑现。已终态则不覆盖（首次为准）。 */
  settle(channelId: string, value: unknown): Promise<CourierSettle>
  /** 带错误兑现。已终态则不覆盖。 */
  fail(channelId: string, error: string): Promise<CourierSettle>
  /** 等待兑现；受该项 TTL 与调用方 timeout 双重约束，取更早者。 */
  await(channelId: string, timeoutMs?: number): Promise<CourierWait>
  /** 非阻塞查状态。对账（`reconcile`）靠它判断某次派发是否已死。 */
  state(channelId: string): Promise<ChannelState>
  /** 释放本 courier 自己持有的资源（**不**关闭共享的 mailbox 服务）。 */
  close(): Promise<void>
}

/**
 * 一次派发对应的通道 id。
 *
 * 带上 `attempt` 是刻意的：改派会让代数递增，于是新一次派发拿到**新通道**，
 * 旧执行者的迟到兑现不可能满足新执行者的等待（与任务板上的代数闸同一道理）。
 */
export function channelId(teamId: string, taskId: string, attempt: number): string {
  return `${teamId}:${taskId}:${attempt}`
}

/** `@lumo/mailbox` 的 `MailboxSeam` 结构等价子集。 */
export interface MailboxSeamLike {
  create(futureId: string, realm: string, ttlMs: number): Promise<unknown>
  resolve(futureId: string, value: unknown): Promise<{ status: string }>
  reject(futureId: string, error: string): Promise<{ status: string }>
  wait(futureId: string, timeoutMs?: number): Promise<CourierWait>
  /** 非阻塞查既有记录。不存在返回 undefined。 */
  poll(futureId: string): Promise<{ state: string } | undefined>
}

/** 默认等待有效期：够覆盖一轮成员 turn，又不至于把卡住藏过夜。 */
export const DEFAULT_CHANNEL_TTL_MS = 15 * 60_000

/**
 * 集群形态：直接委托 `@lumo/mailbox`。
 *
 * 持久、带 TTL、带死信对账，跨节点跨时间成立 —— 团队不因某个成员在别的节点上、
 * 或 planner 中途重启而丢会合点。
 */
export class MailboxCourier implements TeamCourier {
  readonly durable = true

  constructor(
    private readonly mailbox: MailboxSeamLike,
    private readonly realm: string,
  ) {}

  open(channelId: string, ttlMs: number): Promise<void> {
    return this.mailbox.create(channelId, this.realm, ttlMs).then(() => undefined)
  }

  async settle(channelId: string, value: unknown): Promise<CourierSettle> {
    const outcome = await this.mailbox.resolve(channelId, value)
    return normalizeSettle(outcome.status)
  }

  async fail(channelId: string, error: string): Promise<CourierSettle> {
    const outcome = await this.mailbox.reject(channelId, error)
    return normalizeSettle(outcome.status)
  }

  await(channelId: string, timeoutMs?: number): Promise<CourierWait> {
    return this.mailbox.wait(channelId, timeoutMs)
  }

  async state(channelId: string): Promise<ChannelState> {
    const record = await this.mailbox.poll(channelId)
    if (record === undefined) return 'unknown'
    const raw = record.state
    return raw === 'pending' || raw === 'resolved' || raw === 'rejected' || raw === 'expired'
      ? raw
      : 'unknown'
  }

  /** mailbox 服务的生命周期归 `@lumo/mailbox` 插件，这里不做任何事。 */
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** 把 seam 的 `SettleOutcome` 归一成本模块的闭集。 */
function normalizeSettle(status: string): CourierSettle {
  if (status === 'settled') return { status: 'settled' }
  if (status === 'unknown') return { status: 'unknown' }
  return { status: 'already-settled' }
}

interface MemorySlot {
  state: 'pending' | 'resolved' | 'rejected' | 'expired'
  value?: unknown
  error?: string
  expiresAt: number
  /** 已开但没人等时，兑现要能立刻被后到的 `await` 读到（对齐 seam 的竞态处理）。 */
  waiters: ((outcome: CourierWait) => void)[]
}

/**
 * 单机形态：进程内会合面。
 *
 * 语义与 mailbox 对齐（同 id 幂等、首次兑现为准、TTL 到期即 `expired`、
 * 先兑现后等待也能读到值），差别只在介质 —— 因此上层的协同逻辑两种形态共用。
 */
export class MemoryCourier implements TeamCourier {
  readonly durable = false
  private readonly slots = new Map<string, MemorySlot>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  open(channelId: string, ttlMs: number): Promise<void> {
    const existing = this.slots.get(channelId)
    if (existing === undefined) {
      this.slots.set(channelId, { state: 'pending', expiresAt: this.now() + ttlMs, waiters: [] })
    }
    return Promise.resolve()
  }

  settle(channelId: string, value: unknown): Promise<CourierSettle> {
    return Promise.resolve(this.settleWith(channelId, { state: 'resolved', value }))
  }

  fail(channelId: string, error: string): Promise<CourierSettle> {
    return Promise.resolve(this.settleWith(channelId, { state: 'rejected', error }))
  }

  private settleWith(channelId: string, outcome: { state: 'resolved'; value: unknown } | { state: 'rejected'; error: string }): CourierSettle {
    const slot = this.slots.get(channelId)
    if (slot === undefined) return { status: 'unknown' }
    if (slot.state !== 'pending') return { status: 'already-settled' }
    slot.state = outcome.state
    if (outcome.state === 'resolved') slot.value = outcome.value
    else slot.error = outcome.error
    const wait = outcome.state === 'resolved'
      ? { state: 'resolved' as const, value: outcome.value }
      : { state: 'rejected' as const, error: outcome.error }
    for (const waiter of slot.waiters.splice(0)) waiter(wait)
    return { status: 'settled' }
  }

  await(channelId: string, timeoutMs?: number): Promise<CourierWait> {
    const slot = this.slots.get(channelId)
    if (slot === undefined) {
      return Promise.resolve({ state: 'expired', error: `等待项 ${channelId} 不存在` })
    }
    const immediate = this.terminalOf(slot)
    if (immediate !== undefined) return Promise.resolve(immediate)

    const now = this.now()
    // 调用方 timeout 与该项 TTL 取更早者 —— 与 seam 契约同训。
    const deadline = timeoutMs === undefined
      ? slot.expiresAt
      : Math.min(slot.expiresAt, now + timeoutMs)

    return new Promise<CourierWait>((resolve) => {
      const finish = (outcome: CourierWait): void => {
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        const index = slot.waiters.indexOf(finish)
        if (index >= 0) slot.waiters.splice(index, 1)
        // 到期即把等待项本身也推进终态，避免后到的 await 又等一轮。
        if (slot.state === 'pending') slot.state = 'expired'
        finish({ state: 'expired', error: `等待项 ${channelId} 在 ${deadline - now}ms 内未兑现` })
      }, Math.max(deadline - now, 0))
      timer.unref?.()
      slot.waiters.push(finish)
    })
  }

  /**
   * 非阻塞查状态。
   *
   * 复用 `terminalOf` 的惰性过期：过期判定只有一处，`await` 与 `state` 不会对
   * 「同一时刻是否已过期」给出不同答案。
   */
  state(channelId: string): Promise<ChannelState> {
    const slot = this.slots.get(channelId)
    if (slot === undefined) return Promise.resolve('unknown')
    return Promise.resolve(this.terminalOf(slot)?.state ?? 'pending')
  }

  /** 已是终态则给出对应返回；pending 返回 undefined。 */
  private terminalOf(slot: MemorySlot): CourierWait | undefined {
    if (slot.state === 'resolved') return { state: 'resolved', value: slot.value }
    if (slot.state === 'rejected') return { state: 'rejected', error: slot.error ?? 'rejected' }
    if (slot.state === 'expired') return { state: 'expired', error: slot.error ?? 'expired' }
    if (this.now() >= slot.expiresAt) {
      slot.state = 'expired'
      return { state: 'expired', error: 'TTL 到期' }
    }
    return undefined
  }

  close(): Promise<void> {
    for (const slot of this.slots.values()) {
      for (const waiter of slot.waiters.splice(0)) {
        waiter({ state: 'expired', error: 'courier 已关闭' })
      }
    }
    this.slots.clear()
    return Promise.resolve()
  }
}

/**
 * 按可用能力选会合面：有 `ctx.mailbox` 就用持久实现（集群），否则进程内兜底（单机）。
 */
export function createCourier(mailbox: MailboxSeamLike | undefined, realm: string): TeamCourier {
  return mailbox === undefined ? new MemoryCourier() : new MailboxCourier(mailbox, realm)
}
