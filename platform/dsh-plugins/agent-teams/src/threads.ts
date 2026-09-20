/**
 * 线程档位的运行时：把「判据」「注册表」「唤醒」三件事装成插件能用的一面。
 *
 * ## 一条线程的一生（本切片能覆盖的那一段）
 *
 * ```
 * registry.create(...)                        # 建行（idle，承载节点已定，工作目录归属已定）
 *   → runtime.suspend({threadId, round})      # arm 唤醒等待项（带 TTL）→ 状态推 awaiting
 *        ... 事件到达（人或别的 agent 兑现）…
 *   → runtime.resume({threadId, round, event})# 兑现等待项 → 状态推 running（新一轮 Run）
 *   → 承载节点丢失
 *   → runtime.nodeLost({threadId})            # 上报 → 服务端按 node_id 拦 → 标 failed
 *        ... 节点失联（不是本节点自己报的）…
 *   → runtime.awaitThreadRound({...})         # 通道与「节点失联通知」同时盯 → node-lost
 *   → runtime.reassignAfterNodeLoss({...})    # 新建 Thread + 开新一轮 Run（判据在 thread.ts）
 * ```
 *
 * 中断与失败各自有出口，且都不假装：`arm` 过的等待项 TTL 到期后进死信（§8.1），
 * 由 `reconcile()` 报到调用方；`nodeLost` 只上报（那是「谁上报」，不是「重不重派」——
 * §24.2.3(4) 把这两件事分开），重派由**协调者**经 `reassignAfterNodeLoss` 决定并执行。
 *
 * ## 为什么每个入口都先「拿能力」再干活
 *
 * 线程面依赖三样外部装配：注册表（协作服务）、节点身份、节点工作区根。任何一样缺了，
 * 对应动作都必须**响亮拒绝**而不是降级成「什么也没发生」：
 *
 * - 注册表缺失时 `suspend()` 若静默返回，现场会以为线程挂起来了，其实没有任何等待项；
 * - 节点身份缺失时 arm 出来的等待项**没有任何节点能兑现**（谁都不知道这条线程归谁），
 *   那正是 §8.1 要消灭的「永不唤醒」。
 *
 * 与 `AgentTeamsService.capabilitiesOrNull()` 同训：能力画像可查，动作缺装配即抛。
 */

import { lstat, mkdir } from 'node:fs/promises'

import type { CourierSettle, CourierWait, TeamCourier } from './courier.ts'
import {
  nodeLossPayload, planThreadReplacement, resolveThreadWorkspacePath, threadActionDecision,
  ThreadWakeRefusedError, ThreadWorkspaceError,
  type NodeLossNotice, type ReplacementRefusal, type ThreadRound, type ThreadRow, type ThreadState,
} from './thread.ts'
import { ThreadWaker, type ThreadReconcileResult, type ThreadWakeEntry } from './thread-wake.ts'
import type { ThreadRegistryLike } from './thread-registry.ts'

/** 线程面缺装配时的统一错误（调用方据此区分「没装配」与「被拒绝」）。 */
export class ThreadsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThreadsUnavailableError'
  }
}

/** 重派被拒（判据在 `planThreadReplacement`，这里只搬运结论）。 */
export class ThreadReassignRefusedError extends Error {
  constructor(readonly reason: ReplacementRefusal, readonly detail: string) {
    super(`拒绝重派：${reason}（${detail}）`)
    this.name = 'ThreadReassignRefusedError'
  }
}

/** 重派撞上注册表的冲突（新 id / 新会话已被占用）：重派已经发生过一次。 */
export class ThreadReassignConflictError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ThreadReassignConflictError'
  }
}

/**
 * 一轮 Run 的执行面（§24.2.2：一轮 = 一个 Run）。
 *
 * 抽成接口是为了让「重派」这一动作在**不启 dsh 运行时**的前提下可测：判据（该不该重派、
 * 新一轮是什么形状）全在纯函数里，本接口只负责把那一轮真的跑起来。生产装配是
 * `roster.dispatchMember`（集群形态下 provider 是 `lumo-remote` → Scheduler 放置到承载节点），
 * 单机形态是进程内 `spawn`——**同一份代码，形态差异只在装配层**。
 */
export interface ThreadRoundRunner {
  start(input: {
    /** 新一轮承载的线程行（**新建的**那条，不是失败的那条）。 */
    thread: ThreadRow
    round: ThreadRound
    /** 这一轮要做什么（协调者的路由决策内容）。 */
    prompt: string
    parent: unknown
    signal: AbortSignal
  }): Promise<{ runId: string }>
}

/** 一次重派的结果。 */
export interface ThreadReassignResult {
  /** 新建的线程行（`failed` 的那条**不会被改动**：终态不可复活）。 */
  thread: ThreadRow
  /** 新一轮的 Run 身份（代数 = 上一轮 + 1）。 */
  round: ThreadRound
  /** 执行面给出的子 Run 身份（§23.4 的证据链一级跳转目标）。 */
  runId: string
}

/** 等一轮唤醒时的返回（`node-lost` 是本切片新加的一档，见 `awaitThreadRound`）。 */
export type ThreadAwaitOutcome =
  | { state: 'resolved'; value: unknown }
  | { state: 'rejected'; error: string }
  | { state: 'expired'; error: string }
  | { state: 'node-lost'; notice: NodeLossNotice; channel: string; ttlMs: number }

/** 线程面当前的能力画像（进 `status`，运维一眼看出缺了什么）。 */
export interface ThreadsCapabilities {
  /** 注册表是否装配（false = 读不到行，全部动作拒绝）。 */
  registry: boolean
  /** 会合面是否持久（false = 进程内兜底，重启丢等待项）。 */
  durableWake: boolean
  /** 本节点身份是否可用（false = 不能主张任何线程归自己唤醒）。 */
  nodeIdentity: boolean
  /** 工作目录根是否配置（false = 不能解析、更不能物化线程的工作目录）。 */
  workspace: boolean
  /** 一轮 Run 的执行面是否可用（false = 能读能唤醒，但重派不了）。 */
  roundRunner: boolean
}

/** 通知轮询间隔缺省值（见 `awaitThreadRound`：通知只降低延迟，轮询才是正确性来源）。 */
const DEFAULT_NOTICE_POLL_MS = 2_000
/** 等一轮唤醒的缺省上限。与唤醒等待项的默认 TTL 同量级，见 `thread.ts`。 */
const DEFAULT_AWAIT_TIMEOUT_MS = 10 * 60_000
/** 每次拉通知的条数上限（有界：一个节点掉线时会有成批通知，一次全拉会把消息面撑爆）。 */
const NOTICE_SCAN_LIMIT = 100

/** 构造参数。 */
export interface ThreadsRuntimeOptions {
  /**
   * 会合面**解析器**（唤醒）。集群形态是 `@lumo/mailbox`（PG），单机是进程内兜底；
   * 用解析器而不是实例的理由见 `thread-wake.ts` 的 `resolveCourier`。
   */
  resolveCourier: () => TeamCourier
  /**
   * 注册表**解析器**（线程行的唯一写入方 = 协作服务）。
   *
   * 与 `resolveCourier` 同一条理由：地址的来源（显式配置？服务发现？）不由本插件决定，
   * 构造时快照一次会把「地址晚一步可用」永久固化成「线程面不可用」——而线程面的能力画像
   * 会一直报 `registry: false`，现场先去怀疑协作服务挂了。用解析器还留出了接服务发现的
   * 位置（见报告：本仓库今天没有「按服务名解析基址」的既有模式，所以**没有**新造一套）。
   */
  resolveRegistry: () => ThreadRegistryLike | undefined
  /** 本节点身份。空 = 线程面不可用（fail-closed）。 */
  nodeId: string
  /** 本节点工作区根（绝对路径）。缺省 = 工作目录不可解析。 */
  workspaceRoot?: string
  /**
   * 一轮 Run 的执行面**解析器**（重派用）。缺省/解析不到 = 重派拒绝。
   *
   * 同样是解析器而不是实例：执行面来自 `subagents`（挂载顺序不由本插件决定），
   * 快照一个「有/没有」的布尔会把「晚一步挂上」固化成一个永远为假的**能力画像**——
   * 而能力画像是运维判断「重派为什么不可用」的唯一入口。
   */
  resolveRunner?: () => ThreadRoundRunner | undefined
  defaultWakeTtlMs?: number
  /** 通知轮询间隔（毫秒）。缺省 2s：唤醒延迟与协作服务压力之间的折中。 */
  noticePollMs?: number
  warn?: (message: string) => void
}

/** 一次 `suspend` 的结果。 */
export interface ThreadSuspendResult {
  channel: string
  ttlMs: number
  thread: ThreadRow
}

/** 线程运行时。 */
export class ThreadsRuntime {
  private readonly waker: ThreadWaker
  private readonly nodeId: string
  private readonly workspaceRoot: string | undefined
  private readonly resolveRegistry: () => ThreadRegistryLike | undefined
  private readonly resolveRunner: () => ThreadRoundRunner | undefined
  private readonly noticePollMs: number
  private readonly warn: (message: string) => void

  constructor(options: ThreadsRuntimeOptions) {
    this.waker = new ThreadWaker({
      resolveCourier: options.resolveCourier,
      ...options.defaultWakeTtlMs === undefined ? {} : { defaultTtlMs: options.defaultWakeTtlMs },
      ...options.warn === undefined ? {} : { warn: options.warn },
    })
    this.nodeId = options.nodeId
    this.workspaceRoot = options.workspaceRoot
    this.resolveRegistry = options.resolveRegistry
    this.resolveRunner = options.resolveRunner ?? (() => undefined)
    this.noticePollMs = options.noticePollMs !== undefined && options.noticePollMs > 0
      ? Math.floor(options.noticePollMs)
      : DEFAULT_NOTICE_POLL_MS
    this.warn = options.warn ?? (() => {})
  }

  /** 能力画像。 */
  capabilities(): ThreadsCapabilities {
    return {
      registry: this.resolveRegistry() !== undefined,
      durableWake: this.waker.durable,
      nodeIdentity: this.nodeId.trim() !== '',
      workspace: this.workspaceRoot !== undefined && this.workspaceRoot.trim() !== '',
      // 执行面独立成一项：只有注册表、没有执行面的节点能读线程、能被唤醒，但**重派不了**
      // （重派要真的把新一轮跑起来）。不报出来，现场会以为重派已经成功。
      roundRunner: this.resolveRunner() !== undefined,
    }
  }

  /** 注册表（未装配即抛）。 */
  private requireRegistry(): ThreadRegistryLike {
    const registry = this.resolveRegistry()
    if (registry === undefined) {
      throw new ThreadsUnavailableError(
        '线程注册表未装配（未配置/解析不到协作服务地址）：读不到线程行，也无法请求状态变更',
      )
    }
    return registry
  }

  /** 执行面（未装配即抛）：没有它，重派只能停在一行状态正常的记录上。 */
  private requireRunner(): ThreadRoundRunner {
    const runner = this.resolveRunner()
    if (runner === undefined) {
      throw new ThreadsUnavailableError(
        '本节点没有一轮 Run 的执行面（成员 provider 未装配）：重派需要真的把新一轮跑起来，否则只是造出一行永远不动的记录',
      )
    }
    return runner
  }

  /**
   * 读一条线程行。
   *
   * 不存在的行返回 `undefined`（不是异常）：调用方需要能分清「这条线程不在本 realm」
   * 与「协作服务读不到」——两者的处置相反（前者别再重试，后者千万别动）。
   */
  getThread(threadId: string): Promise<ThreadRow | undefined> {
    return this.requireRegistry().get(threadId)
  }

  /**
   * 建一条线程行（`idle`；工作目录缺省按 `thread/<id>/` 派生）。
   *
   * 状态不接受调用方给：新建必须是 `idle`（一个一出生就 `running` 的行会让看板把「还没放
   * 上去」显示成「在执行」），这条判据在协作服务侧（唯一写入方），这里只搬参数。
   */
  createThread(input: {
    id: string
    projectId: string
    taskId: string
    sessionRef: string
    nodeId: string
    coordinatorSessionRef: string
    workspace?: string
  }): Promise<ThreadRow> {
    return this.requireRegistry().create({
      id: input.id,
      project_id: input.projectId,
      task_id: input.taskId,
      session_ref: input.sessionRef,
      node_id: input.nodeId,
      coordinator_session_ref: input.coordinatorSessionRef,
      ...input.workspace === undefined ? {} : { workspace: input.workspace },
    })
  }

  /** 列本 realm 的线程行（有界；`state` 闭集外由服务端拒，不返回空集）。 */
  listThreads(query?: { projectId?: string; state?: ThreadState; limit?: number }): Promise<ThreadRow[]> {
    return this.requireRegistry().list({
      ...query?.projectId === undefined ? {} : { project_id: query.projectId },
      ...query?.state === undefined ? {} : { state: query.state },
      ...query?.limit === undefined ? {} : { limit: query.limit },
    })
  }

  /**
   * 请求一次状态变更（合法边由服务端判定，判据在协作服务的 domain 层——**不在**这里）。
   *
   * 本方法刻意不做「先读再判再写」：那种写法在并发下会把两个写者都放行（读到的都是旧状态），
   * 而服务端的 CAS 才是唯一能拒绝第二次写入的地方。
   */
  transitionThread(threadId: string, to: ThreadState): Promise<ThreadRow> {
    return this.requireRegistry().transition(threadId, to)
  }

  /**
   * 把线程挂起：**先 arm 唤醒等待项，再推状态**。
   *
   * 顺序是硬的（与 §8.1 的「resolve 先于 wait」是同一类竞态）：状态先变成 `awaiting`
   * 再 arm，中间那一小段里到达的事件会**没有等待项可兑现**，于是那条线程永远停在
   * awaiting 上等一个已经发生过的事件。
   *
   * 中途失败的处理：arm 成功而状态没推上去时，**不做补偿**（不 close 等待项）。
   * 等待项有 TTL，到期自己进死信；为它加一条「回滚」路径只会多一段可能出错的代码，
   * 而后果一样是「一个到期的等待项」。这里留一条告警让人看见。
   */
  async suspend(input: { threadId: string; round: ThreadRound; ttlMs?: number }): Promise<ThreadSuspendResult> {
    const registry = this.requireRegistry()
    const thread = await registry.get(input.threadId)
    if (thread === undefined) {
      throw new ThreadsUnavailableError(`线程 ${input.threadId} 不存在（或不在本 realm），无法挂起`)
    }
    const decision = threadActionDecision({
      thread, nodeId: this.nodeId, round: input.round, action: 'suspend',
    })
    if (!decision.allow) {
      throw new ThreadWakeRefusedError(decision.reason, decision.detail)
    }
    const armed = await this.waker.arm(input.threadId, input.round, input.ttlMs)
    try {
      const updated = await registry.transition(input.threadId, 'awaiting')
      return { channel: armed.channel, ttlMs: armed.ttlMs, thread: updated }
    } catch (error: unknown) {
      this.warn(
        `agent-teams: 线程 ${input.threadId} 的唤醒等待项 ${armed.channel} 已建立，但状态未能推到 awaiting：`
        + `${error instanceof Error ? error.message : String(error)}（等待项会在 TTL 到期后进死信，无需人工清理）`,
      )
      throw error
    }
  }

  /**
   * 唤醒线程：兑现等待项 → 推出新一轮 Run（状态回 `running`）。
   *
   * 等待项不存在（`unknown`）时**拒绝**而不是照常推状态：那意味着这条线程在
   * `awaiting` 上却没有等待项（状态被谁推过头了，或等待项已被清理），推它上 running
   * 会把「一次没人等的唤醒」伪装成「一轮正常的续跑」——而这一轮的成本会被记在
   * §14 判据 10 的 wake 归因上，追不回来。
   */
  async resume(input: { threadId: string; round: ThreadRound; event: unknown }): Promise<{ settled: CourierSettle; thread: ThreadRow }> {
    const registry = this.requireRegistry()
    const thread = await registry.get(input.threadId)
    if (thread === undefined) {
      throw new ThreadsUnavailableError(`线程 ${input.threadId} 不存在（或不在本 realm），无法唤醒`)
    }
    const decision = threadActionDecision({
      thread, nodeId: this.nodeId, round: input.round, action: 'wake',
    })
    if (!decision.allow) {
      throw new ThreadWakeRefusedError(decision.reason, decision.detail)
    }
    const settled = await this.waker.wake(input.threadId, input.round, input.event)
    if (settled.status === 'unknown') {
      throw new ThreadsUnavailableError(
        `线程 ${input.threadId} 的唤醒等待项不存在（第 ${input.round.attempt} 轮）：这次唤醒没有等待方，不得据此推进状态`,
      )
    }
    const updated = await registry.transition(input.threadId, 'running')
    return { settled, thread: updated }
  }

  /**
   * 上报承载节点丢失（**不迁移**）。
   *
   * 服务端按 `node_id` 拦：拿别的节点名关不掉这条线程。这里的返回行是 `failed` 的线程，
   * 而「重派新 Run」不在这里 —— 那是调度与治理侧的动作，本切片不碰。
   */
  async nodeLost(threadId: string): Promise<ThreadRow> {
    const registry = this.requireRegistry()
    if (this.nodeId.trim() === '') {
      throw new ThreadsUnavailableError('本节点没有身份，无法上报节点丢失（不知道自己是哪个节点）')
    }
    return registry.nodeLoss(threadId, this.nodeId)
  }

  /**
   * 对账：把进过等待的线程分桶（§8.1 的第三条纪律）。
   *
   * 只读、不改状态：`stranded` 的处置（上报还是按新 Run 重派）要由协调者决定 ——
   * 自动改状态会把「一次没人应答的等待」写成「承载节点丢失」，而两者的后续动作不同。
   */
  reconcile(entries: readonly ThreadWakeEntry[]): Promise<ThreadReconcileResult> {
    return this.waker.reconcile(entries)
  }

  /**
   * 解析线程在**本节点**上的工作目录（绝对路径）。
   *
   * **不创建目录**（见 `thread.ts`：物化要 Provisioner 按制品 digest 铺内容，本切片不做）。
   */
  workspacePath(thread: ThreadRow): string {
    if (this.workspaceRoot === undefined || this.workspaceRoot.trim() === '') {
      throw new ThreadsUnavailableError(
        '本节点未配置工作区根：线程的工作目录无从解析（工作目录是节点局部事实，不能靠猜）',
      )
    }
    return resolveThreadWorkspacePath(this.workspaceRoot, thread.workspace)
  }

  /** 等一次唤醒（挂起点；`expired` 是正常返回，见 `thread-wake.ts`）。 */
  waitWake(threadId: string, round: ThreadRound, timeoutMs?: number): Promise<CourierWait> {
    return this.waker.wait(threadId, round, timeoutMs)
  }

  // ─────────────────── 工作目录物化（§24.3.2） ───────────────────

  /**
   * 在**本承载节点**上为线程建出它的独立工作目录。
   *
   * ## 为什么这一步必须有人做，而它「不产生任何模型可见的状态」
   *
   * §24.3.2 的目录是线程的**现场**：一个不被别的线程踩的文件系统位置。它由承载节点本地
   * 创建，**绝不进复制日志**——目录不是模型可见状态，与 §7.1 判定的句柄型 seam 同训
   * （把一份只在某台机器上成立的路径写进所有节点都读的日志里，读的一方会以为那是它自己的
   * 路径，而「不假装可迁移」在数据面上当场破功）。所以本方法只做 `mkdir`，不写任何日志、
   * 不登记任何东西：线程行里的 `workspace` 才是那条跨节点可见的事实。
   *
   * ## 三条从严的判法
   *
   * 1. **路径只能由 `resolveThreadWorkspacePath` 给出**（相对节点工作区根、解析后仍在根内）。
   *    绝对路径一律拒，这一条在 `thread.ts` 里，**不放宽**：绝对路径是节点局部事实。
   * 2. **已存在必须是目录，且不能是符号链接**。符号链接会让线程的目录指向根之外（或指向
   *    另一个线程的目录），而两边的记录都自洽——正是「路径归属」要挡的形状。已存在且是
   *    目录 = 正常（重试、重复物化），返回 `created: false`。
   * 3. **权限 0700**：工作目录里会有工作区产物，同节点的其他用户没有理由读它。
   *
   * 失败即抛（不吞）：调用方据此决定这一轮能不能开——一个「以为目录已经好了」的执行者
   * 会把产出写到别处，而那是查不出来的。
   */
  async materializeWorkspace(thread: ThreadRow): Promise<{ path: string; created: boolean }> {
    const path = this.workspacePath(thread)
    const existing = await lstatOrUndefined(path)
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) {
        throw new ThreadWorkspaceError(
          `线程 ${thread.id} 的工作目录 ${path} 是符号链接：它会指向根之外（或指向另一个线程的目录），`
          + '而两边的记录都自洽——这正是路径归属要挡的形状',
        )
      }
      if (!existing.isDirectory()) {
        throw new ThreadWorkspaceError(
          `线程 ${thread.id} 的工作目录 ${path} 已存在但不是目录：它被别的东西占了，继续用会互相破坏`,
        )
      }
      return { path, created: false }
    }
    await mkdir(path, { recursive: true, mode: 0o700 })
    return { path, created: true }
  }

  // ─────────── 节点失联通知的消费（§24.2.3(4) 的「通知协调者」腿） ───────────

  /**
   * 读本 realm 的节点失联通知增量（游标 = `seq`）。
   *
   * 只读、不改状态：**「重不重派」是协调者的判断**（§24.2.3(4)：谁上报与重不重派是两件事）。
   * 本方法只把事实搬给调用方。
   */
  nodeLossNotices(query?: { since?: number; limit?: number }): Promise<NodeLossNotice[]> {
    return this.requireRegistry().nodeLossNotices(query)
  }

  /**
   * 把一条节点失联通知**投进协调者的唤醒通道**（走 mailbox，强制带 TTL）。
   *
   * 这是 §24.2.3(4) 信号链里「通知协调者」的落点，也是它**唯一合法**的落点：mailbox 的
   * 等待项由本插件持有（`@lumo/mailbox` 是它的建表方），协作服务不能越过这个边界写它。
   * 投递**不决定**任何事：载荷里带的是事实（哪个节点没了、为什么），要不要重派由协调者定。
   *
   * 顺序是 arm → settle（见 `ThreadWaker.announce`）：等待项还不存在时要先建出来，否则
   * 这次通知会落空，而协调者随后进入等待，等到 TTL 到期才靠对账发现。
   */
  async deliverNodeLossNotice(input: {
    notice: NodeLossNotice
    round: ThreadRound
    ttlMs?: number
  }): Promise<{ channel: string; ttlMs: number; settled: CourierSettle }> {
    const payload = nodeLossPayload(input.notice.thread_id, input.round, input.notice)
    return this.waker.announce(input.notice.thread_id, input.round, payload, input.ttlMs)
  }

  /**
   * 等一轮结局，**同时**盯着这条线程的节点失联通知。
   *
   * ## 为什么不能只等唤醒通道
   *
   * 承载节点失联时，**没有任何人会去兑现那个等待项**——死掉的节点没法兑现，而协作服务
   * 写不了 mailbox。协调者若只等通道，只会在 TTL 到期时拿到 `expired`，把一个明确的事实
   * （「现场没了」）退化成一句「没人应答」。两者的处置完全不同：前者要**新建 Thread 重派**，
   * 后者只要重跑一轮（§7.1 R2：不可恢复 ≠ 可重试）。
   *
   * ## 为什么是「竞争」而不是「先等再查」
   *
   * 通知落在协作服务里（append-only，不会丢），所以**轮询就是正确性来源**（§8.1 第三条
   * 纪律：通知只降低延迟）。这里两边同时推进：通道先兑现就返回事件结局；通知先到就把
   * 它投进通道（`deliverNodeLossNotice`，于是**它也被持久化**——后到的等待者读到同一个
   * 事实），并把 `node-lost` 作为独立的一档返回。
   *
   * 轮询读不到通知时**只告警不失败**：读不到 ≠ 没有。让等待因为它而失败，等于把一次
   * 协作服务的抖动变成一次假的重派。
   */
  async awaitThreadRound(input: {
    threadId: string
    round: ThreadRound
    timeoutMs?: number
    pollMs?: number
  }): Promise<ThreadAwaitOutcome> {
    const registry = this.requireRegistry()
    const timeoutMs = input.timeoutMs !== undefined && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : DEFAULT_AWAIT_TIMEOUT_MS
    const pollMs = input.pollMs !== undefined && input.pollMs > 0 ? Math.floor(input.pollMs) : this.noticePollMs
    // 先**看一次**通知，再进竞争：通知可能早就落库了（协调者是在它之后才开始等的），
    // 而「通道还没 arm」时 `wait` 会立刻返回 `expired`（等待项不存在）——两者竞争时那个
    // 立刻返回的 expired 会**盖住**一条已经到达的失联通知，把「现场没了」降级成「没人应答」。
    const known = await this.readNodeLossNotice(input.threadId, registry, this.warn)
    if (known !== undefined) {
      const delivered = await this.deliverNodeLossNotice({ notice: known, round: input.round })
      return { state: 'node-lost', notice: known, channel: delivered.channel, ttlMs: delivered.ttlMs }
    }
    let watching = true
    const wake = this.waker.wait(input.threadId, input.round, timeoutMs)
    // 「通知先到」时唤醒等待仍在飞：给它挂一个空 catch，免得它稍后成为未处理的 rejection
    // （进程级的 unhandledRejection 会按配置把进程带走，而这里只是一次被抢先的等待）。
    wake.catch(() => undefined)
    const noticeWatch = this.watchNodeLoss(input.threadId, {
      pollMs, timeoutMs, stopped: () => !watching, registry,
    })
    try {
      const first = await Promise.race([
        wake.then((outcome): { kind: 'wake'; outcome: CourierWait } => ({ kind: 'wake', outcome })),
        noticeWatch.then((notice): { kind: 'notice'; notice: NodeLossNotice | undefined } => ({ kind: 'notice', notice })),
      ])
      if (first.kind === 'wake') return first.outcome
      if (first.notice === undefined) return await wake
      const delivered = await this.deliverNodeLossNotice({ notice: first.notice, round: input.round })
      return {
        state: 'node-lost',
        notice: first.notice,
        channel: delivered.channel,
        ttlMs: delivered.ttlMs,
      }
    } finally {
      watching = false
    }
  }

  /** 轮询这条线程的节点失联通知，直到命中、超时、或调用方喊停。 */
  private async watchNodeLoss(threadId: string, opts: {
    registry: ThreadRegistryLike
    pollMs: number
    timeoutMs: number
    stopped: () => boolean
  }): Promise<NodeLossNotice | undefined> {
    const deadline = Date.now() + opts.timeoutMs
    let warned = false
    // 轮询里的失败**只告警一次**：每 2 秒重复同一句会把日志刷满，而它要说的始终是同一件事。
    const warnOnce = (message: string): void => {
      if (warned) return
      warned = true
      this.warn(message)
    }
    while (!opts.stopped()) {
      const mine = await this.readNodeLossNotice(threadId, opts.registry, warnOnce)
      if (mine !== undefined) return mine
      const remaining = deadline - Date.now()
      if (remaining <= 0 || opts.stopped()) return undefined
      await sleep(Math.min(opts.pollMs, remaining))
    }
    return undefined
  }

  /**
   * 读一次这条线程的失联通知。
   *
   * **读不到 ≠ 没有**：失败时告警并返回 `undefined`（等待本身的 TTL 仍在兜底）。若在这里抛，
   * 一次协作服务抖动就会让协调者得出「这一轮没结论」的错误结论——而它的处置（再等一次）
   * 与真正该做的（新建线程重派）完全不同。
   */
  private async readNodeLossNotice(
    threadId: string,
    registry: ThreadRegistryLike,
    warn: (message: string) => void,
  ): Promise<NodeLossNotice | undefined> {
    try {
      const notices = await registry.nodeLossNotices({ limit: NOTICE_SCAN_LIMIT })
      return notices.find(notice => notice.thread_id === threadId)
    } catch (error: unknown) {
      warn(
        `agent-teams: 读线程 ${threadId} 的节点失联通知失败，继续等待唤醒通道：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  // ─────────────────── 重派的实际动作（§24.2.3(4) 的最后一腿） ───────────────────

  /**
   * 节点失联后的重派：**新建 Thread + 开新一轮 Run**（§24.2.2：一轮 = 一个 Run）。
   *
   * ## 三步，顺序是硬的
   *
   * 1. **判据**（`planThreadReplacement`，纯函数）：失败的那条线程才能重派、新节点不能是刚丢
   *    的那个、新会话不能复用旧 ref。判据不通过就抛，**不落任何副作用**。
   * 2. **建行**（注册表 = `threads` 的唯一写入方）：新线程是 `idle`，`session_ref` / `node_id` /
   *    `workspace` 全新。旧的那条 `failed` 行**一个字节都不改**——终态不可复活（§24.2.1）。
   * 3. **开跑**（执行面）：把新一轮交给 `runner`（生产是 `roster.dispatchMember`，集群形态下
   *    provider 为 `lumo-remote` → Scheduler 放置到承载节点）。
   *
   * 为什么不把 2、3 合成一步（先跑起来再登记）：**没有登记的执行者是不可见的**——它占着
   * 一台机器、烧着配额，而注册表里没有任何一行提到它，于是没有任何一处（看板、对账、预算）
   * 能发现它。反过来的代价小得多：建行成功而开跑失败时，线程停在一行 `idle` 上，看得见、可重试。
   *
   * ## 幂等
   *
   * 同一个失败线程的第二次重派会派生出**同一个新 id**（`replacementThreadId`），于是撞上
   * 注册表的主键冲突并被翻译成 `ThreadReassignConflictError`——重复的重派看得见，而不是
   * 悄悄造出两条并行跑同一份工作的线程。
   */
  async reassignAfterNodeLoss(input: {
    /** 失败的那条线程行（通常是 `awaitThreadRound` 拿到 `node-lost` 之后读回来的）。 */
    thread: ThreadRow
    /** 上一轮的 Run 身份（新一轮代数 = 它 + 1）。 */
    previousRound: ThreadRound
    /** 协调者选定的**新**承载节点。 */
    newNodeId: string
    /** 新会话 ref（必须是新的，见判据）。 */
    newSessionRef: string
    /** 这一轮要做什么。 */
    prompt: string
    newThreadId?: string
    parent?: unknown
    signal?: AbortSignal
    ttlMs?: number
  }): Promise<ThreadReassignResult> {
    const decision = planThreadReplacement({
      thread: input.thread,
      previousRound: input.previousRound,
      newNodeId: input.newNodeId,
      newSessionRef: input.newSessionRef,
      ...input.newThreadId === undefined ? {} : { newThreadId: input.newThreadId },
    })
    if (!decision.allow) {
      throw new ThreadReassignRefusedError(decision.reason, decision.detail)
    }
    const runner = this.requireRunner()
    const registry = this.requireRegistry()
    const { thread: plan, round } = decision.plan
    let created: ThreadRow
    try {
      created = await registry.create({
        id: plan.id,
        project_id: plan.project_id,
        task_id: plan.task_id,
        coordinator_session_ref: plan.coordinator_session_ref,
        session_ref: plan.session_ref,
        node_id: plan.node_id,
        workspace: plan.workspace,
      })
    } catch (error: unknown) {
      const status = (error as { status?: unknown }).status
      if (status === 409) {
        throw new ThreadReassignConflictError(
          `重派 ${input.thread.id} 撞上注册表冲突（新线程 ${plan.id} 已存在或新会话已被占用）：`
          + `这次重派多半已经发生过一次（同一个失败线程的第二次重派会算出同一个新 id）——`
          + `先读回 ${plan.id} 看它是不是已经在跑。原始错误：${error instanceof Error ? error.message : String(error)}`,
          typeof status === 'number' ? status : undefined,
        )
      }
      throw error
    }
    const started = await runner.start({
      thread: created,
      round,
      prompt: input.prompt,
      parent: input.parent,
      signal: input.signal ?? new AbortController().signal,
    })
    return { thread: created, round, runId: started.runId }
  }
}

/** `lstat`，不存在返回 `undefined`（其余错误照抛：权限问题不该被当成「不存在」）。 */
async function lstatOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined
    throw error
  }
}

/** 轮询间隔用（可被 `unref`，不拖住进程退出）。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
