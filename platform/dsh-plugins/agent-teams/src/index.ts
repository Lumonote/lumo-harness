/**
 * @lumo/agent-teams —— `docs/architecture.md` §7.3 的 `ctx.lumoAgentTeams`：
 * roster + 任务板(DAG) + 会合面，**一份代码同时成立在单机与集群两种部署形态上**。
 *
 * ## 为什么不用现成的两个实现
 *
 * 仓库里有（或能装到）两个「多智能体团队」实现，但都覆盖不了集群形态：
 *
 * | 实现 | 成员派发 | 为什么不行 |
 * |---|---|---|
 * | `@nanmicoder/dsh-agent-teams` 0.1.15 | `registerContinuableSetup` | 平台集群 wire（`shared/seam-contracts/subagent-host.ts`）只覆盖 one-shot spawn；且 0.1.15 调用了 master 已移除的 API，已被排除出插件基线 |
 * | `@deepseek-ai/dsh-experimental-agent-team` 0.1.5-rc.2 | `ctx.subagents.startContinuable`（`roster.ts:282`） | 同样是 continuable，且绑定 session log + projection，实验态，可按需启用，服务名由原生插件独占 |
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
 * 完整会话。Thread 档位另提供 `ctx.agentThreads`：
 * 判据在 `thread.ts`（纯函数）、唤醒接线在 `thread-wake.ts`（走既有 `@lumo/mailbox`）、
 * 行本身由 `control-plane/collaborator` 持有（它是 `threads` 的唯一写入方）。
 * 显式 `threadExecution` 使用公开 agents.create/resume 在登记本节点上执行连续文本轮次，
 * 协作服务持有幂等回执与并发准入，公开 sessionPersistence 保留上下文。
 * mailbox 的 suspend/wake 仍是独立状态/通知能力，尚不自动触发模型执行。
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createThreadDispatch } from './thread-dispatch.ts'
import { SessionOwnerClient } from '../../../shared/session-owners.ts'
import { teamAuthorityHandler } from './team-authority.ts'

import { createCourier, type MailboxSeamLike, type TeamCourier } from './courier.ts'
import {
  selectMemberProvider,
  type MemberRun,
  type MemberSeam,
  type MemberStartRequest,
} from './roster.ts'
import { AgentTeamsService, DEFAULT_MAX_MEMBERS, type MemberSurface } from './service.ts'
import { createTeamStore, type StorageFacetLike } from './store.ts'
import { createHttpThreadRegistry, type ThreadRegistryLike } from './thread-registry.ts'
import { ThreadsRuntime } from './threads.ts'
import { createLocalThreadRunner } from './thread-runner.ts'
import { assertThreadExecutionBinding, createThreadControl, type ThreadExecutionBinding } from './thread-control.ts'
import type { ThreadRoundRunner } from './threads.ts'
import type { SessionMeterScope } from '../../../shared/seam-contracts/meter-attribution.ts'
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
  /** Storage hub 中承载团队名册的后端名：桌面 sqlite，服务器 pg。 */
  storageBackend?: 'sqlite' | 'pg'
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
  controlPlaneToken?: string
  /** 可信节点配置的团队 owner 与协作调用身份；尚无多用户会话动态映射。 */
  actingUserId?: string
  /** 本节点身份（线程亲和判据的输入）。缺省 = 线程面拒绝一切唤醒。 */
  nodeId?: string
  /** 本节点工作区根（绝对路径，线程工作目录的解析基准）。缺省 = 工作目录不可解析。 */
  workspaceRoot?: string
  /** 线程唤醒等待项的默认有效期（毫秒；仍受 `MAX_WAKE_TTL_MS` 约束）。 */
  wakeTtlMs?: number
  /** Explicit opt-in: fixed-node, fixed-owner text rounds with durable receipts. */
  threadExecution?: ThreadExecutionBinding & { distributed?: boolean; sessionControlUrl?: string }
}

/** Schemastery validation for {@link AgentTeamsConfig} */
export const Config: z<AgentTeamsConfig> = z.object({
  storageBackend: z.union(['sqlite', 'pg'] as const),
  memberProvider: z.string(),
  maxMembers: z.number(),
  maxRounds: z.number(),
  maxWaitMs: z.number(),
  realm: z.string(),
  collaboratorUrl: z.string(),
  controlPlaneToken: z.string(),
  actingUserId: z.string(),
  nodeId: z.string(),
  workspaceRoot: z.string(),
  wakeTtlMs: z.number(),
  // union has no object default: an omitted opt-in stays undefined.
  threadExecution: z.union([z.object({
    distributed: z.boolean(), sessionControlUrl: z.string(), governanceUrl: z.string(), projectId: z.string(), agentId: z.string(),
    presetRevision: z.number(), provider: z.string(), model: z.string(), timeoutMs: z.number(),
  })]),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Platform team API; native DSH reserves agentTeams for its TeamService. */
    lumoAgentTeams: AgentTeamsService
    /** 线程档位：注册表、唤醒与显式配置的本节点稳定文本轮次。 */
    agentThreads: ThreadsRuntime
  }
}

/** 工具服务须先挂载（本插件注册 `agent_teams_*` 工具面）。 */
export const inject = ['tools']

/**
 * `ctx.subagents` 的结构等价子集。
 *
 * 与 `roster.ts` 的 `MemberSeam` 同训：装配层也只用结构类型，不 import dsh 的
 * `SubagentRuntime`。通过公开 getProvider 查询候选名；上游不暴露私有注册表枚举。
 */
interface SubagentsFacetLike {
  getProvider(name: string): unknown | undefined
  startActivation(spec: Omit<MemberStartRequest, 'label' | 'signal'> & {
    provider: string
    label: string
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<Omit<MemberRun, 'id'> & { childId: string }>
}

/** 将上游托管 activation 接到团队内部的 one-shot 执行面。 */
export function createMemberSeam(subagents: SubagentsFacetLike, configured?: string): MemberSeam {
  return {
    list: () => availableMemberProviders(subagents, configured),
    async start(provider, { label, signal, ...request }) {
      const activation = await subagents.startActivation({ provider, label, ...request, signal, delivery: 'caller' })
      return {
        id: activation.childId,
        result: activation.result,
        dispose: () => activation.dispose(),
      }
    },
  }
}

function availableMemberProviders(subagents: Pick<SubagentsFacetLike, 'getProvider'>, configured?: string): string[] {
  return [...new Set(['lumo-remote', 'spawn', 'fork', ...(configured ? [configured] : [])])]
    .filter(name => subagents.getProvider(name) !== undefined)
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
      ...config.controlPlaneToken === undefined ? {} : { controlPlaneToken: config.controlPlaneToken },
    })
  } catch (error: unknown) {
    ctx.logger.error('agent-teams: 线程注册表装配失败，线程面不可用：%s', describe(error))
    return undefined
  }
}

export function apply(ctx: Context, config: AgentTeamsConfig): void {
  const realm = config.realm ?? DEFAULT_REALM
  const maxMembers = positive('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS)

  // 协作者按需接线；PG 形态在持久存储就绪前拒绝团队写入。
  //
  // 不能在这里快照一次：storage / mailbox / subagents 的挂载顺序不由本插件决定，
  // 快照会把「晚一步挂上」永久固化成内存兜底 —— 团队看起来一切正常，重启即丢。
  let store = createTeamStore(undefined)
  let courier: TeamCourier = createCourier(undefined, realm)
  let surface: MemberSurface | undefined
  let threadRunner: ThreadRoundRunner | undefined
  if (config.threadExecution) {
    assertThreadExecutionBinding(config.threadExecution)
    if (config.threadExecution.distributed && !config.threadExecution.sessionControlUrl?.trim()) throw new Error('agent-teams: distributed Thread execution requires its session owner authority')
    if (![config.collaboratorUrl, config.controlPlaneToken, config.actingUserId, config.nodeId, config.workspaceRoot]
      .every(value => typeof value === 'string' && value.trim())) {
      throw new Error('agent-teams: threadExecution requires collaborator, service credentials, fixed owner, node and workspace')
    }
  }

  const service = new AgentTeamsService({
    realm,
    requireDurableStore: config.storageBackend === 'pg',
    ...config.actingUserId === undefined ? {} : { ownerUserId: config.actingUserId },
    resolveStore: () => store,
    resolveCourier: () => courier,
    resolveSeam: () => surface,
    maxMembers,
    warn: message => ctx.logger.warn('%s', message),
  })

  ctx.provide('lumoAgentTeams', service)
  if (config.controlPlaneToken) ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => (webCtx.get('webServer') as {register(input: {kind: 'prefix'; path: string; handler: ReturnType<typeof teamAuthorityHandler>}): () => void}).register({kind: 'prefix', path: '/lumo/runtime/teams/',
      handler: teamAuthorityHandler({realm, token: config.controlPlaneToken!, service,
        durable: () => config.storageBackend === 'pg' && store.durable})}))
  })

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
  const ownerClient = config.threadExecution?.sessionControlUrl ? new SessionOwnerClient(config.threadExecution.sessionControlUrl, config.controlPlaneToken!) : undefined
  const threads = new ThreadsRuntime({
    ...(ownerClient ? { allocateSession: async (input: {projectId: string; nodeId: string; coordinatorSessionRef: string}) => {
      const parent = await ownerClient.get(realm, input.coordinatorSessionRef)
      if (parent.state !== 'active' || parent.owner_user_id !== config.actingUserId || parent.project_id !== input.projectId) throw new Error('Thread requires its trusted coordinator owner')
      const reserved = await ownerClient.reserve({realm, owner_user_id: parent.owner_user_id, project_id: parent.project_id, node_id: input.nodeId, parent_session_ref: ''})
      await ownerClient.activate(realm, reserved.owner.session_ref, reserved.creation_token)
      return reserved.owner.session_ref
    }} : {}),
    resolveCourier: () => courier,
    resolveRegistry: () => createThreadRegistry(ctx, config, realm),
    nodeId: config.nodeId ?? '',
    ...config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot },
    // Worker providers do not guarantee Thread node/session affinity.
    resolveRunner: () => threadRunner,
    ...config.wakeTtlMs === undefined ? {} : { defaultWakeTtlMs: config.wakeTtlMs },
    warn: message => ctx.logger.warn('%s', message),
  })
  ctx.provide('agentThreads', threads)

  if (config.threadExecution) {
    const binding = config.threadExecution
    ctx.inject(['agents', 'sessionPersistence', 'meteringScope'], runtimeCtx => {
      const registry = createThreadRegistry(ctx, config, realm)
      if (!registry) throw new Error('agent-teams: Thread execution requires its durable registry')
      let dispatch: ReturnType<typeof createThreadDispatch> | undefined
      const liveParent = (input: Parameters<ThreadRoundRunner['start']>[0]) => {
        const parent = input.parent as {id?: string} | undefined
        return !!parent?.id && parent.id === input.thread.coordinator_session_ref && runtimeCtx.agents.get(SessionId(parent.id)) === input.parent
      }
      const control = createThreadControl({ baseUrl: config.collaboratorUrl!, token: config.controlPlaneToken!,
        realm, userId: config.actingUserId!, binding, registry, ...(ownerClient ? { owner: ownerClient } : {}), verifyParent: input => liveParent(input) || !!dispatch?.authorizeClaim(input) })
      const runner = createLocalThreadRunner({ ctx: runtimeCtx, realm, nodeId: config.nodeId!, workspaceRoot: config.workspaceRoot!,
        workspace: async thread => (await threads.materializeWorkspace(thread)).path,
        authorize: control.authorize, roundStore: control.store, persistence: runtimeCtx.sessionPersistence,
        meterScope: runtimeCtx.get('meteringScope') as SessionMeterScope, timeoutMs: binding.timeoutMs })
      if (config.threadExecution!.distributed) {
        const source = createThreadControl({baseUrl: config.collaboratorUrl!, token: config.controlPlaneToken!, realm,
          userId: config.actingUserId!, binding, registry, ...(ownerClient ? { owner: ownerClient } : {}), verifyParent: liveParent})
        dispatch = createThreadDispatch({baseUrl: config.collaboratorUrl!, token: config.controlPlaneToken!, realm,
          userId: config.actingUserId!, nodeId: config.nodeId!, registry, local: runner,
          authorize: source.authorize, warn: error => ctx.logger.warn('Thread mailbox: %s', describe(error))})
        threadRunner = dispatch.runner
        threads.setDispatch(dispatch)
        runtimeCtx.effect(() => {
          const stopPoll = dispatch!.start()
          return async () => { threadRunner = undefined; threads.setDispatch(undefined); stopPoll(); await dispatch!.close() }
        })
      } else {
        threadRunner = runner
        runtimeCtx.effect(() => () => { if (threadRunner === runner) threadRunner = undefined })
      }
    })
  }

  const unregisterTools = defineAgentTeamsTools(ctx, service, {
    ...config.maxRounds === undefined ? {} : { maxRounds: positive('maxRounds', config.maxRounds) },
    ...config.maxWaitMs === undefined ? {} : { maxWaitMs: positive('maxWaitMs', config.maxWaitMs) },
  })
  const unregisterThreadTools = defineAgentThreadTools(ctx, threads, {
    ...config.maxWaitMs === undefined ? {} : { maxWaitMs: positive('maxWaitMs', config.maxWaitMs) },
  })

  // ctx.storage 是后端注册中心，不是 KvFacet。等具体后端的生命周期服务激活后，
  // 再从注册中心按部署配置取 kv；否则 `ctx.storage.kv.open` 会在首次读取名册时抛错。
  if (config.storageBackend !== undefined) {
    const backendName = config.storageBackend
    ctx.inject(['storage', `storage.backend.${backendName}`], (storageCtx) => {
      const hub = storageCtx.get('storage') as { backend: { get(name: string): StorageFacetLike } } | undefined
      const facet = hub?.backend.get(backendName)
      if (facet?.kv === undefined) {
        ctx.logger.error('agent-teams: %s 存储后端缺少 kv 能力，团队持久存储不可用', backendName)
        return
      }
      const upgraded = createTeamStore(facet, { realm, requireAtomic: backendName === 'pg' })
      store = upgraded
      void upgraded.store.init().catch((error: unknown) => {
        // 集群不能写进节点各自的内存：保留失败的后端，让读写明确拒绝。
        if (backendName !== 'pg' && store === upgraded) store = createTeamStore(undefined)
        ctx.logger.error('agent-teams: 团队状态存储初始化失败：%s', describe(error))
      })
    })
  }

  // 会合面：集群形态有 mailbox（PG，跨节点跨时间），单机回落进程内。
  ctx.inject(['mailbox'], (mailboxCtx) => {
    courier = createCourier(mailboxCtx.get('mailbox') as MailboxSeamLike, realm)
  })

  // 成员执行面：按优先级探测 provider。这一步是「单机 / 集群」在装配层的全部差异。
  ctx.inject(['subagents'], (subagentsCtx) => {
    const subagents: SubagentsFacetLike | undefined = subagentsCtx.get('subagents')
    try {
      if (subagents === undefined) throw new Error('subagents runtime is unavailable')
      const provider = selectMemberProvider({
        available: availableMemberProviders(subagents, config.memberProvider),
        ...config.memberProvider === undefined ? {} : { configured: config.memberProvider },
      })
      surface = {
        provider,
        seam: createMemberSeam(subagents, config.memberProvider),
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
export { createLocalThreadRunner, ThreadRoundExecutionError, threadRoundRunId } from './thread-runner.ts'
export { createThreadControl } from './thread-control.ts'
export type { ThreadExecutionBinding } from './thread-control.ts'
