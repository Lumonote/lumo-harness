/**
 * 统一人工审批 / 提问（Ask）契约 —— P0-1。
 *
 * 一个 Ask 表示「执行链路在等一个人」：连接器高敏写审批、会话内 Agent 提问、
 * 远程电脑本机确认等。各子系统仍保留自己的权威存储与一次性语义（例如连接器审批
 * 的 request_hash 绑定 + consume），本契约只定义**统一的读模型与状态机**，
 * 让 UI、Agent 与审计按同一种形状消费它们。
 *
 * 设计借鉴 gugu `session/main/core/asks`：所有「需要等人」的流程走同一个闸门，
 * 但不照搬其实现；dsh 只读，渲染层复用上游 user-approval / user-questions 扩展点。
 */

export type AskKind = 'approval' | 'question' | 'choice'
export type AskStatus = 'pending' | 'answered' | 'rejected' | 'expired' | 'cancelled'
export type AskSourceKind = 'connector' | 'session' | 'run' | 'remote-computer'

export interface AskSource {
  kind: AskSourceKind
  /** 来源内的权威记录 ID（如 connector_approvals.id） */
  ref: string
  session_ref?: string
  run_id?: string
  connector_id?: string
  operation?: string
}

export interface AskOption {
  id: string; label: string
  /** ACP 原生授权范围，仅用于展示；回答仍提交不变的选项 ID。 */
  permissionKind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AskAnswer {
  /** approval: 'approve' | 'reject'；choice: 选项 id；question: 自由文本 */
  value: string
  answered_by: string
  answered_at: string
}

export interface Ask {
  id: string
  kind: AskKind
  status: AskStatus
  realm: string
  title: string
  detail?: string
  options?: AskOption[]
  source: AskSource
  requester_user_id: string
  project_id?: string
  created_at: string
  expires_at: string
  answer?: AskAnswer
  /** 来源侧的原始状态（如 connector 的 approved/consumed），仅供展示与审计 */
  source_status?: string
}

export type AskEventType = 'ask.created' | 'ask.answered' | 'ask.rejected' | 'ask.expired' | 'ask.cancelled' | 'ask.consumed'
export interface AskEvent { type: AskEventType; ask: Ask; at: string }

/** 统一 API（网关 / BFF 均按此路径暴露）。 */
export const ASK_ROUTES = {
  list: 'GET /asks',
  get: 'GET /asks/{id}',
  answer: 'POST /asks/{id}/answer',
  cancel: 'POST /asks/{id}/cancel',
  events: 'GET /asks/events',
} as const

export interface AnswerAskInput { value: string; comment?: string }

const TERMINAL: ReadonlySet<AskStatus> = new Set(['answered', 'rejected', 'expired', 'cancelled'])

export function isTerminal(status: AskStatus): boolean { return TERMINAL.has(status) }

export type AskAction = 'answer' | 'reject' | 'expire' | 'cancel'

/** 状态机：pending 是唯一可迁出的状态；终态不可再变（幂等调用返回 ok=false）。 */
export function transition(status: AskStatus, action: AskAction): { next: AskStatus; ok: boolean } {
  if (status !== 'pending') return { next: status, ok: false }
  switch (action) {
    case 'answer': return { next: 'answered', ok: true }
    case 'reject': return { next: 'rejected', ok: true }
    case 'expire': return { next: 'expired', ok: true }
    case 'cancel': return { next: 'cancelled', ok: true }
  }
}

/** 读时过期：与连接器网关 effectiveStatus 同一判据，不在读路径上改写审计记录。 */
export function effectiveStatus(ask: Pick<Ask, 'status' | 'expires_at'>, now: number = Date.now()): AskStatus {
  if (ask.status === 'pending' && Date.parse(ask.expires_at) <= now) return 'expired'
  return ask.status
}

/** 连接器审批记录（connector-gateway /approvals 的线格式）。 */
export interface ConnectorApprovalRecord {
  id: string; realm?: string; requester_user_id: string; project_id?: string
  connector_id: string; connector_version: number; operation: string
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired' | 'cancelled'
  approver_user_id?: string; created_at: string; expires_at: string
}

export const APPROVAL_OPTIONS: AskOption[] = [{ id: 'approve', label: '批准' }, { id: 'reject', label: '拒绝' }]

/** 旧连接器审批 → Ask 投影。与 Go 侧 asks.FromApproval 保持同一映射。 */
export function askFromConnectorApproval(record: ConnectorApprovalRecord): Ask {
  const status: AskStatus = record.status === 'pending' ? 'pending'
    : record.status === 'approved' || record.status === 'consumed' ? 'answered'
    : record.status === 'rejected' ? 'rejected'
    : record.status === 'cancelled' ? 'cancelled' : 'expired'
  return {
    id: `connector:${record.id}`,
    kind: 'approval',
    status,
    realm: record.realm ?? '',
    title: `连接器高敏感写入：${record.connector_id} · ${record.operation}`,
    detail: `连接器版本 v${record.connector_version}；批准仅对完全相同的请求生效一次。`,
    options: APPROVAL_OPTIONS,
    source: { kind: 'connector', ref: record.id, connector_id: record.connector_id, operation: record.operation },
    requester_user_id: record.requester_user_id,
    ...(record.project_id ? { project_id: record.project_id } : {}),
    created_at: record.created_at,
    expires_at: record.expires_at,
    ...(record.approver_user_id && status !== 'pending' && status !== 'expired'
      ? { answer: { value: status === 'rejected' ? 'reject' : 'approve', answered_by: record.approver_user_id, answered_at: record.created_at } }
      : {}),
    source_status: record.status,
  }
}

/** 给 Ask 附上执行上下文（run_id / session_ref），用于挂到 P0-3 运行树节点。空值不写。 */
export function withAskContext(ask: Ask, context: { run_id?: string; session_ref?: string }): Ask {
  const source = { ...ask.source }
  if (context.run_id?.trim() && !source.run_id) source.run_id = context.run_id.trim()
  if (context.session_ref?.trim() && !source.session_ref) source.session_ref = context.session_ref.trim()
  return { ...ask, source }
}

/** 运行树关联事件（与 lumo-ui `POST /lumo/api/run-tree/asks` 的 body 同形）。 */
export interface AskRunTreeLink { askId: string; state: 'pending' | 'resolved'; runId?: string; sessionRef?: string }
/** 进程内广播名：连接器 / owned-chat 等来源 emit，lumo-ui 运行树采集器监听。 */
export const ASK_RUN_TREE_EVENT = 'lumo/ask-link'

export function runTreeLinkOf(ask: Ask): AskRunTreeLink {
  return {
    askId: ask.id,
    state: ask.status === 'pending' ? 'pending' : 'resolved',
    ...(ask.source.run_id ? { runId: ask.source.run_id } : {}),
    ...(ask.source.session_ref ? { sessionRef: ask.source.session_ref } : {}),
  }
}

/** 从 Ask id 解析来源（`connector:<id>` 等）；未知前缀返回 undefined。 */
export function parseAskID(id: string): { kind: AskSourceKind; ref: string } | undefined {
  const m = /^(connector|session|run|remote-computer):([A-Za-z0-9._-]{1,128})$/u.exec(id)
  return m ? { kind: m[1] as AskSourceKind, ref: m[2]! } : undefined
}

export function validateAnswer(ask: Ask, input: AnswerAskInput): string | undefined {
  if (effectiveStatus(ask) !== 'pending') return 'ask 已不在待处理状态'
  const value = input.value?.trim() ?? ''
  if (value === '') return '回答不能为空'
  if ((ask.kind === 'approval' || ask.kind === 'choice') && !(ask.options ?? []).some(o => o.id === value)) return '回答不在可选项内'
  return undefined
}
