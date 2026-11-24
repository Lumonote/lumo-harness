/**
 * owned-chat 会话提问 → 统一 Ask（P0-1）。
 *
 * Agent 在 owned 会话里调用上游 `ask_user_question`（经 `userQuestions.ask` →
 * `user-questions/request` waterfall）时，本适配器把它登记为 `source.kind='session'`
 * 的 Ask（有选项 → choice，无选项 → question），经 owned transport 的
 * `interactionList` / `interactionAnswer` 暴露给页面，回答后把答案交回原调用（回传给会话）。
 *
 * 边界：
 *  - 只接管**本 Agent**、**单题**、**非 approval intent**、**非多选**的请求；连接器审批（intent=approval）
 *    仍由 SessionConnectorTools 处理，其余一律 next()，不改变上游语义。
 *  - Ask 只在内存里（与连接器 pending 一样随 Agent 生命周期），不新增存储。
 *  - 连接器审批的 Ask 投影见 `connectorAsksOf`（只读投影，回答仍走原 Decision 路径）。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { APPROVAL_OPTIONS, ASK_RUN_TREE_EVENT, runTreeLinkOf, validateAnswer, type Ask } from '../../../shared/seam-contracts/asks.ts'
import { SessionConnectorError } from './session-connectors.ts'

const DEFAULT_TTL_MS = 30 * 60_000
const MAX_PENDING = 20

interface PendingAsk { ask: Ask; resolve: (answer: AskUserQuestionAnswer) => void; reject: (reason: unknown) => void; questionId: string; labels: Map<string, string> }

export interface SessionAskAnswer { askId: string; value: string }

export function isSessionAskAnswer(value: unknown): value is SessionAskAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).every(k => k === 'askId' || k === 'value') && typeof v.askId === 'string' && typeof v.value === 'string'
}

/** 连接器 interactionList 条目 → Ask（只读投影，供统一面板展示；回答仍走 Decision）。 */
export function connectorAsksOf(sessionRef: string, realm: string, owner: string, questions: ReadonlyArray<{ questionId: string; receiptId: string; expiresAt: string; questions: AskUserQuestionRequest['questions'] }>): Ask[] {
  return questions.map(q => ({
    id: `session:${q.questionId}`.slice(0, 137),
    kind: 'approval' as const,
    status: 'pending' as const,
    realm,
    title: q.questions[0]?.header ?? q.questions[0]?.question ?? '连接器写入确认',
    ...(q.questions[0]?.question ? { detail: q.questions[0].question } : {}),
    options: APPROVAL_OPTIONS,
    source: { kind: 'session' as const, ref: q.receiptId, session_ref: sessionRef },
    requester_user_id: owner,
    created_at: new Date().toISOString(),
    expires_at: q.expiresAt,
    source_status: 'connector-receipt',
  }))
}

let seq = 0
function nextId(): string { seq = (seq + 1) % 1e9; return `q${Date.now().toString(36)}${seq.toString(36)}` }

export class SessionQuestionAsks {
  private readonly pending = new Map<Agent, Map<string, PendingAsk>>()
  private readonly installed = new WeakSet<Agent>()
  constructor(private readonly identity: (agent: Agent) => { realm: string; owner: string; runId?: string }, private readonly ttlMs = DEFAULT_TTL_MS) {}

  list(agent: Agent): Ask[] {
    const now = Date.now()
    return [...(this.pending.get(agent)?.values() ?? [])].map(p => p.ask).filter(a => Date.parse(a.expires_at) > now)
  }

  answer(agent: Agent, input: SessionAskAnswer, answeredBy: string): { accepted: true } {
    const item = this.pending.get(agent)?.get(input.askId)
    if (!item) throw new SessionConnectorError('session_connector_changed')
    const error = validateAnswer(item.ask, { value: input.value })
    if (error) throw new SessionConnectorError()
    // 先同步移除，避免并发的第二个回答抢到同一题。
    this.pending.get(agent)!.delete(input.askId)
    const value = input.value.trim()
    const label = item.labels.get(value)
    item.ask = { ...item.ask, status: 'answered', answer: { value, answered_by: answeredBy, answered_at: new Date().toISOString() } }
    this.link(agent, item.ask)
    item.resolve({ answers: [label !== undefined ? { id: item.questionId, selected: [label] } : { id: item.questionId, selected: [], custom: value }] })
    return { accepted: true }
  }

  install(agent: Agent): void {
    if (this.installed.has(agent)) return
    this.installed.add(agent)
    const pending = new Map<string, PendingAsk>()
    this.pending.set(agent, pending)
    const on = (agent.ctx as unknown as { on(name: string, cb: (request: AskUserQuestionRequest & { agent?: Agent }, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>): unknown }).on.bind(agent.ctx)
    on('user-questions/request', async (request, next) => {
      if (request.agent !== agent || request.questions.length !== 1) return next()
      const q = request.questions[0]!
      if (q.intent?.kind === 'approval' || q.multiSelect === true || pending.size >= MAX_PENDING) return next()
      const { realm, owner, runId } = this.identity(agent)
      const labels = new Map<string, string>()
      const options = (q.options ?? []).map((o, i) => { const id = `o${i + 1}`; labels.set(id, o.label); return { id, label: o.label } })
      const id = `session:${nextId()}`
      const now = Date.now()
      const ask: Ask = {
        id, kind: options.length ? 'choice' : 'question', status: 'pending', realm,
        title: (q.header ?? q.question).slice(0, 500),
        ...(q.detail || q.header ? { detail: (q.detail ?? q.question).slice(0, 4000) } : {}),
        ...(options.length ? { options } : {}),
        source: { kind: 'session', ref: q.id, session_ref: String(agent.session.id), ...(runId ? { run_id: runId } : {}) },
        requester_user_id: owner,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.ttlMs).toISOString(),
      }
      return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        const signal = request.signal
        const timer = setTimeout(() => settle('expired', new SessionConnectorError('session_connector_changed')), this.ttlMs)
        ;(timer as { unref?: () => void }).unref?.()
        const settle = (status: 'expired' | 'cancelled', reason: unknown) => {
          if (!pending.delete(id)) return
          cleanup(); this.link(agent, { ...ask, status }); reject(reason)
        }
        const abort = () => settle('cancelled', signal?.reason ?? new SessionConnectorError())
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        pending.set(id, { ask, questionId: q.id, labels, resolve: answer => { cleanup(); resolve(answer) }, reject: reason => settle('cancelled', reason) })
        this.link(agent, ask)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    })
    agent.ctx.effect(() => () => { for (const item of [...pending.values()]) item.reject(new SessionConnectorError()); pending.clear(); this.pending.delete(agent) }, 'owned session asks')
  }

  private link(agent: Agent, ask: Ask): void {
    try { (agent.ctx as unknown as { emit?: (name: string, ...args: unknown[]) => void }).emit?.(ASK_RUN_TREE_EVENT, runTreeLinkOf(ask)) } catch { /* 运行树关联失败不影响提问 */ }
  }
}
