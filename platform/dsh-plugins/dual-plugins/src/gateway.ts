/**
 * DualPluginGateway：所有通道（dsh 平台 Agent / ACP 引擎 MCP / 人用页面）的**唯一执行入口**。
 *
 *   invoke(tool, args, caller)
 *     1. 查清单 + 通道是否开放（channels）
 *     2. 参数校验（validateArgs）
 *     3. 权限判定 Decide → allow / deny / ask
 *        ask：先查会话临时授权（approve_session，绑定 realm+user+session+plugin+tool，high 不发）；
 *             没有就开一个统一 Ask（P0-1），等人回答
 *     4. 登记运行树（P0-3）：有 sessionRef → subagent.start/end 挂到会话下；否则单独一个 run 节点
 *     5. 执行 handler（带 AbortSignal 与超时）
 * 返回结构化结果，从不把 deny 伪装成空结果（gugu §5.13）。
 */
import { randomUUID } from 'node:crypto'

import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'
import { approvalOf, assertManifest, channelsOf, validateArgs, type AgentToolSpec, type DualPluginManifest, type ToolChannel } from './manifest.ts'
import { FailClosedDecider, LocalDecider, RemoteDecider, type PermissionDecider, type ToolDecision } from './decide.ts'
import { ToolAskBroker, type ToolAskOutcome } from './asks.ts'

export interface Caller {
  realm?: string
  userId?: string
  projectId?: string
  /** dsh 会话 id 或 ACP 的 lumo 会话 id；用于挂运行树与会话临时授权 */
  sessionRef?: string
  runId?: string
  agentId?: string
  depth?: number
  channel: ToolChannel
}

export interface HandlerContext { caller: Required<Pick<Caller, 'realm' | 'userId' | 'channel'>> & Caller; signal: AbortSignal; decision: ToolDecision; callId: string }
export type ToolHandler = (args: Record<string, unknown>, ctx: HandlerContext) => Promise<unknown> | unknown

export type InvokeResult =
  | { ok: true; value: unknown; decisionId: string; callId: string }
  | { ok: false; code: 'unknown_tool' | 'channel_closed' | 'invalid_args' | 'denied' | 'rejected' | 'ask_expired' | 'aborted' | 'result_unknown' | 'failed' | 'disabled'; error: string; decisionId?: string; askId?: string; callId?: string }

export interface RunTreeSink { apply(event: RunTreeEvent): unknown }

export interface GatewayOptions {
  decider?: PermissionDecider
  asks?: ToolAskBroker
  runTree?: RunTreeSink
  defaults?: { realm?: string; userId?: string; projectId?: string }
  /** 等人回答的上限由 Ask TTL 决定；handler 执行超时 */
  handlerTimeoutMs?: number
  sessionGrantTtlMs?: number
  /** shadow 只旁路显式标为 advisory_deny 的灰度策略，不旁路真实拒绝或查源失败。 */
  mode?: 'enforce' | 'shadow'
  now?: () => number
}

/** 未经宿主 configure 时按环境推断：local → LocalDecider；有 LUMO_AUTHZ_DECIDE_URL → RemoteDecider；否则 fail-closed。 */
export function envDecider(env: NodeJS.ProcessEnv = process.env): PermissionDecider {
  if ((env.LUMO_DEPLOYMENT_MODE ?? '') === 'local') return new LocalDecider()
  const url = (env.LUMO_AUTHZ_DECIDE_URL ?? '').trim()
  return url ? new RemoteDecider(url) : new FailClosedDecider()
}

/** LUMO_DUAL_AUTHZ=enforce|shadow；缺省：单机 enforce（本来就默认放行），服务器形态 shadow（灰度期不改变旧工具行为）。 */
export function envMode(env: NodeJS.ProcessEnv = process.env): 'enforce' | 'shadow' {
  const v = (env.LUMO_DUAL_AUTHZ ?? '').trim().toLowerCase()
  if (v === 'enforce' || v === 'shadow') return v
  return (env.LUMO_DEPLOYMENT_MODE ?? '') === 'local' ? 'enforce' : 'shadow'
}

interface Entry { manifest: DualPluginManifest; tool: AgentToolSpec; handler: ToolHandler }

export const DEFAULT_HANDLER_TIMEOUT_MS = 120_000
export const DEFAULT_SESSION_GRANT_TTL_MS = 8 * 3600_000

export class DualPluginGateway {
  private readonly plugins = new Map<string, DualPluginManifest>()
  private readonly tools = new Map<string, Entry>()
  private readonly grants = new Map<string, number>()
  private readonly changeListeners = new Set<() => void>()
  private options: GatewayOptions
  readonly asks: ToolAskBroker
  configured = false

  constructor(options: GatewayOptions = {}) {
    this.options = options
    this.asks = options.asks ?? new ToolAskBroker()
  }

  /** 宿主（lumo-ui）装配时调用：注入判定器、运行树与缺省身份。 */
  configure(options: Omit<GatewayOptions, 'asks'>): void { this.options = { ...this.options, ...options }; this.configured = true }
  private fallbackDecider: PermissionDecider | undefined
  get decider(): PermissionDecider { return this.options.decider ?? (this.fallbackDecider ??= envDecider()) }
  get mode(): 'enforce' | 'shadow' { return this.options.mode ?? envMode() }

  onChange(l: () => void): () => void { this.changeListeners.add(l); return () => { this.changeListeners.delete(l) } }

  /** 注册一个插件：清单 + 每个工具的 handler。返回注销函数。工具名全局唯一。 */
  register(manifest: DualPluginManifest, handlers: Record<string, ToolHandler>): () => void {
    assertManifest(manifest)
    if (this.plugins.has(manifest.id)) throw new Error(`插件 ${manifest.id} 已注册`)
    for (const t of manifest.tools) {
      if (this.tools.has(t.name)) throw new Error(`工具名冲突：${t.name}`)
      if (typeof handlers[t.name] !== 'function') throw new Error(`工具 ${t.name} 缺少 handler`)
    }
    this.plugins.set(manifest.id, manifest)
    for (const t of manifest.tools) this.tools.set(t.name, { manifest, tool: t, handler: handlers[t.name]! })
    this.changed()
    return () => {
      if (this.plugins.get(manifest.id) !== manifest) return
      this.plugins.delete(manifest.id)
      for (const t of manifest.tools) if (this.tools.get(t.name)?.manifest === manifest) this.tools.delete(t.name)
      this.changed()
    }
  }

  listPlugins(): DualPluginManifest[] { return [...this.plugins.values()] }
  listTools(channel?: ToolChannel): Array<{ pluginId: string; tool: AgentToolSpec }> {
    return [...this.tools.values()].filter(e => !channel || channelsOf(e.tool).includes(channel)).map(e => ({ pluginId: e.manifest.id, tool: e.tool }))
  }
  getTool(name: string): { pluginId: string; tool: AgentToolSpec } | undefined { const e = this.tools.get(name); return e ? { pluginId: e.manifest.id, tool: e.tool } : undefined }

  revokeSession(sessionRef: string): void {
    for (const k of [...this.grants.keys()]) if (k.split('\u0000')[2] === sessionRef) this.grants.delete(k)
    this.asks.cancelSession(sessionRef)
  }

  async invoke(name: string, rawArgs: unknown, callerIn: Caller, signal?: AbortSignal): Promise<InvokeResult> {
    if (signal?.aborted) return { ok: false, code: 'aborted', error: '调用已取消，尚未开始执行' }
    const entry = this.tools.get(name)
    if (!entry) return { ok: false, code: 'unknown_tool', error: `未知工具：${name}` }
    const { manifest, tool } = entry
    if (!channelsOf(tool).includes(callerIn.channel)) return { ok: false, code: 'channel_closed', error: `工具 ${name} 未向 ${callerIn.channel} 通道开放` }
    const args = (rawArgs ?? {}) as Record<string, unknown>
    const argErrors = validateArgs(tool.parameters, args)
    if (argErrors.length > 0) return { ok: false, code: 'invalid_args', error: argErrors.slice(0, 8).join('；') }
    const d = this.options.defaults ?? {}
    const caller = { ...callerIn, realm: callerIn.realm ?? d.realm ?? '', userId: callerIn.userId ?? d.userId ?? '', ...(callerIn.projectId ?? d.projectId ? { projectId: callerIn.projectId ?? d.projectId } : {}) }
    const callId = randomUUID()

    let decision: ToolDecision
    try {
      decision = await abortable(this.decider.decide({
      realm: caller.realm, principal: { kind: 'user', id: caller.userId },
      ...(caller.agentId ? { actor: { kind: 'agent', agent_id: caller.agentId, ...(caller.runId ? { run_id: caller.runId } : {}), depth: caller.depth ?? 0 } } : {}),
      ...(caller.sessionRef ? { session_ref: caller.sessionRef } : {}),
      action: tool.action,
      resource: { realm: caller.realm, kind: 'dual-tool', id: `${manifest.id}/${tool.name}`, ...(caller.projectId ? { project_id: caller.projectId } : {}) },
      risk: tool.risk, approval: approvalOf(tool),
      }), signal)
      signal?.throwIfAborted()
    } catch (error) {
      return { ok: false, code: signal?.aborted ? 'aborted' : 'failed', error: signal?.aborted ? '调用已取消，尚未开始执行' : messageOf(error), callId }
    }
    if (decision.effect === 'deny' && this.mode === 'shadow' && decision.reason_code === 'advisory_deny') {
      const ask = approvalOf(tool) === 'always' || (approvalOf(tool) === 'auto' && tool.risk === 'high')
      decision = { ...decision, effect: ask ? 'ask' : 'allow', matched: [...decision.matched, `shadow:deny:${decision.reason_code}`] }
    }
    if (decision.effect === 'deny') return { ok: false, code: 'denied', error: `权限拒绝（${decision.reason_code}）：${decision.reason}`, decisionId: decision.decision_id, callId }

    const tree = new CallRecorder(this.options.runTree, callId, manifest.id, tool.name, caller, this.now())
    tree.start()
    if (decision.effect === 'ask') {
      const grantKey = [caller.realm, caller.userId, caller.sessionRef ?? '', caller.projectId ?? '', manifest.id, tool.name].join('\u0000')
      const grantUntil = this.grants.get(grantKey)
      if (!(tool.risk !== 'high' && caller.sessionRef && grantUntil !== undefined && grantUntil > this.now())) {
        const argsPreview = preview(args)
        const { ask, outcome } = this.asks.request({
          realm: caller.realm, userId: caller.userId, ...(caller.projectId ? { projectId: caller.projectId } : {}),
          ...(caller.sessionRef ? { sessionRef: caller.sessionRef } : {}), runId: tree.runId,
          pluginId: manifest.id, tool: tool.name, action: tool.action, risk: tool.risk, decisionId: decision.decision_id, ...(argsPreview === undefined ? {} : { argsPreview }),
        })
        tree.askPending(ask.id)
        const cancelAsk = () => { this.asks.cancel(ask.id) }
        signal?.addEventListener('abort', cancelAsk, { once: true })
        if (signal?.aborted) cancelAsk()
        let answer: ToolAskOutcome
        try { answer = await outcome }
        finally { signal?.removeEventListener('abort', cancelAsk) }
        tree.askResolved(ask.id)
        if (signal?.aborted || answer === 'cancelled') {
          tree.end('aborted', '调用已取消，尚未开始执行')
          return { ok: false, code: 'aborted', error: '调用已取消，尚未开始执行', decisionId: decision.decision_id, askId: ask.id, callId }
        }
        if (answer === 'rejected' || answer === 'expired') {
          tree.end(answer === 'rejected' ? 'refusal' : 'aborted', `审批${answer}`)
          return { ok: false, code: answer === 'rejected' ? 'rejected' : 'ask_expired', error: answer === 'rejected' ? '用户拒绝了本次调用' : `审批未完成（${answer}）`, decisionId: decision.decision_id, askId: ask.id, callId }
        }
        if (answer === 'session' && caller.sessionRef && tool.risk !== 'high') this.grants.set(grantKey, this.now() + (this.options.sessionGrantTtlMs ?? DEFAULT_SESSION_GRANT_TTL_MS))
      }
    }

    if (signal?.aborted) {
      tree.end('aborted', '调用已取消，尚未开始执行')
      return { ok: false, code: 'aborted', error: '调用已取消，尚未开始执行', decisionId: decision.decision_id, callId }
    }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('工具执行等待超时')), this.options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS)
    timer.unref?.()
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    try {
      const value = await abortable(Promise.resolve(entry.handler(args, { caller, signal: combined, decision, callId })), combined)
      combined.throwIfAborted()
      tree.end('completed')
      return { ok: true, value, decisionId: decision.decision_id, callId }
    } catch (error) {
      // 终止等待并不能证明 handler 的外部副作用已取消，迟到结果也不能覆盖终态。
      const message = combined.aborted ? '等待已结束，底层执行结果尚未确认；请查询执行结果后再重试' : messageOf(error)
      tree.end('error', message)
      return { ok: false, code: combined.aborted ? 'result_unknown' : 'failed', error: message, decisionId: decision.decision_id, callId }
    } finally { clearTimeout(timer) }
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
  private changed(): void { for (const l of this.changeListeners) { try { l() } catch { /* 忽略 */ } } }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 只取消等待；始终接收原 promise 的迟到拒绝，避免未处理 rejection。 */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('调用已取消')) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
    if (signal.aborted) abort()
  })
}

function preview(args: Record<string, unknown>): string | undefined {
  try { const s = JSON.stringify(args); return s.length > 1000 ? `${s.slice(0, 1000)}…` : s } catch { return undefined }
}

/**
 * 运行树登记：
 *   有 sessionRef：subagent 节点 `subagent:dual-tool:<callId>`，parentSessionId = sessionRef（reducer 自动挂到会话 run / 子 Agent 下）
 *   无 sessionRef（人从页面直接调用）：独立 run 节点 `run:dual-<callId>`
 * Ask 用 ask.pending / ask.resolved（runId = dual-<callId>）。
 */
export class CallRecorder {
  readonly runId: string
  private ended = false
  constructor(private readonly sink: RunTreeSink | undefined, private readonly callId: string, private readonly pluginId: string, private readonly tool: string, private readonly caller: Caller, private readonly startedAt: number) {
    this.runId = `dual-${callId}`
  }
  private emit(e: RunTreeEvent): void { try { this.sink?.apply(e) } catch { /* 运行树故障不影响调用 */ } }
  private get childSessionId(): string { return `dual-tool:${this.callId}` }
  start(): void {
    const at = new Date(this.startedAt).toISOString()
    if (this.caller.sessionRef) this.emit({ type: 'subagent.start', runId: this.runId, childSessionId: this.childSessionId, parentSessionId: this.caller.sessionRef, provider: `plugin:${this.pluginId}`, name: this.tool, at })
    else this.emit({ type: 'node.upsert', node: { id: `run:${this.runId}`, kind: 'run', status: 'running', title: `${this.pluginId} · ${this.tool}`, agent: `plugin:${this.pluginId}`, sessionId: this.childSessionId, startedAt: at, detail: `channel:${this.caller.channel}` } })
  }
  askPending(askId: string): void { this.emit({ type: 'ask.pending', askId, sessionRef: this.childSessionId, runId: this.runId }) }
  askResolved(askId: string): void { this.emit({ type: 'ask.resolved', askId, sessionRef: this.childSessionId, runId: this.runId }) }
  end(stop: 'completed' | 'error' | 'aborted' | 'refusal', summary?: string): void {
    if (this.ended) return
    this.ended = true
    const at = new Date().toISOString()
    if (this.caller.sessionRef) this.emit({ type: 'subagent.end', runId: this.runId, childSessionId: this.childSessionId, parentSessionId: this.caller.sessionRef, provider: `plugin:${this.pluginId}`, stopReason: stop, at, ...(summary ? { summary } : {}) })
    else this.emit({ type: 'node.upsert', node: { id: `run:${this.runId}`, kind: 'run', status: stop === 'completed' ? 'succeeded' : stop === 'aborted' ? 'cancelled' : 'failed', endedAt: at, ...(summary ? { detail: summary.slice(0, 2000) } : {}) } })
  }
}
