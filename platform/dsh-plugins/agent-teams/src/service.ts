/**
 * @lumo/agent-teams 的编排服务 —— §7.3 的 `ctx.agentTeams` 本体。
 *
 * 三层组装：
 *   roster（谁能执行、在哪执行）× task board（做什么、依赖谁）× courier（怎么会合）
 *
 * ## 一次「多智能体执行」的完整形状
 *
 * ```
 * runRound(teamId)
 *   ├─ 读团队状态 → 前沿 = 依赖已齐且未指派给别人的任务
 *   ├─ 对每条前沿任务：claim（在写链内，防两个成员抢同一条）
 *   └─ 并行派发（provider 由 roster 探测决定：单机进程内 / 集群远端）
 *        └─ 写回：complete / fail（带 attempt 代数，拒绝迟到写回）
 * ```
 *
 * ## 为什么把依赖结果塞进成员 prompt
 *
 * 成员是 **one-shot 子代理**：它看不到团队状态，也没有上一轮的上下文（dsh 的
 * `spawn` provider `inheritsParentContext = false`）。所以上游任务的 `output` 必须由
 * 派发方**显式带进 prompt**，否则流水线拓扑里下游成员等于在盲跑。这是把
 * agent-teams 的「continuable 成员共享上下文」换成 one-shot 之后必须补上的一环。
 */

import {
  addMember,
  addTasks,
  blockersOf,
  claimableBy,
  claimTask,
  cancelTask,
  completeTask,
  createTeam,
  failTask,
  isSettled,
  memberByName,
  reassignTask,
  removeMember,
  requeueTask,
  seedTasks,
  startTask,
  taskById,
  TeamError,
  teamProgress,
  type NewTaskInput,
  type TeamMember,
  type TeamProgress,
  type TeamState,
  type Topology,
} from './model.ts'
import {
  dispatchMember,
  type MemberOutcome,
  type MemberProviderChoice,
  type MemberSeam,
} from './roster.ts'
import { assertTeamId, type AgentTeamStore } from './store.ts'
import { channelId, DEFAULT_CHANNEL_TTL_MS, type CourierWait, type TeamCourier } from './courier.ts'

/** 服务装配时确定的能力画像（进 `status`，运维一眼看出当前形态）。 */
export interface AgentTeamsCapabilities {
  /** 成员 provider 及其选择依据。 */
  provider: MemberProviderChoice
  /** 团队状态是否持久（false = 内存兜底，重启即丢）。 */
  durableStore: boolean
  /** 会合面是否持久（false = 进程内兜底）。 */
  durableCourier: boolean
}

/** 一条任务的一次派发结果。 */
export interface TaskDispatchResult {
  taskId: string
  member: string
  ok: boolean
  /** 写回任务的文本。 */
  text: string
  stopReason: string
  diagnostic?: string
}

/** 一轮调度的汇总。 */
export interface RoundResult {
  teamId: string
  dispatched: TaskDispatchResult[]
  /** 本轮结束后仍可继续推进（还有前沿任务）。 */
  more: boolean
  /** 全部任务到达终态。 */
  settled: boolean
  progress: TeamProgress
}

/** 对账结果。三个桶互斥，合起来是全部执行中的任务。 */
export interface ReconcileResult {
  /** 通道已死 → 已退回待认领，可被重新派发。 */
  requeued: string[]
  /** 通道仍是 `pending` → 成员还在跑。 */
  running: string[]
  /** 通道已兑现 → 结局已落盘，只等写回。 */
  settling: string[]
}

/** 团队成员上限的默认值：再多人也协调不过来，反而把上下文撑爆。 */
export const DEFAULT_MAX_MEMBERS = 8

/** 成员执行面：一个可用的 `seam` 与它选定的 provider。 */
export interface MemberSurface {
  seam: MemberSeam
  provider: MemberProviderChoice
}

/** 服务构造参数。三个协作者都是**解析器**而不是实例，理由见类注释。 */
export interface AgentTeamsServiceOptions {
  /** 存储解析器。 */
  resolveStore: () => { store: AgentTeamStore; durable: boolean }
  /** 会合面解析器。 */
  resolveCourier: () => TeamCourier
  /** 成员执行面解析器。返回 `undefined` 表示当前形态不能派发（只读用法仍可用）。 */
  resolveSeam?: () => MemberSurface | undefined
  maxMembers?: number
  /** 时钟注入，测试用。 */
  now?: () => number
  /** 告警出口。 */
  warn?: (message: string) => void
}

/**
 * 团队编排服务。所有对团队状态的修改都经 {@link mutate}，从而在同一团队的写链上
 * 串行执行 —— 这是「两个成员同时认领/写回不互相覆盖」的唯一保证。
 *
 * ## 写链为什么挂在这里，而不是某个 store 实现里
 *
 * `KvUnit` 契约明说「the unit does NOT serialize concurrent writes — write ordering
 * is the caller's responsibility」，而**调用方就是本服务**。把链条放进
 * `StorageHubTeamStore` 曾经是个真实的 bug：`mutate` 只对那一个实现走链条，
 * 内存兜底存储（以及任何未来的存储实现）退化成无保护的读-改-写 ——
 * 两个成员并行写回时后写的覆盖先写的，任务永久停在 `claimed`。
 *
 * 所以链条是**服务**的协调不变量：换介质不该让这条保证失效。
 *
 * ## 为什么三个协作者都是解析器而不是实例
 *
 * `storage` / `mailbox` / `subagents` 的挂载顺序**不由本插件决定** —— 装配时它们
 * 可能还没 `provide`。构造时快照一次会把「storage 晚一步挂上」永久固化成内存兜底
 * 存储（团队重启即丢，却看起来一切正常）。所以按需解析：每次用到时再问一遍，
 * 「更早」与「更晚」两种顺序都成立。
 */
export class AgentTeamsService {
  private readonly now: () => number
  private readonly maxMembers: number
  private readonly warn: (message: string) => void
  /** 每个团队 id 一条串行写链。 */
  private readonly writeChains = new Map<string, Promise<unknown>>()

  constructor(private readonly options: AgentTeamsServiceOptions) {
    this.now = options.now ?? (() => Date.now())
    this.maxMembers = options.maxMembers ?? DEFAULT_MAX_MEMBERS
    this.warn = options.warn ?? (() => {})
  }

  private get store(): AgentTeamStore {
    return this.options.resolveStore().store
  }

  private get courier(): TeamCourier {
    return this.options.resolveCourier()
  }

  /** 成员执行面；当前形态不能派发时为 undefined。 */
  private memberSurface(): MemberSurface | undefined {
    return this.options.resolveSeam?.()
  }

  /** 当前能力画像。未装配成员执行面时抛 —— 供**装配期自检**用。 */
  capabilities(): AgentTeamsCapabilities {
    const capabilities = this.capabilitiesOrNull()
    if (capabilities === null) {
      throw new TeamError('本装配未提供成员 provider，无法派发；只读用法不受影响', 'BAD_STATE')
    }
    return capabilities
  }

  /**
   * 能力画像；未装配成员执行面时返回 `null`。
   *
   * 状态面用这个而不是 {@link capabilities}：只读装配（没挂 subagent provider）
   * 仍然要能查团队状态，不该因为「不能派发」而连 `status` 都失败。
   */
  capabilitiesOrNull(): AgentTeamsCapabilities | null {
    const surface = this.memberSurface()
    if (surface === undefined) return null
    return {
      provider: surface.provider,
      durableStore: this.options.resolveStore().durable,
      durableCourier: this.courier.durable,
    }
  }

  /**
   * 在团队 id 的写链上排队执行。
   *
   * 前一个写失败**不毒化**后续写：链条只关心「上一个结束没」，与成败无关 ——
   * 一条被拒的写回不该让整个团队此后再也写不进去。
   */
  private chain<T>(teamId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(teamId) ?? Promise.resolve()
    const next = previous.then(run, run)
    const settled = next.then(() => undefined, () => undefined)
    this.writeChains.set(teamId, settled)
    // 链条排空后清掉表项，避免长驻进程按团队数无界增长。只清「仍是当前那一条」的，
    // 否则会把排队中新挂上的链条误删。
    void settled.then(() => {
      if (this.writeChains.get(teamId) === settled) this.writeChains.delete(teamId)
    })
    return next
  }

  /** 读-改-写（团队必须已存在）。整段在写链内，故守卫看到的永远是最新状态。 */
  private mutate(teamId: string, change: (current: TeamState) => TeamState): Promise<TeamState> {
    return this.chain(teamId, async () => {
      const current = await this.store.load(teamId)
      if (current === undefined) throw new TeamError(`团队 ${teamId} 不存在`, 'NOT_FOUND')
      const updated = change(current)
      await this.store.save(updated)
      return updated
    })
  }

  /**
   * 建团队并按拓扑铺种子任务。
   *
   * 「已存在即拒」放在写链内而不是链外先查后写：链外查会与并发建同名团队形成
   * check-then-act 竞态，两边都查到「不存在」然后互相覆盖。
   */
  async create(input: {
    id: string
    name: string
    description?: string
    topology: Topology
    subjects: readonly string[]
    captainSessionId: string
  }): Promise<TeamState> {
    // id 会当存储键（per-record 布局下是路径段），先闸住再铺任务，
    // 好过铺了一半在 save 时才炸。方法本身是 async，故非法 id 表现为 rejection。
    assertTeamId(input.id)
    return this.chain(input.id, async () => {
      if (await this.store.load(input.id) !== undefined) {
        throw new TeamError(`团队 ${input.id} 已存在`, 'DUPLICATE_TEAM')
      }
      const base = createTeam({
        id: input.id,
        name: input.name,
        ...input.description === undefined ? {} : { description: input.description },
        topology: input.topology,
        captainSessionId: input.captainSessionId,
        now: this.now(),
      })
      const seeded = addTasks(base, seedTasks(input.topology, input.subjects), this.now()).team
      await this.store.save(seeded)
      return seeded
    })
  }

  list(): Promise<TeamState[]> {
    return this.store.list()
  }

  async get(teamId: string): Promise<TeamState> {
    const team = await this.store.load(teamId)
    if (team === undefined) throw new TeamError(`团队 ${teamId} 不存在`, 'NOT_FOUND')
    return team
  }

  /** 删除也走写链：免得删掉之后一条在途的写回把团队又写回来。 */
  remove(teamId: string): Promise<void> {
    return this.chain(teamId, () => this.store.remove(teamId))
  }

  /** 加成员。provider 由 roster 探测结果落定，成员自己不选 transport。 */
  async addMember(teamId: string, member: { name: string; role?: string; model?: string; ownerUserId?: string }): Promise<TeamState> {
    const { provider } = this.capabilities()
    // 空白串按「未提供」处理：一个空白的绑定会在视图里变成一个挂不上任何人的成员，
    // 而它与「没绑定」在数据上分不开——不如在这里就归一，别把两种含义相同的写法
    // 留给下游去猜。
    const ownerUserId = member.ownerUserId?.trim()
    return this.mutate(teamId, (team) => {
      if (team.members.filter(candidate => candidate.status !== 'removed').length >= this.maxMembers) {
        throw new TeamError(`团队 ${teamId} 成员已达上限 ${this.maxMembers}`, 'BAD_STATE')
      }
      const entry: Omit<TeamMember, 'status' | 'joinedAt'> = {
        name: member.name,
        provider: provider.provider,
        ...member.role === undefined ? {} : { role: member.role },
        ...member.model === undefined ? {} : { model: member.model },
        ...ownerUserId === undefined || ownerUserId === '' ? {} : { ownerUserId },
      }
      return addMember(team, entry, this.now())
    })
  }

  removeMember(teamId: string, name: string): Promise<TeamState> {
    return this.mutate(teamId, team => removeMember(team, name, this.now()))
  }

  addTasks(teamId: string, inputs: readonly NewTaskInput[]): Promise<TeamState> {
    return this.mutate(teamId, team => addTasks(team, inputs, this.now()).team)
  }

  claim(teamId: string, taskId: string, member: string): Promise<TeamState> {
    return this.mutate(teamId, team => claimTask(team, taskId, member, this.now()))
  }

  start(teamId: string, taskId: string, member: string): Promise<TeamState> {
    return this.mutate(teamId, team => startTask(team, taskId, member, this.now()))
  }

  complete(teamId: string, taskId: string, member: string, output: string, attempt?: number): Promise<TeamState> {
    return this.mutate(teamId, team => completeTask(team, taskId, member, output, this.now(), attempt))
  }

  fail(teamId: string, taskId: string, member: string, output: string, attempt?: number): Promise<TeamState> {
    return this.mutate(teamId, team => failTask(team, taskId, member, output, this.now(), attempt))
  }

  cancel(teamId: string, taskId: string): Promise<TeamState> {
    return this.mutate(teamId, team => cancelTask(team, taskId, this.now()))
  }

  reassign(teamId: string, taskId: string, member: string): Promise<TeamState> {
    return this.mutate(teamId, team => reassignTask(team, taskId, member, this.now()))
  }

  /** 状态 + 进度。 */
  async status(teamId: string): Promise<{
    team: TeamState
    progress: TeamProgress
    settled: boolean
    capabilities: AgentTeamsCapabilities | null
  }> {
    const team = await this.get(teamId)
    return {
      team,
      progress: teamProgress(team),
      settled: isSettled(team),
      capabilities: this.capabilitiesOrNull(),
    }
  }

  /**
   * 把一条**已被认领**的任务派发给它的成员，并写回结果。
   *
   * `attempt` 来自认领那一刻：写回时带上它，若期间发生了改派（代数变了），
   * 写回会被拒 —— 这是「旧执行者的迟到结果不得覆盖新执行者」的落点。
   *
   * 派发前后各做一次会合面操作（`open` / `settle`），使这次执行**可被外部等待**
   * （见 {@link awaitTask}）并可被对账（见 {@link reconcile}）。会合面是增强，
   * 失败只告警，绝不让派发本身失败。
   */
  async dispatchClaimed(input: {
    teamId: string
    taskId: string
    member: string
    attempt: number
    parent: unknown
    signal: AbortSignal
  }): Promise<TaskDispatchResult> {
    const surface = this.memberSurface()
    if (surface === undefined) throw new TeamError('本装配未提供成员执行面', 'BAD_STATE')
    const team = await this.get(input.teamId)
    const task = taskById(team, input.taskId)
    const member = memberByName(team, input.member)
    const channel = channelId(team.id, task.id, input.attempt)
    await this.openChannel(channel)

    const outcome = await dispatchMember(surface.seam, surface.provider, {
      label: `${team.name}/${task.id}`,
      prompt: buildMemberPrompt(team, task.id, member),
      parent: input.parent,
      signal: input.signal,
      ...member.model === undefined ? {} : { agentOptions: { model: member.model } },
    })

    await this.settleChannel(channel, outcome)

    const result: TaskDispatchResult = {
      taskId: task.id,
      member: member.name,
      ok: outcome.ok,
      text: outcome.text,
      stopReason: outcome.stopReason,
      ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
    }

    // 写回。代数是硬闸：改了派就作废。
    await this.mutate(input.teamId, (current) => {
      const written = outcome.ok
        ? completeTask(current, task.id, member.name, outcome.text, this.now(), input.attempt)
        : failTask(current, task.id, member.name, outcome.text, this.now(), input.attempt)
      return written
    }).catch((error: unknown) => {
      // 写回被拒（代数不符 / 任务已被取消）不该让整轮调度炸掉，但要留痕。
      this.warn(`agent-teams: 任务 ${task.id} 的结果写回被拒：${describe(error)}`)
    })

    return result
  }

  /** 开通道。失败只告警：会合面是增强，不该让派发本身失败。 */
  private async openChannel(channel: string): Promise<void> {
    try {
      await this.courier.open(channel, DEFAULT_CHANNEL_TTL_MS)
    } catch (error: unknown) {
      this.warn(`agent-teams: 通道 ${channel} 打开失败，本次执行将不可被外部等待：${describe(error)}`)
    }
  }

  /** 兑现通道。通道不存在（`unknown`）说明它已被清理，值得留痕。 */
  private async settleChannel(channel: string, outcome: MemberOutcome): Promise<void> {
    try {
      const settled = outcome.ok
        ? await this.courier.settle(channel, outcome.text)
        : await this.courier.fail(channel, outcome.text)
      if (settled.status === 'unknown') {
        this.warn(`agent-teams: 通道 ${channel} 已不存在，等待方可能拿不到这次结局`)
      }
    } catch (error: unknown) {
      this.warn(`agent-teams: 通道 ${channel} 兑现失败：${describe(error)}`)
    }
  }

  /**
   * 等一次派发的结局 —— 走**会合面**而不是进程内的 promise。
   *
   * 与 `runRound` 内部直接 await `run.result` 的分工：后者是「本轮派发、本轮收」，
   * 前者是给「上一轮已经派发出去、或跑在别的承载节点上」的执行用的。集群形态下
   * 通道落在 PG，所以即使船长进程重启，只要成员已兑现，`awaitTask` 仍能读到结果；
   * 单机形态下它退化为进程内等待（`capabilities().durableCourier` 为 false）。
   *
   * 绝不无限等：返回 `expired` 表示该次派发没能在 TTL 内兑现，应当 `reconcile`
   * 后重试，而不是再进一次等待。
   */
  async awaitTask(input: {
    teamId: string
    taskId: string
    /** 缺省用任务当前的代数；显式给出可等待某一次特定尝试。 */
    attempt?: number
    timeoutMs?: number
  }): Promise<CourierWait> {
    const team = await this.get(input.teamId)
    const task = taskById(team, input.taskId)
    const attempt = input.attempt ?? task.attempt
    return this.courier.await(channelId(team.id, task.id, attempt), input.timeoutMs)
  }

  /**
   * 对账：把「派发者已经不在了」的任务退回待认领。
   *
   * 判据是**会合面**而不是时间戳：我们总在派发前 `open` 通道，所以一条执行中任务的
   * 通道若为 `expired`（TTL 到期）或 `unknown`（从未开过 / 已被清理），就意味着那次
   * 派发永远不会再写回 —— 进程重启、承载节点掉线都是这个形状。退回 `pending` 后即可
   * 被重新认领，团队不会永久卡在 `claimed`。
   *
   * `pending` 说明成员还在跑；`resolved`/`rejected` 说明兑现已落盘、写回在途 ——
   * 两者都不动。
   */
  async reconcile(teamId: string): Promise<ReconcileResult> {
    const team = await this.get(teamId)
    const active = team.tasks.filter(task => task.status === 'claimed' || task.status === 'in_progress')
    const requeued: string[] = []
    const running: string[] = []
    const settling: string[] = []

    for (const task of active) {
      const state = await this.courier.state(channelId(team.id, task.id, task.attempt))
      if (state === 'pending') {
        running.push(task.id)
        continue
      }
      if (state === 'resolved' || state === 'rejected') {
        settling.push(task.id)
        continue
      }
      try {
        await this.mutate(teamId, current => requeueTask(current, task.id, this.now()))
        requeued.push(task.id)
      } catch (error: unknown) {
        this.warn(`agent-teams: 任务 ${task.id} 退回待认领失败：${describe(error)}`)
      }
    }

    return { requeued, running, settling }
  }

  /**
   * 跑一轮调度：认领全部前沿任务并**并行**派发，等齐后返回。
   *
   * 并行是这套东西存在的理由（§7.3「多 worker claim」、§7.2 高并发专项）。
   * 认领在写链内串行（防抢），执行并行（要吞吐）。
   */
  async runRound(input: {
    teamId: string
    parent: unknown
    signal: AbortSignal
    /** 最多并行派发多少条；缺省不限。 */
    limit?: number
  }): Promise<RoundResult> {
    const team = await this.get(input.teamId)
    const idle = team.members.filter(member => member.status !== 'removed')
    if (idle.length === 0) {
      throw new TeamError(`团队 ${input.teamId} 没有可用成员，先加成员再跑`, 'BAD_STATE')
    }

    // 候选：依赖已齐、未指派或指派给某成员；按声明顺序取，保证可复现。
    const candidates = team.tasks.filter(task => task.status === 'pending' && blockersOf(team, task).length === 0)
    const limited = input.limit === undefined ? candidates : candidates.slice(0, input.limit)

    const claimed: { taskId: string; member: string; attempt: number }[] = []
    for (const task of limited) {
      // 已指派的按指派走；未指派的轮流分配给空闲成员（round-robin）。
      const assigned = task.assignee ?? idle[claimed.length % idle.length]!.name
      try {
        const updated = await this.mutate(input.teamId, current => claimTask(current, task.id, assigned, this.now()))
        const attempt = taskById(updated, task.id).attempt
        claimed.push({ taskId: task.id, member: assigned, attempt })
      } catch (error: unknown) {
        // 认领失败（被别人抢走 / 依赖刚被取消）不致命，跳过该条。
        this.warn(`agent-teams: 任务 ${task.id} 认领失败：${describe(error)}`)
      }
    }

    const settled = await Promise.allSettled(claimed.map(entry => this.dispatchClaimed({
      teamId: input.teamId,
      taskId: entry.taskId,
      member: entry.member,
      attempt: entry.attempt,
      parent: input.parent,
      signal: input.signal,
    })))

    const dispatched: TaskDispatchResult[] = []
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        dispatched.push(outcome.value)
        continue
      }
      const entry = claimed[index]!
      const message = describe(outcome.reason)
      this.warn(`agent-teams: 任务 ${entry.taskId} 派发失败：${message}`)
      // 基础设施故障（承载节点不可达等）：把任务退回失败态，别让它悬着。
      await this.mutate(input.teamId, current => failTask(
        current, entry.taskId, entry.member, `派发失败：${message}`, this.now(), entry.attempt,
      )).catch(() => undefined)
      dispatched.push({
        taskId: entry.taskId, member: entry.member, ok: false, text: message, stopReason: 'error',
      })
    }

    const after = await this.get(input.teamId)
    const progress = teamProgress(after)
    return {
      teamId: input.teamId,
      dispatched,
      more: progress.ready.length > 0,
      settled: isSettled(after),
      progress,
    }
  }

  /** 反复跑轮次直到收敛、无前沿、或达到轮次上限。 */
  async runToSettle(input: {
    teamId: string
    parent: unknown
    signal: AbortSignal
    maxRounds?: number
    limit?: number
  }): Promise<{ rounds: RoundResult[]; settled: boolean }> {
    const maxRounds = input.maxRounds ?? 16
    const rounds: RoundResult[] = []
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await this.runRound({
        teamId: input.teamId,
        parent: input.parent,
        signal: input.signal,
        ...input.limit === undefined ? {} : { limit: input.limit },
      })
      rounds.push(result)
      if (result.settled || !result.more) return { rounds, settled: result.settled }
    }
    this.warn(`agent-teams: 团队 ${input.teamId} 达到轮次上限 ${maxRounds} 仍未收敛`)
    const team = await this.get(input.teamId)
    return { rounds, settled: isSettled(team) }
  }

  /** 某成员此刻可认领的任务 id。 */
  async claimable(teamId: string, member: string): Promise<string[]> {
    return claimableBy(await this.get(teamId), member).map(task => task.id)
  }
}

/**
 * 构造一次成员派发的 prompt。
 *
 * 关键是把**上游任务的产出**带进去 —— one-shot 成员看不到团队状态，不带就等于让
 * 流水线下游盲跑。同时把团队的收敛条件与交付格式讲清楚，避免成员返回散文。
 */
export function buildMemberPrompt(team: TeamState, taskId: string, member: TeamMember): string[] {
  const task = taskById(team, taskId)
  const lines: string[] = [
    `你是团队「${team.name}」的成员 ${member.name}${member.role === undefined ? '' : `（角色：${member.role}）`}。`,
  ]
  if (team.description !== undefined) lines.push(`团队目标：${team.description}`)
  lines.push(`你的任务 ${task.id}：${task.subject}`)
  if (task.description !== undefined) lines.push(`任务说明：${task.description}`)

  const upstream = task.dependencies
    .map(depId => team.tasks.find(candidate => candidate.id === depId))
    .filter((dep): dep is NonNullable<typeof dep> => dep !== undefined && dep.output !== undefined && dep.output !== '')
  if (upstream.length > 0) {
    lines.push('', '上游任务的产出（供你参考，不要重复它们的结论）：')
    for (const dep of upstream) lines.push(`- ${dep.id} ${dep.subject}：\n${dep.output}`)
  }

  lines.push(
    '',
    '完成后直接给出你的结论正文，不要复述任务描述，不要写“我将要…”这类过程话术。',
    '结论会被写入团队任务板，作为下游成员的输入。',
  )
  return lines
}

/** 统一的错误取文：告警里不要出现 `[object Object]`。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
