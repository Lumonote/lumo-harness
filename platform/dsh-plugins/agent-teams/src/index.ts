/**
 * @lumo/agent-teams —— `docs/architecture.md` §7.3 的 `ctx.agentTeams`：
 * roster + 任务板(DAG) + 会合面，**一份代码同时成立在单机与集群两种部署形态上**。
 *
 * ## 为什么不用现成的两个实现
 *
 * 仓库里有（或能装到）两个「多智能体团队」实现，但都覆盖不了集群形态：
 *
 * | 实现 | 成员派发 | 为什么不行 |
 * |---|---|---|
 * | `@nanmicoder/dsh-agent-teams` 0.1.15 | `registerContinuableSetup` | 平台集群 wire（`shared/seam-contracts/subagent-host.ts`）只覆盖 one-shot spawn；且 0.1.15 调用了 master 已移除的 API，已被排除出插件基线 |
 * | `@deepseek-ai/dsh-experimental-agent-team` 0.1.5-rc.2 | `ctx.subagents.startContinuable`（`roster.ts:282`） | 同样是 continuable，且绑定 session log + projection，实验态，平台未挂载 |
 *
 * 本插件把成员建模成**可重复派发的 one-shot**（理由见 `roster.ts`），于是同一份代码
 * 在三种形态下都成立：
 *
 * | 形态 | 团队状态 | 成员在哪执行 | 会合面 |
 * |---|---|---|---|
 * | local（桌面单机） | sqlite（dsh storage hub） | 本进程 `spawn`/`fork` | 进程内 |
 * | standalone（单节点服务） | 同上 | 本进程 `spawn`/`fork` | 进程内 |
 * | cluster（`LUMO_ROLE=agent`） | PG（`@lumo/storage`） | `lumo-remote` → Scheduler 放置的承载节点 | `@lumo/mailbox`（PG） |
 *
 * 形态差异只落在 `roster.selectMemberProvider` 一处：按优先级探测 provider，
 * **没有** `if (cluster)` 分支。
 *
 * ## 两档成员（§24.2）
 *
 * 成员分两档：**Worker** 是本插件既有的 one-shot 派发（不变），**Thread** 是可续跑的
 * 完整会话（跨 Run、可被事件唤醒）。Thread 档位另提供 `ctx.agentThreads`：
 * 判据在 `thread.ts`（纯函数）、唤醒接线在 `thread-wake.ts`（走既有 `@lumo/mailbox`）、
 * 行本身由 `control-plane/collaborator` 持有（它是 `threads` 的唯一写入方）。
 * Thread 的三件事各有既有落点——续跑是日志、唤醒是 mailbox、配额是预算树——
 * 本插件**不新建执行机制**，也不引入 continuable 句柄（理由见 `roster.ts`）。
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { createCourier, type MailboxSeamLike, type TeamCourier } from './courier.ts'
import {
  dispatchMember,
  selectMemberProvider,
  type MemberRun,
  type MemberSeam,
  type MemberStartRequest,
} from './roster.ts'
import { AgentTeamsService, DEFAULT_MAX_MEMBERS, type MemberSurface } from './service.ts'
import { createTeamStore, type StorageFacetLike } from './store.ts'
import { createHttpThreadRegistry, type ThreadRegistryLike } from './thread-registry.ts'
import { ThreadsRuntime } from './threads.ts'
import {
  DEFAULT_TOOL_MAX_ROUNDS,
  DEFAULT_TOOL_MAX_WAIT_MS,
  defineAgentTeamsTools,
  defineAgentThreadTools,
} from './tools.ts'

/** 会合面 realm：等待项 id 的作用域前缀，跨团队/租户不互相兑现。 */
const DEFAULT_REALM = 'agent-teams'

/** 插件配置。 */
export interface AgentTeamsConfig {
  /**
   * 成员 provider。缺省按 `lumo-remote > spawn > fork` 探测 —— 集群父节点上
   * 必然命中 `lumo-remote`（成员才会真的落到承载节点），单机自然回落 `spawn`。
   * 显式配置时**不静默回落**：配置了却不可用会响亮失败，免得运维看不出偏差。
   */
  memberProvider?: string
  /** 团队规模上限。 */
  maxMembers?: number
  /** `agent_teams_run` 的轮次上限。 */
  maxRounds?: number
  /** `agent_teams_await_task` 的单次等待上限（毫秒）。 */
  maxWaitMs?: number
  /** 会合面 realm。 */
  realm?: string
  /** 协作服务基址（`control-plane/collaborator`，线程注册表）。缺省 = 线程面读不到行。 */
  collaboratorUrl?: string
  /** 调用协作服务时使用的身份（生产由边缘网关注入，直连时用配置）。 */
  actingUserId?: string
  /** 本节点身份（线程亲和判据的输入）。缺省 = 线程面拒绝一切唤醒。 */
  nodeId?: string
  /** 本节点工作区根（绝对路径，线程工作目录的解析基准）。缺省 = 工作目录不可解析。 */
  workspaceRoot?: string
  /** 线程唤醒等待项的默认有效期（毫秒；仍受 `MAX_WAKE_TTL_MS` 约束）。 */
  wakeTtlMs?: number
}

/** Schemastery validation for {@link AgentTeamsConfig} */
export const Config: z<AgentTeamsConfig> = z.object({
  memberProvider: z.string(),
  maxMembers: z.number(),
  maxRounds: z.number(),
  maxWaitMs: z.number(),
  realm: z.string(),
  collaboratorUrl: z.string(),
  actingUserId: z.string(),
  nodeId: z.string(),
  workspaceRoot: z.string(),
  wakeTtlMs: z.number(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: AgentTeamsService
    /** 线程档位（§24.2）：注册表 + 唤醒 + 工作目录解析。 */
    agentThreads: ThreadsRuntime
  }
}

/** 工具服务须先挂载（本插件注册 `agent_teams_*` 工具面）。 */
export const inject = ['tools']

/**
 * `ctx.subagents` 的结构等价子集。
 *
 * 与 `roster.ts` 的 `MemberSeam` 同训：装配层也只用结构类型，不 import dsh 的
 * `SubagentRuntime`。`list()` 返回的是**provider 名**（dsh 侧按注册顺序返回），
 * 正是探测优先级需要的那个列表。
 */
interface SubagentsFacetLike {
  list(): string[]
  start(name: string, request: MemberStartRequest): Promise<MemberRun>
}

/** 校验一个正整数配置项。 */
function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`agent-teams: ${name} 必须是正整数，收到 ${String(value)}`)
  }
  return value
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 按配置建线程注册表；配置不全时返回 `undefined` 并**响亮留痕**。
 *
 * 为什么不在这里抛：线程面是**加档**（§24.2 的两档成员），它的装配缺陷不该让整个
 * agent-teams 起不来——任务板、roster、会合面在单机形态下依旧可用。但也不能静默：
 * 「配了协作服务地址却忘了身份」的症状是线程动作全部拒绝，没有这条日志，现场会先怀疑
 * 协作服务挂了。
 */
function createThreadRegistry(
  ctx: Context,
  config: AgentTeamsConfig,
  realm: string,
): ThreadRegistryLike | undefined {
  if (config.collaboratorUrl === undefined || config.collaboratorUrl === '') return undefined
  if (config.actingUserId === undefined || config.actingUserId === '') {
    ctx.logger.warn(
      'agent-teams: 配了 collaboratorUrl 但没有 actingUserId，线程注册表未装配（协作服务按网关注入的身份头授权）',
    )
    return undefined
  }
  try {
    return createHttpThreadRegistry({
      baseUrl: config.collaboratorUrl,
      userId: config.actingUserId,
      realm,
    })
  } catch (error: unknown) {
    ctx.logger.error('agent-teams: 线程注册表装配失败，线程面不可用：%s', describe(error))
    return undefined
  }
}

/**
 * 开一轮线程的 Run：走与成员派发**同一条**执行面（`roster.dispatchMember`）。
 *
 * 复用而不是另起一条执行路径，是因为「provider 逐次选择」的三条守卫（§24.3.1 / §24.3.2）
 * 只在那一处：进程外 provider 一律不动（换 provider 不得改变执行位置）、正交原样、
 * fork 不可用则回落不抛。线程的一轮与团队的一轮在这三件事上要求完全一致——都是「把一段
 * 工作放到承载节点上跑」。差别只在**归因**：`label` 带线程 id 与代数，好让这一轮在会话
 * 列表与成本归因（§14 判据 10）里认得出是哪条线程的第几轮。
 *
 * 执行面缺失时**抛**（不是回落）：重派没有第二条路（`requireRunner` 的同一条理由）。
 */
async function startThreadRound(
  surfaceRef: () => MemberSurface | undefined,
  input: {
    thread: { id: string; session_ref: string; node_id: string }
    round: { task_id: string; attempt: number }
    prompt: string
    parent: unknown
    signal: AbortSignal
  },
): Promise<{ runId: string }> {
  const surface = surfaceRef()
  if (surface === undefined) {
    throw new Error(
      'agent-teams: 本节点没有成员执行面（subagents 未挂载/探测失败），线程的这一轮无处执行',
    )
  }
  const outcome = await dispatchMember(surface.seam, surface.provider, {
    label: `${input.thread.id}#${input.round.attempt}`,
    prompt: [input.prompt],
    parent: input.parent,
    signal: input.signal,
  })
  if (!outcome.ok) {
    // 执行面本身跑起来了但这一轮没跑完（模型/传输失败）：照实抛，让协调者看见「重派也失败了」
    // ——静默返回一个 runId 会把一次失败的执行记成一次成功的重派。
    throw new Error(
      `agent-teams: 线程 ${input.thread.id} 第 ${input.round.attempt} 轮未完成（${outcome.stopReason}）：${outcome.text.slice(0, 300)}`,
    )
  }
  return { runId: outcome.runId }
}

export function apply(ctx: Context, config: AgentTeamsConfig): void {
  const realm = config.realm ?? DEFAULT_REALM
  const maxMembers = positive('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS)

  // 三个协作者都先给**兜底**，再由 ctx.inject 在真正的服务挂上来时升级。
  //
  // 不能在这里快照一次：storage / mailbox / subagents 的挂载顺序不由本插件决定，
  // 快照会把「晚一步挂上」永久固化成内存兜底 —— 团队看起来一切正常，重启即丢。
  let store = createTeamStore(undefined)
  let courier: TeamCourier = createCourier(undefined, realm)
  let surface: MemberSurface | undefined
  /** 执行面的**按需解析**（`subagents` 的挂载顺序不由本插件决定，见下）。 */
  const surfaceRef = (): MemberSurface | undefined => surface

  const service = new AgentTeamsService({
    resolveStore: () => store,
    resolveCourier: () => courier,
    resolveSeam: () => surface,
    maxMembers,
    warn: message => ctx.logger.warn('%s', message),
  })

  ctx.provide('agentTeams', service)

  // 线程档位（§24.2）：注册表（协作服务）+ 唤醒（会合面）+ 本节点事实（身份、工作区根）+ 执行面。
  //
  // 四样都按「缺了就连带的能力一起拒绝」装配，而不是静默降级：缺注册表就读不到行，
  // 缺节点身份就 arm 出一个没人能兑现的等待项（§8.1 的「永不唤醒」），缺执行面则重派只能
  // 造出一行永远不动的记录。能力画像在 `agentThreads.capabilities()` 里可查，运维一眼看出
  // 缺哪一样。
  //
  // 注册表按**解析器**传给运行时（而不是快照一个客户端）：地址的来源不由本插件决定
  // （显式配置 / 将来的服务发现），快照会把「晚一步可用」固化成一个一直报
  // `registry: false` 的能力画像，现场会先去怀疑协作服务挂了。
  const threads = new ThreadsRuntime({
    resolveCourier: () => courier,
    resolveRegistry: () => createThreadRegistry(ctx, config, realm),
    nodeId: config.nodeId ?? '',
    ...config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot },
    // 重派的一轮 Run 走**同一个成员执行面**（集群里 provider 是 lumo-remote → Scheduler 放置）：
    // 按需解析（`surface` 在 subagents 挂上之后才有值），缺了就在动作那一刻响亮拒绝——
    // 同时也让 `capabilities().roundRunner` 如实反映「这台机器现在能不能重派」。
    resolveRunner: () => (surfaceRef() === undefined ? undefined : {
      start: input => startThreadRound(surfaceRef, input),
    }),
    ...config.wakeTtlMs === undefined ? {} : { defaultWakeTtlMs: config.wakeTtlMs },
    warn: message => ctx.logger.warn('%s', message),
  })
  ctx.provide('agentThreads', threads)

  const unregisterTools = defineAgentTeamsTools(ctx, service, {
    ...config.maxRounds === undefined ? {} : { maxRounds: positive('maxRounds', config.maxRounds) },
    ...config.maxWaitMs === undefined ? {} : { maxWaitMs: positive('maxWaitMs', config.maxWaitMs) },
  })
  const unregisterThreadTools = defineAgentThreadTools(ctx, threads, {
    ...config.maxWaitMs === undefined ? {} : { maxWaitMs: positive('maxWaitMs', config.maxWaitMs) },
  })

  // 团队状态：单机后端是 sqlite、集群后端是 PG，这里看不到区别（这正是用 storage hub 的目的）。
  ctx.inject(['storage'], (storageCtx) => {
    // 结构性读：storage 服务的形状由 dsh 定义，本插件不 import 它的类型
    // （与 roster.ts 的 MemberSeam 同训）。
    const facet = storageCtx.get('storage') as unknown as StorageFacetLike | undefined
    const upgraded = createTeamStore(facet)
    store = upgraded
    if (!upgraded.durable) {
      ctx.logger.warn('agent-teams: storage hub 已挂载但未提供持久后端，团队状态仍在内存里')
      return
    }
    void upgraded.store.init().catch((error: unknown) => {
      ctx.logger.error('agent-teams: 团队状态存储初始化失败，团队会随进程消失：%s', describe(error))
    })
  })

  // 会合面：集群形态有 mailbox（PG，跨节点跨时间），单机回落进程内。
  ctx.inject(['mailbox'], (mailboxCtx) => {
    courier = createCourier(mailboxCtx.get('mailbox') as MailboxSeamLike, realm)
  })

  // 成员执行面：按优先级探测 provider。这一步是「单机 / 集群」在装配层的全部差异。
  ctx.inject(['subagents'], (subagentsCtx) => {
    const subagents = subagentsCtx.get('subagents') as SubagentsFacetLike
    try {
      const provider = selectMemberProvider({
        available: subagents.list(),
        ...config.memberProvider === undefined ? {} : { configured: config.memberProvider },
      })
      surface = {
        provider,
        seam: {
          list: () => subagents.list(),
          start: (name, request) => subagents.start(name, request),
        },
      }
      // 只报 provider：存储与会合面的形态由 `agent_teams_status` 的能力画像给出
      // （那是按需读的，不会因为这里的挂载顺序而报一个过时的值）。
      ctx.logger.info(
        'agent-teams: 成员 provider = %s（%s，%s）',
        provider.provider,
        provider.kind,
        provider.reason,
      )
    } catch (error: unknown) {
      // 探测失败只降级到**只读**：任务板与状态面照常可用，派发会响亮失败。
      // 这里必须留痕 —— 否则「能建团队但一跑就说没有执行面」会非常难查。
      ctx.logger.warn(
        'agent-teams: 成员 provider 探测失败，本节点只能读写团队状态、不能派发：%s',
        describe(error),
      )
    }
  })

  ctx.effect(() => async () => {
    unregisterTools()
    unregisterThreadTools()
    await courier.close()
    await store.store.close()
  })
}

export default apply

export { AgentTeamsService, DEFAULT_MAX_MEMBERS } from './service.ts'
export type {
  AgentTeamsCapabilities,
  MemberSurface,
  ReconcileResult,
  RoundResult,
  TaskDispatchResult,
} from './service.ts'
export { TOPOLOGIES } from './model.ts'
export type { TeamMember, TeamProgress, TeamState, TeamTask, TaskStatus, Topology } from './model.ts'
export { TEAM_UNIT_NAME, TEAM_UNIT_VERSION } from './store.ts'
export { acceptanceVerdict, hasAcceptance } from './acceptance.ts'
export { FORK_PROVIDER, evidenceOfRun, selectDispatchProvider } from './roster.ts'
export type { AcceptanceVerdict } from './acceptance.ts'
// 线程档位（§24.2）：判据在 thread.ts（纯函数），传输在 thread-wake.ts，
// 注册表客户端在 thread-registry.ts，装配面在 threads.ts。
export {
  DEFAULT_WAKE_TTL_MS, MAX_WAKE_TTL_MS, THREAD_STATES, TERMINAL_THREAD_STATES,
  ThreadRowError, ThreadWakeRefusedError, ThreadWorkspaceError,
  parseThreadRow, parseNodeLossNotice, resolveWakeTtlMs, resolveThreadWorkspacePath, threadWakeChannel,
  threadActionDecision, wakePayload, nodeLossPayload, replacementThreadId, nextRoundAfterLoss,
  planThreadReplacement,
} from './thread.ts'
export type {
  NodeLossNotice, ReplacementRefusal, ThreadAction, ThreadReplacementDecision, ThreadReplacementPlan,
  ThreadRound, ThreadRow, ThreadState, WakeDecision, WakeRefusal,
} from './thread.ts'
export { ThreadWaker } from './thread-wake.ts'
export type { ThreadReconcileResult, ThreadWakeEntry } from './thread-wake.ts'
export { ThreadRegistryError, createHttpThreadRegistry } from './thread-registry.ts'
export type { CreateThreadInput, ThreadRegistryLike } from './thread-registry.ts'
export {
  ThreadReassignConflictError, ThreadReassignRefusedError, ThreadsRuntime, ThreadsUnavailableError,
} from './threads.ts'
export type {
  ThreadAwaitOutcome, ThreadReassignResult, ThreadRoundRunner, ThreadsCapabilities, ThreadSuspendResult,
} from './threads.ts'
export { defineAgentThreadTools } from './tools.ts'
export type { AgentThreadToolConfig } from './tools.ts'
