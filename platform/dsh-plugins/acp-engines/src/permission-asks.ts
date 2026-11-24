/**
 * ACP session/request_permission → P0-1 统一 Ask。
 *
 * 一次权限请求投影成一个 `kind='choice'` 的 Ask：
 *   id         = `session:acp-<engineSessionId>-<seq>`（与 P0-1 `<source>:<ref>` 约定一致）
 *   source     = { kind:'session', ref, session_ref:<lumo 会话 id>, run_id:<运行树 run id>, operation:<ACP tool kind> }
 *   options    = ACP PermissionOption 原样映射（optionId → id，name → label）
 *   answer     = 选中的 optionId；reject_* 选项记为 rejected，其余 answered
 *   超时/取消  = expired / cancelled，回给 ACP `{outcome:'cancelled'}`
 *
 * 状态机复用 shared/seam-contracts/asks.ts 的 transition()，存储为进程内（会话级 Ask 只活在引擎进程生命周期内，
 * 真正的审计在 ACP 会话事件日志里）。统一列表/订阅由 BFF 路由暴露（acp-routes.ts）。
 */
import { transition, type Ask, type AskEvent, type AskEventType } from '../../../shared/seam-contracts/asks.ts'
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from './acp-protocol.ts'

export interface PermissionContext { realm: string; userId: string; projectId?: string; lumoSessionId: string; runId?: string; engineId: string }

interface PendingAsk { ask: Ask; options: PermissionOption[]; resolve: (response: RequestPermissionResponse) => void; timer?: ReturnType<typeof setTimeout> }

export const DEFAULT_PERMISSION_TTL_MS = 15 * 60_000

export class SessionAskBroker {
  private seq = 0
  private readonly pending = new Map<string, PendingAsk>()
  private readonly history = new Map<string, Ask>()
  private readonly listeners = new Set<(event: AskEvent) => void>()
  constructor(private readonly ttlMs = DEFAULT_PERMISSION_TTL_MS, private readonly now: () => number = Date.now) {}

  subscribe(listener: (event: AskEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  list(filter: { status?: string; userId?: string } = {}): Ask[] {
    return [...this.history.values()].filter(a => (!filter.status || a.status === filter.status) && (!filter.userId || a.requester_user_id === filter.userId))
  }
  get(id: string): Ask | undefined { return this.history.get(id) }

  /** 返回的 Promise 在有人回答 / 过期 / 取消时 resolve，直接作为 ACP 响应体。 */
  request(context: PermissionContext, engineSessionId: string, request: RequestPermissionRequest): { ask: Ask; response: Promise<RequestPermissionResponse> } {
    const ask = askFromPermission(context, `acp-${engineSessionId}-${++this.seq}`, request, this.now(), this.ttlMs)
    this.history.set(ask.id, ask)
    let resolve!: (r: RequestPermissionResponse) => void
    const response = new Promise<RequestPermissionResponse>(r => { resolve = r })
    const entry: PendingAsk = { ask, options: request.options, resolve }
    if (this.ttlMs > 0) {
      entry.timer = setTimeout(() => this.finish(ask.id, 'expire', undefined, 'system'), this.ttlMs)
      entry.timer.unref?.()
    }
    this.pending.set(ask.id, entry)
    this.emit('ask.created', ask)
    return { ask, response }
  }

  /** value 必须是选项 id；返回 false 表示已终态或选项非法（幂等）。 */
  answer(id: string, value: string, answeredBy: string): { ok: boolean; error?: string; ask?: Ask } {
    const entry = this.pending.get(id)
    if (entry === undefined) return { ok: false, error: this.history.has(id) ? 'ask 已结束' : 'ask 不存在' }
    const option = entry.options.find(o => o.optionId === value)
    if (option === undefined) return { ok: false, error: '无效选项' }
    if (entry.ask.requester_user_id !== answeredBy && entry.ask.requester_user_id !== '') {
      // 会话内权限只有会话主人能批；跨人审批走连接器网关那条链路
      return { ok: false, error: '只有会话发起人可以回答此权限请求' }
    }
    const ask = this.finish(id, option.kind.startsWith('reject') ? 'reject' : 'answer', value, answeredBy)
    return { ok: true, ...(ask ? { ask } : {}) }
  }

  cancel(id: string, by = 'system'): boolean { return this.finish(id, 'cancel', undefined, by) !== undefined }

  /** 会话结束 / 引擎退出时清掉它名下所有待决 Ask */
  cancelSession(lumoSessionId: string): void {
    for (const [id, entry] of this.pending) if (entry.ask.source.session_ref === lumoSessionId) this.finish(id, 'cancel', undefined, 'system')
  }

  private finish(id: string, action: 'answer' | 'reject' | 'expire' | 'cancel', value: string | undefined, by: string): Ask | undefined {
    const entry = this.pending.get(id)
    if (entry === undefined) return undefined
    const { next, ok } = transition(entry.ask.status, action)
    if (!ok) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    const at = new Date(this.now()).toISOString()
    const ask: Ask = { ...entry.ask, status: next, ...(value !== undefined ? { answer: { value, answered_by: by, answered_at: at } } : {}) }
    this.history.set(id, ask)
    entry.resolve(value !== undefined ? { outcome: { outcome: 'selected', optionId: value } } : { outcome: { outcome: 'cancelled' } })
    const type: AskEventType = next === 'answered' ? 'ask.answered' : next === 'rejected' ? 'ask.rejected' : next === 'expired' ? 'ask.expired' : 'ask.cancelled'
    this.emit(type, ask)
    return ask
  }

  private emit(type: AskEventType, ask: Ask): void {
    const event: AskEvent = { type, ask, at: new Date(this.now()).toISOString() }
    for (const l of this.listeners) { try { l(event) } catch { /* 单个订阅者异常不影响其他 */ } }
  }
}

export function askFromPermission(context: PermissionContext, ref: string, request: RequestPermissionRequest, now: number, ttlMs: number): Ask {
  const tool = request.toolCall
  const detail = describeRawInput(tool.rawInput)
  return {
    id: `session:${ref}`,
    kind: 'choice',
    status: 'pending',
    realm: context.realm,
    title: `${context.engineId} 请求权限：${tool.title ?? tool.kind ?? tool.toolCallId}`.slice(0, 300),
    ...(detail ? { detail } : {}),
    options: request.options.map(o => ({ id: o.optionId, label: o.name })),
    source: { kind: 'session', ref, session_ref: context.lumoSessionId, ...(context.runId ? { run_id: context.runId } : {}), operation: tool.kind ?? 'other' },
    requester_user_id: context.userId,
    ...(context.projectId ? { project_id: context.projectId } : {}),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + (ttlMs > 0 ? ttlMs : 365 * 86_400_000)).toISOString(),
    source_status: `acp:${tool.toolCallId}`,
  }
}

function describeRawInput(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  try { const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2); return text.length > 2000 ? `${text.slice(0, 2000)}…` : text } catch { return undefined }
}
