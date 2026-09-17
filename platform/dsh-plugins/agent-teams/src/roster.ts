/**
 * @lumo/agent-teams 的 roster —— 成员执行面，以及「单机 / 集群」在这套集成里
 * **唯一的形态分叉点**。
 *
 * ## 为什么分叉只在这里
 *
 * 一次成员 turn 就是一次子代理委派。平台两种部署形态下，可用的 subagent provider
 * 不同（见下表），而 dsh 的 `ctx.subagents.start(name, request)` 已经用**名字**抽象了
 * 这件事。所以本插件不做形态判断，只做**按优先级探测**：集群父节点上 `lumo-remote`
 * 存在就必然选中它，单机上它不存在自然回落 `spawn`。同一份代码、同一个团队语义，
 * 两种形态都成立。
 *
 * | 形态 | 挂载 | 成员实际在哪执行 |
 * |---|---|---|
 * | local（桌面单机） | 官方 base profile 的 `spawn`/`fork` | 本进程 |
 * | standalone（单节点服务） | 官方 `spawn`/`fork` | 本进程 |
 * | cluster（父节点 `LUMO_ROLE=agent`） | `@lumo/subagent-remote` 注册 `lumo-remote` | Scheduler 放置的承载节点 |
 * | cluster（承载节点 `LUMO_ROLE=node`） | `@lumo/subagent-host` 收活 | 本节点（被别的父节点放置） |
 *
 * ## 为什么成员是 one-shot 而不是 continuable
 *
 * dsh 有 `startContinuable` + `sendMessage` 的「持久子代理」能力。仓库里能拿到的
 * 两个多智能体实现都整个建立在它之上：
 *
 * | 实现 | 落点 |
 * |---|---|
 * | `@nanmicoder/dsh-agent-teams` 0.1.15 | `registerContinuableSetup`（master 已移除，故被排除出基线） |
 * | `@deepseek-ai/dsh-experimental-agent-team` 0.1.5-rc.2 | `ctx.subagents.startContinuable`（`experimental/agent-team/src/roster.ts:282`） |
 *
 * 但平台的集群 wire（`shared/seam-contracts/subagent-host.ts`）明确只覆盖 one-shot
 * spawn —— 文件里写着「范围外（契约为其留位）：fork/continuable 的 seed 传输」。
 * 依赖 continuable 就等于把整套协同锁死在单进程内，集群形态下成员只能全压在父节点。
 *
 * 所以本插件把「成员」建模成**可重复派发的 one-shot**：成员身份是名字 + 路由（落在
 * team 状态里），每次派发新建一个子代理跑完即收。跨节点成立，且重启后团队状态可复现。
 * 代价是成员看不到团队状态、也没有上一轮上下文 —— 上游产出必须由派发方显式带进
 * prompt，见 `service.ts` 的 `buildMemberPrompt`。
 */

import type { MemberStatus } from './model.ts'

/**
 * 成员 provider 的探测优先级。
 *
 * `lumo-remote` 排第一不是偏好问题而是正确性：集群父节点上它存在，且只有它能把
 * 子代理放到承载节点。若让它排第二，集群里成员会全部退回本进程执行 —— 配置看着
 * 成功、负载却全压在父节点上，是那种不会报错的错误。
 */
export const MEMBER_PROVIDER_PREFERENCE: readonly string[] = ['lumo-remote', 'spawn', 'fork']

/** provider 的执行位置语义。 */
export type ProviderKind =
  /** 子代理在别的节点执行（经 Scheduler 放置）。 */
  | 'remote'
  /** 子代理在本进程执行。 */
  | 'in-process'
  /** 本插件不认识的 provider（例如 ACP / 外部 CLI 后端）。 */
  | 'external'

/** 按 provider 名判定执行位置。未知名字不猜，归 `external`。 */
export function providerKind(provider: string): ProviderKind {
  if (provider === 'lumo-remote') return 'remote'
  if (provider === 'spawn' || provider === 'fork') return 'in-process'
  return 'external'
}

/** 选定的一名成员 provider。 */
export interface MemberProviderChoice {
  provider: string
  kind: ProviderKind
  /** 为什么选它。落日志，也进 `status` 工具，省得靠猜。 */
  reason: string
}

/** provider 探测失败。 */
export class MemberProviderError extends Error {
  constructor(message: string, readonly available: readonly string[]) {
    super(message)
    this.name = 'MemberProviderError'
  }
}

/**
 * 按优先级选一个成员 provider。
 *
 * @param options.available - 当前 `ctx.subagents.list()` 的注册名。
 * @param options.configured - 显式配置；给了就必须可用，**不静默回落** ——
 *   配置写着 `lumo-remote` 却在单机上悄悄跑成本进程，是运维最难发现的一类偏差。
 * @param options.preference - 覆盖默认优先级（测试与特殊装配用）。
 */
export function selectMemberProvider(options: {
  available: readonly string[]
  configured?: string
  preference?: readonly string[]
}): MemberProviderChoice {
  const available = [...options.available]
  if (options.configured !== undefined && options.configured !== '') {
    if (!available.includes(options.configured)) {
      throw new MemberProviderError(
        `配置的成员 provider "${options.configured}" 未注册。当前可用：${available.length === 0 ? '(无)' : available.join(', ')}`,
        available,
      )
    }
    return {
      provider: options.configured,
      kind: providerKind(options.configured),
      reason: '显式配置',
    }
  }
  const preference = options.preference ?? MEMBER_PROVIDER_PREFERENCE
  for (const candidate of preference) {
    if (available.includes(candidate)) {
      return {
        provider: candidate,
        kind: providerKind(candidate),
        reason: `按优先级探测命中（${preference.join(' > ')}）`,
      }
    }
  }
  throw new MemberProviderError(
    '没有任何成员 provider 可用：官方 spawn/fork 未挂载，集群形态下 lumo-remote 也未注册。'
    + '检查 patch 里是否漏挂 subagent provider。'
    + `当前可用：${available.length === 0 ? '(无)' : available.join(', ')}`,
    available,
  )
}

/**
 * 成员派发的最小 subagent 门面。
 *
 * 故意只声明本插件真正用到的两个成员，且用结构类型而非 import dsh 的
 * `SubagentRuntime`：这样 roster 的选择逻辑与派发包装都能在**不启 dsh 运行时**的
 * 情况下单测（与 `shared/seam-contracts/*` 的「零 import dsh」同训）。
 */
export interface MemberSeam {
  /** 已注册 provider 名。 */
  list(): string[]
  /** 建立一次 one-shot 子代理。 */
  start(name: string, request: MemberStartRequest): Promise<MemberRun>
}

/** 一次成员派发的输入（dsh `SubagentStartRequest` 的结构等价子集）。 */
export interface MemberStartRequest {
  /** 子代理的短标签，进会话列表。 */
  label: string
  /** 用户消息内容。 */
  prompt: readonly unknown[]
  /** 产生本次委派的 agent（dsh 侧是 `Agent`，这里保持结构未知以免耦合）。 */
  parent: unknown
  signal: AbortSignal
  /** 可选路由覆盖（provider/model/推理档）。 */
  agentOptions?: unknown
  /** 可选成员人格。 */
  persona?: string
  /** 委派深度上限。 */
  maxDepth?: number
}

/** 一次成员派发的句柄（dsh `SubagentRun` 的结构等价子集）。 */
export interface MemberRun {
  readonly id: string
  readonly result: Promise<MemberResult>
  dispose(): Promise<void>
}

/** 一次成员派发的结局。 */
export interface MemberResult {
  readonly output: readonly unknown[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

/** 派发结束后的判定。 */
export interface MemberOutcome {
  /** 子代理是否正常跑完（`stopReason === 'completed'`）。 */
  ok: boolean
  /** 折叠出的纯文本结果，直接写回任务 `output`。 */
  text: string
  /** 非完成时的诊断。 */
  diagnostic?: string
  stopReason: string
}

/** 把结构化输出折叠成纯文本：取所有 text 块，非文本块用类型名占位。 */
export function foldMemberOutput(output: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of output) {
    if (typeof block === 'object' && block !== null && 'type' in block) {
      const typed = block as { type?: unknown; text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') {
        parts.push(typed.text)
        continue
      }
      parts.push(`[${String(typed.type)}]`)
      continue
    }
    parts.push(typeof block === 'string' ? block : JSON.stringify(block))
  }
  return parts.join('\n').trim()
}

/** 把一次派发结果折叠成任务可写回的结局。 */
export function foldMemberResult(result: MemberResult): MemberOutcome {
  return {
    ok: result.stopReason === 'completed',
    text: foldMemberOutput(result.output),
    ...result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
    stopReason: result.stopReason,
  }
}

/**
 * 派发一次成员 turn 并等待结局。
 *
 * 失败语义照 dsh 契约：子代理自身的失败（模型/传输）以 `stopReason !== 'completed'`
 * 的**结局**回来，不抛；只有基础设施故障才 reject。调用方据此决定是写回失败结果
 * 还是上报。`dispose` 在 finally 里调用，任何路径都不泄漏 run。
 */
export async function dispatchMember(
  seam: MemberSeam,
  choice: MemberProviderChoice,
  request: MemberStartRequest,
): Promise<MemberOutcome> {
  const run = await seam.start(choice.provider, request)
  try {
    return foldMemberResult(await run.result)
  } finally {
    await run.dispose()
  }
}

/** 成员在名册里的初始状态（新建即 `idle`，等待被派发）。 */
export const INITIAL_MEMBER_STATUS: MemberStatus = 'idle'
