/**
 * 工具调用的权限判定适配层。
 *
 * 权威判定是 P1-12 定案的 Go 库 Decide（嵌入各服务）。本文件只定义 TS 侧的调用形状
 * （与 permission 设计 §2.2 的 Decision 子集同形），并提供三种实现：
 *   - LocalDecider：单机桌面（Local-lite）——**默认放行**，只保留 L0 硬边界（realm 一致、主体完整）、
 *     子 Agent 委派深度上限，以及清单声明的审批要求（approval=always、或 auto+high）。
 *   - RemoteDecider：服务器形态，调用治理面判定接口；**连不上 / 返回异常一律拒绝**（policy_unavailable，Q3 定案 fail-closed）。
 *   - FailClosedDecider：服务器形态但没配判定地址时使用，全部拒绝。
 */
import { randomUUID } from 'node:crypto'

import type { ApprovalPolicy, RiskLevel } from './manifest.ts'

export type Effect = 'allow' | 'deny' | 'ask'

export interface ToolDecision {
  decision_id: string
  effect: Effect
  reason: string
  reason_code: string
  matched: string[]
}

export interface DecideInput {
  realm: string
  principal: { kind: 'user'; id: string }
  actor?: { kind: 'agent'; agent_id: string; run_id?: string; depth?: number }
  session_ref?: string
  action: string
  resource: { realm: string; kind: 'dual-tool'; id: string; project_id?: string }
  risk: RiskLevel
  approval: ApprovalPolicy
}

export interface PermissionDecider { readonly adapter: string; decide(input: DecideInput): Promise<ToolDecision> }

const decision = (effect: Effect, reason_code: string, reason: string, matched: string[] = []): ToolDecision => ({ decision_id: randomUUID(), effect, reason, reason_code, matched })

/** L0：两种形态都执行的硬边界。返回 undefined 表示通过。 */
export function hardBoundary(input: DecideInput, maxDepth = 3): ToolDecision | undefined {
  if (!input.realm || input.realm !== input.resource.realm) return decision('deny', 'realm_mismatch', 'realm 不一致')
  if (!input.principal.id) return decision('deny', 'subject_incomplete', '缺少负责人身份')
  if ((input.actor?.depth ?? 0) > maxDepth) return decision('deny', 'delegation_too_deep', `委派深度超过 ${maxDepth}`)
  return undefined
}

export function needsApproval(input: Pick<DecideInput, 'risk' | 'approval'>): boolean {
  return input.approval === 'always' || (input.approval === 'auto' && input.risk === 'high')
}

export class LocalDecider implements PermissionDecider {
  readonly adapter = 'local-default-allow'
  constructor(private readonly options: { askHigh?: boolean; maxDepth?: number } = {}) {}
  async decide(input: DecideInput): Promise<ToolDecision> {
    const hard = hardBoundary(input, this.options.maxDepth)
    if (hard) return hard
    if (needsApproval(input) && (input.approval === 'always' || this.options.askHigh !== false)) return decision('ask', 'approval_required', `${input.action} 需要确认`, ['manifest:approval'])
    return decision('allow', 'local_default_allow', '单机桌面默认放行', ['local:default'])
  }
}

export class FailClosedDecider implements PermissionDecider {
  readonly adapter = 'fail-closed'
  async decide(input: DecideInput): Promise<ToolDecision> {
    return hardBoundary(input) ?? decision('deny', 'policy_unavailable', '未配置权限判定服务，按 fail-closed 拒绝')
  }
}

type FetchLike = (url: string, init: { method: string; redirect: 'error'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** 治理面判定接口（Go Decide 库的 HTTP 外壳，路径见 p1_permission_design §6 explain 同族）。 */
export const REMOTE_DECIDE_PATH = '/v1/permissions/decide'

function isToolDecision(value: unknown): value is ToolDecision {
  if (!value || typeof value !== 'object') return false
  const d = value as Partial<ToolDecision>
  return (d.effect === 'allow' || d.effect === 'deny' || d.effect === 'ask') &&
    typeof d.decision_id === 'string' && d.decision_id.trim() !== '' &&
    typeof d.reason_code === 'string' && d.reason_code.trim() !== '' && typeof d.reason === 'string' &&
    Array.isArray(d.matched) && d.matched.every(m => typeof m === 'string')
}

export class RemoteDecider implements PermissionDecider {
  readonly adapter = 'governance'
  constructor(private readonly baseUrl: string, private readonly headers: Record<string, string> = {}, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike, private readonly timeoutMs = 3000) {}
  async decide(input: DecideInput): Promise<ToolDecision> {
    const hard = hardBoundary(input)
    if (hard) return hard
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/u, '')}${REMOTE_DECIDE_PATH}`, {
        method: 'POST', redirect: 'error', headers: { ...this.headers, 'content-type': 'application/json', 'x-lumo-realm': input.realm, 'x-lumo-user': input.principal.id }, body: JSON.stringify(input), signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) return decision('deny', 'policy_unavailable', `判定服务返回 ${res.status}`)
      const body = await res.json()
      if (!isToolDecision(body)) return decision('deny', 'policy_unavailable', '判定服务返回了无法识别的结果')
      // 远端说 allow，但清单要求审批：只能收窄成 ask，不能反过来
      const effect: Effect = body.effect === 'allow' && needsApproval(input) ? 'ask' : body.effect
      if (effect !== body.effect) return { decision_id: body.decision_id, effect, reason: '工具清单要求确认', reason_code: 'approval_required', matched: [...body.matched, 'manifest:approval'] }
      return { decision_id: body.decision_id, effect, reason: body.reason, reason_code: body.reason_code, matched: body.matched }
    } catch (error) {
      return decision('deny', 'policy_unavailable', `判定服务不可用：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
