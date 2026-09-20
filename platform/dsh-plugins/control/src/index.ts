/**
 * @lumo/control —— 共享执行控制的**提交面 + 生效面**（§8.4，铁律 18）。
 *
 * 提供：`ctx.sessionControl`（seam，契约 shared/seam-contracts/control.ts）
 * 作用点（dsh 公开挂点，零侵入）：
 *   - `agent/pre-step`（瀑布，可拒）：**停转点**。状态为暂停类时返回 `{kind:'reject'}`，
 *     于是这一步不开、这个 turn 不开——这就是 §8.4.1 给 pause / stop 写的「turn 边界」。
 *     拒之前必须把被 claim 掉的消息放回队列（claim 是消费，直接拒等于丢用户的输入）。
 *   - `tools/pre-execute`（瀑布，必须 next()）：**执行闸门**——
 *     aborted 拒全部工具；paused / awaiting-approval / stopped 拒副作用工具。
 *   - `agent/turn-stopping`（串行，返回 void）：turn 边界观测点。它**不能**停转
 *     （上游签名是 `Promise<void> | void`），只能记录现场。
 *   - 主动轮询（`actuationPollMs`，0 关闭）：补上两个「没人来触发就不会发生」的动作——
 *     `aborted` 的**硬取消**（`agent.cancel`，在途模型调用一起断）与恢复后的**唤醒**
 *     （`agent.steer` 注入续跑注记）。只靠挂点，abort 要等下一个步边界，resume 要等
 *     下一条用户消息。
 *
 * # 控制指令走哪条路
 *
 * | 动作 | 落点 |
 * | --- | --- |
 * | 裁决 + 落库 + 审计 | Go 控制面 `POST /v1/sessions/{ref}/control` |
 * | 提交（seam `dispatch`） | 本插件把它 POST 给控制面，把结论带回来 |
 * | 生效 | 本插件读 `session_control_state`，作用于上面四个挂点 |
 *
 * 注意第三行：**生效不经过控制面的「下发」**。状态行本身就是通道，本插件按 `ttl` 读它。
 * 所以 Go 侧 `control.Dispatcher` 未接线**不影响**「pause 真的停转」；那条链的价值在别处
 * （§8.4.2 要求控制指令作为 `session/control` 事件进复制日志、多端可见）。
 *
 * 本插件**不写** `session_control_state` / `session_control_audit`——状态行有 CAS、
 * 审计行有 realm 归属，绕过控制面的写入会破坏这两者。见 `pg-control.ts` 的表所有权说明。
 *
 * 未配置 `controlPlaneUrl`（local 形态没有这个服务）时，`dispatch` 抛
 * `ControlCommandRoutingError` 并说明本实例没接控制面；**不会**回落成「已生效」。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

import { DEFAULT_DISPATCH_TIMEOUT_MS, PgControlSeam } from './pg-control.ts'
import { controlActuation, controlGate } from './gate.ts'
import { toolRelease, type ReleaseClassifier } from './release.ts'
import { releaseClassifierOf, type ClassifierRules } from './classifier.ts'
import {
  actuationStep,
  cancelSession,
  hasPendingWork,
  preStepDecision,
  wakeSession,
  type ControllableAgent,
} from './actuation.ts'
import { OpaControlPolicy, RbacControlPolicy, DEFAULT_ROLE_GRANTS, type RoleGrants } from './policy.ts'
import type { ControlSeam, SessionControlState } from '../../../shared/seam-contracts/control.ts'

export interface ControlConfig {
  connectionString: string
  /** realm 层角色授权表（权限上限；省略用内置默认） */
  roleGrants?: RoleGrants
  /** 项目层角色授权表（只能收窄 realm 授权 —— 评审 N4） */
  projectGrants?: RoleGrants
  opaUrl?: string
  opaToken?: string
  /**
   * 控制面基址（`LUMO_SESSION_CONTROL_URL`，例如 `http://session-control:8092`）。
   * 省略 = 本实例没接控制面，`dispatch` 抛路由错误。
   */
  controlPlaneUrl?: string
  /** 控制面共享令牌（`LUMO_CONTROL_PLANE_TOKEN`）。 */
  controlPlaneToken?: string
  /** 提交超时（毫秒）。省略用 {@link DEFAULT_DISPATCH_TIMEOUT_MS}。 */
  dispatchTimeoutMs?: number
  /**
   * 主动生效的轮询周期（毫秒）。省略用 {@link DEFAULT_ACTUATION_POLL_MS}，**0 = 关闭**。
   *
   * 关掉只影响「主动」的两件事（`aborted` 的硬取消、恢复后的唤醒）——被动那三处
   * （开步前停转、工具闸门、turn 边界观测）都在挂点里，不受影响。没有控制面的部署
   * （local 形态）可以关掉：状态永远是 `running`，这一轮询是纯开销。
   */
  actuationPollMs?: number
  /**
   * 动作放行分类器（§24.5）的名单。**省略 = 不注册服务**。
   *
   * 这条可选性是本切片唯一的安全性质：没配时 `ctx.get('releaseClassifier')` 是
   * `undefined`，闸门走 fail-closed 分支，行为与接线前**逐字节一致**；配了即是一次
   * **显式**取舍——承认名单内的副作用工具在只读档下可以不等人的。
   *
   * 实现形态见 `classifier.ts` 的文件头：它是一次落地，是可替换件，换掉它不需要动闸门。
   */
  classifier?: ClassifierRules
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionControl: ControlSeam
    /**
     * 动作放行分类器（§24.5）。**可选服务**：闸门只认接口，实现形态仍是可替换件
     * （§24 风险 R2）。本插件带一个最小实现（`classifier.ts` 的前缀名单），但**默认不装配**
     * ——没配 `classifier` 就不 provide，缺席时 `toolRelease` 走 fail-closed 分支，
     * 行为与接线前逐字节一致。
     */
    releaseClassifier?: ReleaseClassifier
  }
}

/** Schemastery validation for {@link ControlConfig} */
export const Config: z<ControlConfig> = z.object({
  connectionString: z.string(),
  roleGrants: z.dict(z.array(z.string())),
  projectGrants: z.dict(z.array(z.string())),
  opaUrl: z.string(),
  opaToken: z.string(),
  controlPlaneUrl: z.string(),
  controlPlaneToken: z.string(),
  dispatchTimeoutMs: z.number(),
  actuationPollMs: z.number(),
  classifier: z.object({
    allowPrefixes: z.array(z.string()),
  }),
}) as unknown as z<ControlConfig>

/**
 * 主动轮询的缺省周期。取 1s 是为了与状态缓存的 TTL 同量级：**有效发现延迟 ≤ 2s**
 * （缓存命中那一轮读到的还是旧值）。再快没有意义——状态本身的写入是毫秒级，
 * 但「控制指令到达 → 执行面停手」这个端到端延迟里，1s 已经不是瓶颈。
 */
export const DEFAULT_ACTUATION_POLL_MS = 1_000

export { controlGate, controlActuation, type ControlGate, type ControlActuation } from './gate.ts'
export {
  DEFAULT_TOOL_FACTS, SIDE_EFFECT_TOOL_PREFIXES, isSideEffectTool, toolRelease,
  type ReleaseClassifier, type ToolFacts, type ToolRelease,
} from './release.ts'
// 分类器是**可替换件**（§24 风险 R2）：本插件提供一个最小实现并把它导出，是为了让
// 换掉它成为一次显式动作（换实现 + 换装配行），而不是一次对 `release.ts` 的修改。
export {
  AllowlistClassifier, classifyByAllowlist, releaseClassifierOf,
  type ClassifierRules,
} from './classifier.ts'
export {
  actuationStep, cancelSession, claimedTarget, hasPendingWork, preStepDecision,
  restoreClaimed, wakeSession,
  type ActuationStep, type ControllableAgent, type PreStepDecision,
} from './actuation.ts'

export function apply(ctx: Context, config: ControlConfig): void {
  const policy = new RbacControlPolicy({
    roleGrants: config.roleGrants ?? DEFAULT_ROLE_GRANTS,
    projectGrants: config.projectGrants,
  })
  const seam = new PgControlSeam(config.connectionString,
    config.opaUrl ? new OpaControlPolicy(config.opaUrl, policy, config.opaToken) : policy,
    {
      baseUrl: config.controlPlaneUrl,
      token: config.controlPlaneToken,
      timeoutMs: config.dispatchTimeoutMs,
    })

  // 未接线必须说出来：否则症状是「调 dispatch 抛路由错误」，而调用方会去查自己的参数，
  // 真正的原因（这个部署没配 LUMO_SESSION_CONTROL_URL）在日志里一个字都没有。
  if (!config.controlPlaneUrl?.trim()) {
    ctx.logger.info(
      'lumo/control: 未配置控制面地址（LUMO_SESSION_CONTROL_URL）—— dispatch 只会抛路由错误，' +
      '控制指令需要调用方自己 POST 到控制面；生效面（状态闸门）不受影响',
    )
  }

  ctx.effect(() => () => {
    void seam.close()
  })

  ctx.provide('sessionControl', seam)
  void seam.init()

  // 动作放行分类器（§24.5）：**可选**装配，判据在 `classifier.ts` 的 `releaseClassifierOf`。
  // 没配 = 不 provide，闸门走 fail-closed 分支（只读档下副作用工具一律人审）——「默认装配
  // 不改变既有行为」这条性质的全部实现就是下面这个分支，它由 `classifier.spec.ts` 钉住。
  const classifier = releaseClassifierOf(config.classifier)
  if (classifier === undefined) {
    ctx.logger.info(
      'lumo/control: 未装配动作放行分类器（§24.5）—— 只读档下的副作用工具一律进人审（fail-closed）',
    )
  } else {
    ctx.provide('releaseClassifier', classifier)
    // 装配了就要说出来：与上面那条「未配置控制面」同一理由——现场必须能看出这一次
    // 放行是「名单命中」还是「压根没分类器」。
    ctx.logger.info(
      'lumo/control: 已装配动作放行分类器（%d 条前缀名单）—— 名单内的副作用工具在只读档下可直接放行',
      config.classifier?.allowPrefixes.length ?? 0,
    )
  }

  /** 会话状态缓存（避免每个工具调用打一次 DB；控制指令生效延迟 ≤ ttl） */
  const stateCache = new Map<string, { state: SessionControlState; at: number }>()
  const CACHE_TTL_MS = 1_000
  // 长驻进程里会话数只增不减，过期的条目没人清 → 缓存本身成了泄漏。超过阈值时
  // 顺手把过期的扫掉（不清未过期的：那正是缓存的意义）。
  const CACHE_MAX_ENTRIES = 1_024

  const currentState = async (sessionRef: string): Promise<SessionControlState> => {
    const hit = stateCache.get(sessionRef)
    const now = Date.now()
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.state
    if (stateCache.size >= CACHE_MAX_ENTRIES) {
      for (const [key, entry] of stateCache) {
        if (now - entry.at >= CACHE_TTL_MS) stateCache.delete(key)
      }
    }
    const state = await seam.state(sessionRef)
    stateCache.set(sessionRef, { state, at: now })
    return state
  }

  /** 从挂点载荷里取出会话引用。载荷形状由上游 `Agent` 保证，这里只做安全读取。 */
  const refOf = (value: unknown): string | undefined => {
    const agent = value as { session?: { id?: unknown } } | undefined
    const id = agent?.session?.id
    return id === undefined || id === null ? undefined : String(id)
  }

  // 挂点 1：开步前 —— **停转点**（§8.1 / §8.4.1 的「turn 边界」）。
  //
  // 上游 `preStep()` 先 `inbox.claim()` 再走这个瀑布钩子，**claim 是消费**：直接 reject
  // 会把用户刚发的消息吞掉。所以先把这一批原样放回队列（不唤醒），再拒。
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionRef = refOf(payload.agent)
    if (sessionRef === undefined) return next()
    const state = await currentState(sessionRef)
    const decision = preStepDecision(
      state,
      payload.agent as unknown as ControllableAgent,
      payload.messages ?? [],
      payload.step,
    )
    if (decision.kind === 'pass') return next()

    ctx.logger.warn(
      'lumo/control: 会话 %s 处于 %s —— 停在 turn 边界（本步不放行，%d 条输入已放回队列）',
      sessionRef, state, decision.restored,
    )
    return { kind: 'reject' }
  })

  // 挂点 2：turn 边界观测。上游签名返回 void，这里**不能**停转 —— 停转由挂点 1 与主动
  // 轮询负责。此处只把现场记下来，便于把「控制面说 paused」与「agent 真的停了」对上账。
  ctx.on('agent/turn-stopping', async (payload) => {
    const sessionRef = refOf(payload.agent)
    if (sessionRef === undefined) return
    const state = await currentState(sessionRef)
    const gate = controlGate(state)
    if (gate !== 'allow') {
      ctx.logger.info('lumo/control: 会话 %s 处于 %s（闸门 %s）—— turn 到边界', sessionRef, state, gate)
    }
  })

  // 挂点 3：工具执行前置闸（瀑布，必须 next()）。这是真正的执行闸门。
  //
  // 判据全部在 `release.ts` 的 `toolRelease` 里（§24.5 的「唯一判据来源」），挂点只做
  // 「读状态 → 调它 → 记日志 / 抛错」三件事。
  ctx.on('tools/pre-execute', async function (exec, next) {
    const sessionRef = refOf(exec)
    if (sessionRef === undefined) return next()

    const state = await currentState(sessionRef)
    const toolName = String((exec as { name?: string }).name ?? '')

    // 分类器是**可选**装配：本插件只在配置里给了 `classifier` 时才 provide 自己那个最小
    // 实现（形态仍是可替换件，§24 风险 R2），否则这里拿到的是 undefined。没有它时
    // `toolRelease` 走 fail-closed 分支，行为与接线前逐字节一致——这条性质由
    // `release.spec.ts` 的接线前用例与 `classifier.spec.ts` 的装配判据共同锁住。
    const classifier = ctx.get('releaseClassifier') as ReleaseClassifier | undefined
    const release = await toolRelease(state, toolName, classifier)

    if (release.allow) {
      // 分类挡位放行的记录。**只记放行**：拒绝路径本来就有控制面的审计行，
      // 而「分类器替人放行了什么」此前没有任何地方能看到——这正是 §24.5 要求可审计的那一半。
      if (release.band !== null) {
        ctx.logger.info(
          'lumo/control: 会话 %s 状态 %s —— 分类器放行副作用工具 %s（档 %s，理由 %s）',
          sessionRef, state, toolName, release.band, release.reason,
        )
      }
      return next()
    }

    ctx.logger.warn(
      'lumo/control: 会话 %s 状态 %s —— 拒绝工具 %s（%s）',
      sessionRef, state, toolName, release.reason,
    )
    throw new Error(`lumo/control: 会话处于 ${state} —— 拒绝工具 ${toolName}（${release.reason}）`)
  })

  // 挂点 4：主动生效轮询。补上两个「没人触发就不会发生」的动作。
  const pollMs = config.actuationPollMs ?? DEFAULT_ACTUATION_POLL_MS
  if (pollMs > 0) {
    ctx.effect(() => {
      // 上一次对每个会话做过的动作。只用来防重复：`cancel` 每个状态只发一次，
      // 「挂起 → 恢复」只唤醒一次。不做去重的话，1s 一轮会把 cancel 刷成每秒一次。
      const acted = new Map<string, 'run' | 'suspend' | 'cancel'>()

      const tick = async (): Promise<void> => {
        const live = ctx.agents?.list() ?? []
        const seen = new Set<string>()
        for (const raw of live) {
          const agent = raw as unknown as ControllableAgent
          const sessionRef = String(agent.session.id)
          seen.add(sessionRef)
          const state = await currentState(sessionRef)
          const actuation = controlActuation(state)
          const previous = acted.get(sessionRef)
          const step = actuationStep(previous, actuation, hasPendingWork(agent))
          acted.set(sessionRef, actuation)

          if (step === 'cancel') {
            cancelSession(agent, state)
            ctx.logger.warn('lumo/control: 会话 %s 处于 %s —— 硬取消当前 turn', sessionRef, state)
          } else if (step === 'wake') {
            wakeSession(agent, state)
            ctx.logger.info('lumo/control: 会话 %s 已恢复（%s）—— 注入续跑注记并唤醒', sessionRef, state)
          } else if (previous !== undefined && previous !== actuation) {
            // 状态变了但没有动作（最常见的一种：恢复了但队列为空——不主动开 turn 是有意的，
            // 见 actuationStep）。记一笔，否则「按了 resume 什么都没发生」在现场看不出来。
            ctx.logger.info(
              'lumo/control: 会话 %s 由 %s 变为 %s —— 无需主动动作', sessionRef, previous, actuation,
            )
          }
        }
        // 已消失的会话不再记档：长驻进程里只增不减的 map 就是泄漏。
        for (const key of [...acted.keys()]) if (!seen.has(key)) acted.delete(key)
      }

      const timer = setInterval(() => {
        void tick().catch((error: unknown) => {
          ctx.logger.warn('lumo/control: 主动生效轮询失败（下一轮重试）', 'err', error)
        })
      }, pollMs)
      // 别让一个后台轮询把宿主进程的退出拖住。
      timer.unref?.()
      return () => {
        clearInterval(timer)
      }
    })
  } else {
    ctx.logger.info(
      'lumo/control: 主动生效轮询已关闭（actuationPollMs=0）—— abort 的硬取消与恢复后的唤醒'
      + '不会发生；停转（开步前）与工具闸门仍然生效',
    )
  }
}

export default apply
export { PgControlSeam, RbacControlPolicy, DEFAULT_ROLE_GRANTS, DEFAULT_DISPATCH_TIMEOUT_MS }
export type { ControlPlaneConfig } from './pg-control.ts'
export type { ControlSeam, SessionControlState, RoleGrants }
