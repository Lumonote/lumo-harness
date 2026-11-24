/**
 * 工具调用审批 → P0-1 统一 Ask。
 *   id     = `run:dual-<n>`（P0-1 `<source>:<ref>` 约定；parseAskID 可解析）
 *   kind   = approval，选项 approve_once / approve_session / reject（high 风险不给 approve_session，R6）
 *   source = { kind:'run', ref, session_ref, run_id, operation:<权限动作> }
 * 状态机复用 shared/seam-contracts/asks.ts 的 transition()。
 */
import { transition, type Ask, type AskEvent, type AskEventType, type AskOption } from '../../../shared/seam-contracts/asks.ts'

export const OPT_ONCE = 'approve_once'
export const OPT_SESSION = 'approve_session'
export const OPT_REJECT = 'reject'
export const DEFAULT_TOOL_ASK_TTL_MS = 15 * 60_000
export type ToolAskOutcome = 'once' | 'session' | 'rejected' | 'expired' | 'cancelled'

export interface ToolAskRequest {
  realm: string; userId: string; projectId?: string; sessionRef?: string; runId?: string
  pluginId: string; tool: string; action: string; risk: string; decisionId: string; argsPreview?: string
}

interface Pending { ask: Ask; resolve: (o: ToolAskOutcome) => void; timer?: ReturnType<typeof setTimeout> }

export class ToolAskBroker {
  private seq = 0
  private readonly pending = new Map<string, Pending>()
  private readonly history = new Map<string, Ask>()
  private readonly listeners = new Set<(e: AskEvent) => void>()
  constructor(private readonly ttlMs = DEFAULT_TOOL_ASK_TTL_MS, private readonly now: () => number = Date.now, private readonly maxHistory = 500) {}

  subscribe(l: (e: AskEvent) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  list(filter: { status?: string; userId?: string } = {}): Ask[] {
    return [...this.history.values()].filter(a => (!filter.status || a.status === filter.status) && (!filter.userId || a.requester_user_id === filter.userId))
  }
  get(id: string): Ask | undefined { return this.history.get(id) }

  request(req: ToolAskRequest): { ask: Ask; outcome: Promise<ToolAskOutcome> } {
    const ref = `dual-${++this.seq}`
    const options: AskOption[] = [{ id: OPT_ONCE, label: '允许本次' }, ...(req.risk === 'high' ? [] : [{ id: OPT_SESSION, label: '本会话内允许' }]), { id: OPT_REJECT, label: '拒绝' }]
    const now = this.now()
    const ask: Ask = {
      id: `run:${ref}`, kind: 'approval', status: 'pending', realm: req.realm,
      title: `${req.pluginId} · ${req.tool} 请求执行（${req.action}，风险 ${req.risk}）`.slice(0, 300),
      detail: [`decision_id=${req.decisionId}`, req.argsPreview ? `参数：${req.argsPreview}` : ''].filter(Boolean).join('\n'),
      options,
      source: { kind: 'run', ref, ...(req.sessionRef ? { session_ref: req.sessionRef } : {}), ...(req.runId ? { run_id: req.runId } : {}), operation: req.action },
      requester_user_id: req.userId, ...(req.projectId ? { project_id: req.projectId } : {}),
      created_at: new Date(now).toISOString(), expires_at: new Date(now + this.ttlMs).toISOString(), source_status: `tool:${req.tool}`,
    }
    this.history.set(ask.id, ask)
    if (this.history.size > this.maxHistory) for (const [id, a] of this.history) { if (a.status !== 'pending') { this.history.delete(id); break } }
    let resolve!: (o: ToolAskOutcome) => void
    const outcome = new Promise<ToolAskOutcome>(r => { resolve = r })
    const entry: Pending = { ask, resolve }
    if (this.ttlMs > 0) { entry.timer = setTimeout(() => this.finish(ask.id, 'expire', undefined, 'system'), this.ttlMs); entry.timer.unref?.() }
    this.pending.set(ask.id, entry)
    this.emit('ask.created', ask)
    return { ask, outcome }
  }

  /** 只有负责人（会话发起人）能回答，与 ACP 会话 Ask 一致。 */
  answer(id: string, value: string, by: string): { ok: boolean; error?: string; ask?: Ask } {
    const entry = this.pending.get(id)
    if (!entry) return { ok: false, error: this.history.has(id) ? 'ask 已结束' : 'ask 不存在' }
    if (!(entry.ask.options ?? []).some(o => o.id === value)) return { ok: false, error: '无效选项' }
    if (entry.ask.requester_user_id !== by) return { ok: false, error: '只有调用负责人可以回答' }
    const ask = this.finish(id, value === OPT_REJECT ? 'reject' : 'answer', value, by)
    return { ok: true, ...(ask ? { ask } : {}) }
  }

  cancel(id: string): boolean { return this.finish(id, 'cancel', undefined, 'system') !== undefined }
  cancelSession(sessionRef: string): void { for (const [id, e] of this.pending) if (e.ask.source.session_ref === sessionRef) this.finish(id, 'cancel', undefined, 'system') }

  private finish(id: string, action: 'answer' | 'reject' | 'expire' | 'cancel', value: string | undefined, by: string): Ask | undefined {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    const { next, ok } = transition(entry.ask.status, action)
    if (!ok) return undefined
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    const at = new Date(this.now()).toISOString()
    const ask: Ask = { ...entry.ask, status: next, ...(value !== undefined ? { answer: { value, answered_by: by, answered_at: at } } : {}) }
    this.history.set(id, ask)
    entry.resolve(next === 'answered' ? (value === OPT_SESSION ? 'session' : 'once') : next === 'rejected' ? 'rejected' : next === 'expired' ? 'expired' : 'cancelled')
    const type: AskEventType = next === 'answered' ? 'ask.answered' : next === 'rejected' ? 'ask.rejected' : next === 'expired' ? 'ask.expired' : 'ask.cancelled'
    const event: AskEvent = { type, ask, at }
    for (const l of this.listeners) { try { l(event) } catch { /* 忽略 */ } }
    return ask
  }

  private emit(type: AskEventType, ask: Ask): void {
    const event: AskEvent = { type, ask, at: new Date(this.now()).toISOString() }
    for (const l of this.listeners) { try { l(event) } catch { /* 忽略 */ } }
  }
}
