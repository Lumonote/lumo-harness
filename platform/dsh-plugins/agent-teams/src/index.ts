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
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { createCourier, type MailboxSeamLike, type TeamCourier } from './courier.ts'
import {
  selectMemberProvider,
  type MemberRun,
  type MemberSeam,
  type MemberStartRequest,
} from './roster.ts'
import { AgentTeamsService, DEFAULT_MAX_MEMBERS, type MemberSurface } from './service.ts'
import { createTeamStore, type StorageFacetLike } from './store.ts'
import {
  DEFAULT_TOOL_MAX_ROUNDS,
  DEFAULT_TOOL_MAX_WAIT_MS,
  defineAgentTeamsTools,
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
}

/** Schemastery validation for {@link AgentTeamsConfig} */
export const Config: z<AgentTeamsConfig> = z.object({
  memberProvider: z.string(),
  maxMembers: z.number(),
  maxRounds: z.number(),
  maxWaitMs: z.number(),
  realm: z.string(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: AgentTeamsService
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

  const service = new AgentTeamsService({
    resolveStore: () => store,
    resolveCourier: () => courier,
    resolveSeam: () => surface,
    maxMembers,
    warn: message => ctx.logger.warn('%s', message),
  })

  ctx.provide('agentTeams', service)

  const unregisterTools = defineAgentTeamsTools(ctx, service, {
    ...config.maxRounds === undefined ? {} : { maxRounds: positive('maxRounds', config.maxRounds) },
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
