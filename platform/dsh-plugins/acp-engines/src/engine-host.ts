import { WorkspaceLeases } from './workspace-leases.ts'
import { SqliteConversationStore } from './sqlite-conversation-store.ts'
import type { ConversationStore, HistoryPage, PromptReceipt, StoredEvent } from './conversation-store.ts'
import { sessionCommands, sessionModes, toolDetail, planEntries, type SessionCommand, type SessionModes, type ToolDetail, type PlanEntry } from './session-protocol.ts'
import type { PromptContext } from './prompt-context.ts'
import type { ChatAttachment } from './chat-attachments.ts'
/**
 * EngineHost：引擎进程与 ACP 会话的生命周期管理。
 *
 *   createSession(engineId, cwd, ctx) → 拉起子进程（或 Codex 桥）→ initialize → session/new
 *   prompt(sessionId, text)           → session/prompt；期间 session/update 流式转成 SessionEvent
 *   cancel(sessionId)                 → session/cancel 通知（ACP 规定是通知）+ 取消待决权限 Ask
 *   close(sessionId)                  → 结束子进程
 *
 * 每个会话独占一个引擎进程：ACP 允许一进程多会话，但独占更易隔离 cwd / 凭据 / 崩溃半径，
 * 与 gugu「一任务一引擎进程 + 进程回收」的做法一致。
 */
import { readSessionModels, changeSessionModel, type SessionModels } from './session-models.ts'
import { SessionIndex, type RecoveryEntry } from './session-index.ts'
import { sameScope, type SessionScope } from './session-scope.ts'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { statSync } from 'node:fs'

import { JsonRpcConnection, type MessageTransport } from './jsonrpc.ts'
import { ACP_METHODS, ACP_PROTOCOL_VERSION, textOf, type ContentBlock, type InitializeResponse, type NewSessionResponse, type PromptResponse, type RequestPermissionRequest, type SessionNotification, type StopReason } from './acp-protocol.ts'
import { bridgeCodexToAcp } from './codex-bridge.ts'
import { EngineRegistry, engineEnv, type EngineProbe, type ResolvedEngine } from './registry.ts'
import { SessionAskBroker, type PermissionContext } from './permission-asks.ts'
import { AcpRunTreeRecorder, type RunTreeSink } from './run-tree-link.ts'
import { spawnStdioTransport, type Spawner, type SpawnSpec } from './stdio.ts'

export type SessionEvent =
  | { type: 'session.notice'; sessionId: string; text: string; at: string }
  | { type: 'session.commands'; sessionId: string; commands: SessionCommand[]; at: string }
  | { type: 'session.modes'; sessionId: string; modes: SessionModes; at: string }
  | { type: 'session.models'; sessionId: string; models: SessionModels; at: string }
  | { type: 'session.started'; sessionId: string; engineId: string; engineSessionId: string; at: string }
  | ({ type: 'message.chunk'; sessionId: string; role: 'agent' | 'user' | 'thought'; text: string; attachments?: ChatAttachment[]; at: string } & PromptContext)
  | ({ type: 'tool.call'; sessionId: string; toolCallId: string; title?: string; kind?: string; status?: string; at: string } & ToolDetail)
  | ({ type: 'tool.update'; sessionId: string; toolCallId: string; status?: string; title?: string; at: string } & ToolDetail)
  | { type: 'plan'; sessionId: string; entries: PlanEntry[]; at: string }
  | { type: 'permission.ask'; sessionId: string; askId: string; at: string }
  | { type: 'permission.resolved'; sessionId: string; askId: string; outcome: string; at: string }
  | { type: 'turn.started'; sessionId: string; at: string }
  | { type: 'turn.ended'; sessionId: string; stopReason: StopReason | 'error'; error?: string; at: string }
  | { type: 'session.closed'; sessionId: string; reason: string; at: string }

export interface SessionSummary extends SessionScope {
  handoff?: { sessionId: string; summary: string; createdAt: string }
  commands?: SessionCommand[] | undefined; modes?: SessionModes | undefined; archived?: boolean; pinned?: boolean; historyOnly?: boolean; storageError?: string
  id: string; engineId: string; engineSessionId: string; cwd: string; userId: string; title?: string; modelId?: string | undefined; models?: SessionModels | undefined
  state: 'starting' | 'idle' | 'running' | 'closed' | 'detached'; historyIncomplete?: boolean; createdAt: string; updatedAt?: string; capabilities?: InitializeResponse['agentCapabilities']
}

export interface CreateSessionInput extends SessionScope {
  handoff?: SessionSummary['handoff']
  engineId: string; cwd: string; parentRunId?: string; title?: string; modelId?: string | undefined
}

export interface SessionReplayInfo {
  session: SessionSummary
  seq: number
  firstSeq: number
  resetAfter?: number
  reason?: 'buffer_truncated' | 'cursor_ahead'
}

export interface EngineHostOptions {
  registry: EngineRegistry
  asks: SessionAskBroker
  runTree?: RunTreeSink
  spawner?: Spawner
  /** 测试注入：直接给出 ACP 传输，跳过子进程 */
  connect?: (engine: ResolvedEngine, spec: SpawnSpec) => MessageTransport
  maxSessions?: number
  initTimeoutMs?: number
  /** P1 双受众插件：给每个会话下发的 MCP server（平台插件工具）；缺省不下发 */
  mcpServers?: (ctx: { realm: string; userId: string; projectId?: string; sessionRef: string }) => Promise<unknown[]>
  /** 会话结束回调（用于作废 MCP token / 会话临时授权） */
  onSessionClosed?: (sessionRef: string) => void
  /** 事件环形缓冲，供断线重连补发 */
  eventBuffer?: number
  conversationStore?: ConversationStore
  recoveryIndexPath?: string
}

interface Live {
  summary: SessionSummary
  rpc: JsonRpcConnection
  recorder: AcpRunTreeRecorder
  events: Array<{ seq: number; event: SessionEvent }>
  seq: number
  pending: StoredEvent[]
  incompleteBeforeFailure?: boolean | undefined
  listeners: Set<(seq: number, event: SessionEvent) => void>
  turn?: Promise<PromptResponse>
  configuring?: boolean
  handoffSent?: boolean
  releaseWorkspace?: (() => void) | undefined
  clientMessageId?: string | undefined
}

export class EngineHost {
  private readonly sessions = new Map<string, Live>()
  private readonly unsavedClosed = new Map<string, Live>()
  private readonly branches = new Map<string, Promise<SessionSummary>>()
  private readonly startingIds = new Set<string>()
  private readonly preparations = new Map<string, AbortController>()
  private readonly index: SessionIndex
  private readonly journal: ConversationStore
  private readonly leases = new WorkspaceLeases()
  constructor(private readonly options: EngineHostOptions) {
    this.index = new SessionIndex(options.recoveryIndexPath)
    this.journal = options.conversationStore ?? new SqliteConversationStore(options.recoveryIndexPath ? join(dirname(options.recoveryIndexPath), 'acp-conversations.sqlite') : undefined)
    for (const entry of this.index.list()) if (!this.journal.get(entry.id)) this.journal.put({ ...entry, state: 'detached', capabilities: { loadSession: true }, historyIncomplete: true })
    for (const summary of this.journal.list()) if (summary.state === 'running' || summary.state === 'starting') {
      summary.state = summary.capabilities?.loadSession ? 'detached' : 'closed'
      this.journal.append(summary, [{ seq: this.journal.sequence(summary.id) + 1, event: { type: 'turn.ended', sessionId: summary.id, stopReason: 'error', error: '运行时已重启；上次回合结果未确认，请检查工具结果后决定是否重试。', at: now() } }])
    }
  }
  reserveWorkspace(cwd: string, owner: string): () => void { return this.leases.reserve(cwd, owner) }
  workspaceBusy(cwd: string, owner?: string): boolean { return this.leases.busy(cwd, owner) }
  /** Context loading is cancellable even before the engine turn starts. */
  preparePrompt(id: string, scope: SessionScope): { signal: AbortSignal; release: () => void; cancel: () => void } {
    const live = this.owned(id, scope)
    if ('error' in live) throw new Error(live.error)
    if (live.summary.state !== 'idle' || live.configuring || this.preparations.has(id)) throw new Error('上一轮或上下文加载还在进行中')
    const unlock = this.reserveWorkspace(live.summary.cwd, `session:${id}`)
    const controller = new AbortController()
    this.preparations.set(id, controller)
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (this.preparations.get(id) === controller) this.preparations.delete(id)
      controller.signal.removeEventListener('abort', release)
      unlock()
    }
    controller.signal.addEventListener('abort', release, { once: true })
    return { signal: controller.signal, release, cancel: () => controller.abort(new Error('请求已取消')) }
  }
  ensureCapacity(count: number, scope?: SessionScope, excludeIds: string[] = []): void {
    const max = this.options.maxSessions ?? 8
    if (count > max) throw new Error('请求的成员数量超过并发引擎上限')
    const candidates = [...this.sessions.values()].filter(live => live.summary.state === 'idle' && !live.configuring && !this.workspaceBusy(live.summary.cwd) && live.summary.capabilities?.loadSession && !excludeIds.includes(live.summary.id) && (!scope || sameScope(live.summary, scope))).sort((a, b) => (a.summary.updatedAt ?? a.summary.createdAt).localeCompare(b.summary.updatedAt ?? b.summary.createdAt))
    if (this.sessions.size + count - candidates.length > max) throw new Error('并发引擎会话已达上限，请先停止运行中的会话')
    while (this.sessions.size + count > max) { const live = candidates.shift()!; this.release(live.summary.id, live.summary) }
  }
  list(scope: SessionScope, query = ''): SessionSummary[] {
    const saved = new Map(this.journal.list(scope, query).map(s => [s.id, s]))
    for (const live of [...this.unsavedClosed.values(), ...this.sessions.values()]) if (sameScope(live.summary, scope) && (!query || saved.has(live.summary.id))) saved.set(live.summary.id, { ...live.summary })
    return [...saved.values()].map(s => this.sessions.has(s.id) ? s : { ...s, state: s.capabilities?.loadSession ? 'detached' as const : 'closed' as const, historyOnly: true }).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
  }
  get(id: string, scope: SessionScope): SessionSummary | undefined {
    const live = this.sessions.get(id) ?? this.unsavedClosed.get(id)
    if (live && sameScope(live.summary, scope)) return { ...live.summary, ...(live.summary.state === 'closed' ? { historyOnly: true } : {}) }
    const saved = this.journal.get(id)
    return saved && sameScope(saved, scope) ? { ...saved, state: saved.capabilities?.loadSession ? 'detached' : 'closed', historyOnly: true } : undefined
  }
  history(id: string, scope: SessionScope, before?: number, limit?: number): HistoryPage | undefined {
    const session = this.get(id, scope)
    if (!session) return undefined
    const page = this.journal.page(id, before, limit)
    const live = this.sessions.get(id) ?? this.unsavedClosed.get(id)
    if (page && live?.pending.length) {
      const cap = Math.min(1000, Math.max(1, limit ?? 200))
      const all = [...page.events, ...live.pending.filter(e => e.seq < (before ?? Number.MAX_SAFE_INTEGER))].sort((a, b) => a.seq - b.seq)
      const events = all.slice(-cap)
      return { ...page, session, events, seq: live.seq, hasMore: page.hasMore || all.length > cap, ...(events[0] ? { before: events[0].seq } : {}) }
    }
    return page ? { ...page, session } : undefined
  }
  metadata(id: string, scope: SessionScope, patch: { title?: string; archived?: boolean; pinned?: boolean }): SessionSummary {
    const summary = this.get(id, scope)
    if (!summary) throw new Error('会话不存在')
    const next = { ...summary, ...patch }
    this.journal.put(next)
    const live = this.sessions.get(id)
    if (live) Object.assign(live.summary, patch)
    return next
  }
  receipt(id: string, scope: SessionScope, clientMessageId: string, digest?: string): PromptReceipt | undefined {
    if (!this.get(id, scope)) return undefined
    const receipt = this.journal.receipt(id, clientMessageId)
    if (receipt && digest && receipt.digest !== digest) throw new Error('相同消息标识不能用于不同内容')
    return receipt
  }
  probeStatic(): EngineProbe[] { return this.options.registry.probeStatic() }

  /** 握手探测：拉起一次引擎，只做 initialize 读能力，然后关掉。 */
  async probe(engineId: string, cwd: string): Promise<EngineProbe> {
    const base = this.options.registry.probeStatic().find(p => p.id === engineId)
    if (!base) return { id: engineId, label: engineId, protocol: 'acp', available: false, reason: '未知引擎' }
    if (!base.available) return base
    let rpc: JsonRpcConnection | undefined
    try {
      rpc = this.open(engineId, cwd).rpc
      const init = await this.initialize(rpc)
      const c = init.agentCapabilities ?? {}
      return { ...base, capabilities: { loadSession: c.loadSession === true, image: c.promptCapabilities?.image === true, embeddedContext: c.promptCapabilities?.embeddedContext === true, mcpHttp: c.mcpCapabilities?.http === true }, ...(init.agentInfo?.version ? { agentVersion: init.agentInfo.version } : {}) }
    } catch (error) {
      return { ...base, available: false, reason: error instanceof Error ? error.message : String(error) }
    } finally { rpc?.close() }
  }

  async createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<SessionSummary> {
    return this.start(input, undefined, signal)
  }

  async continue(id: string, scope: SessionScope, input: { summary: string; title?: string; engineId?: string; clientRequestId?: string }, signal?: AbortSignal): Promise<SessionSummary> {
    const parent = this.get(id, scope)
    if (!parent) throw new Error('原会话不存在')
    if (!input.summary.trim() || input.summary.length > 32_000) throw new Error('请提供不超过 32000 字的交接摘要')
    const requestId = input.clientRequestId ?? randomUUID()
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId)) throw new Error('续接请求标识无效')
    const digest = promptDigest({ summary: input.summary, title: input.title ?? '', engineId: input.engineId ?? parent.engineId })
    let receipt = this.journal.branch(id, requestId)
    if (receipt && receipt.digest !== digest) throw new Error('相同续接标识不能用于不同内容')
    if (!receipt) { receipt = { id: randomUUID(), digest }; this.journal.saveBranch(id, requestId, receipt) }
    const key = `${id}:${requestId}`, pending = this.branches.get(key)
    if (pending) return pending
    const existing = this.get(receipt.id, scope)
    if (existing) return existing
    const operation = this.start({ ...scope, cwd: parent.cwd, engineId: input.engineId ?? parent.engineId, title: (input.title ?? `${parent.title ?? '对话'} · 续接`).slice(0, 200), handoff: { sessionId: id, summary: input.summary, createdAt: now() } }, undefined, signal, receipt.id)
    this.branches.set(key, operation)
    try { return await operation } finally { if (this.branches.get(key) === operation) this.branches.delete(key) }
  }

  /** 只恢复引擎上下文。绝不自动发送 prompt、回放审批或退回 session/new。 */
  async resume(id: string, scope: SessionScope, signal?: AbortSignal): Promise<SessionSummary> {
    const closed = this.unsavedClosed.get(id)
    if (closed && sameScope(closed.summary, scope)) { this.flush(closed); this.unsavedClosed.delete(id) }
    const journal = this.get(id, scope)
    const entry = journal?.capabilities?.loadSession ? journal : this.index.get(id)
    if (!entry || !sameScope(entry, scope)) throw new Error('可恢复会话不存在')
    if (this.sessions.has(id) || this.startingIds.has(id)) throw new Error('会话已连接或正在恢复')
    return this.start(entry, entry, signal)
  }

  private async start(input: CreateSessionInput, saved?: RecoveryEntry, signal?: AbortSignal, newId?: string): Promise<SessionSummary> {
    if (signal?.aborted) throw new Error('请求已取消')
    this.ensureCapacity(1, input, saved ? [saved.id] : [])
    if (!isAbsolute(input.cwd) || !isDirectory(input.cwd)) throw new Error('需要已有的本机工作区目录（绝对路径）')
    const id = saved?.id ?? newId ?? randomUUID()
    const { rpc } = this.open(input.engineId, input.cwd)
    const previous = saved ? this.journal.get(id) : undefined
    const summary: SessionSummary = { ...(previous ?? {}), id, engineId: input.engineId, engineSessionId: saved?.engineSessionId ?? '', cwd: input.cwd,
      realm: input.realm, userId: input.userId, ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.title ? { title: input.title } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.handoff ? { handoff: input.handoff } : {}), state: 'starting', createdAt: saved?.createdAt ?? now(), ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {}), ...(saved && !previous ? { historyIncomplete: true } : {}), historyOnly: false }
    const recorder = new AcpRunTreeRecorder(this.options.runTree, id, input.engineId, { ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}), ...(input.title ? { title: input.title } : {}) })
    const live: Live = { summary, rpc, recorder, events: this.journal.page(id, undefined, this.options.eventBuffer ?? 2000)?.events ?? [], seq: this.journal.sequence(id), pending: [], listeners: new Set() }
    this.sessions.set(id, live)
    this.startingIds.add(id)
    const permissionContext: PermissionContext = { realm: input.realm, userId: input.userId, ...(input.projectId !== undefined ? { projectId: input.projectId } : {}), lumoSessionId: id, runId: recorder.runId, engineId: input.engineId }
    const pendingCapabilities: SessionNotification[] = []
    rpc.onNotification(ACP_METHODS.sessionUpdate, params => {
      const notification = params as SessionNotification
      if (live.summary.state !== 'starting') this.onUpdate(live, notification)
      else if (['available_commands_update', 'current_mode_update', 'config_option_update'].includes(notification?.update?.sessionUpdate) && pendingCapabilities.length < 256) pendingCapabilities.push(notification)
    })
    rpc.onRequest(ACP_METHODS.requestPermission, async params => {
      const request = params as RequestPermissionRequest
      // 初始化/恢复可能触发历史通知；只有当前用户明确发起的回合可产生新的审批。
      if (live.summary.state !== 'running' || request.sessionId !== live.summary.engineSessionId) return { outcome: { outcome: 'cancelled' } }
      const { ask, response } = this.options.asks.request(permissionContext, summary.engineSessionId, request)
      const turnId = live.clientMessageId
      recorder.askPending(ask.id)
      this.push(live, { type: 'permission.ask', sessionId: id, askId: ask.id, at: now() })
      const result = await response
      if (this.sessions.get(id) !== live || this.sessions.get(id)?.summary.state !== 'running' || live.clientMessageId !== turnId) return { outcome: { outcome: 'cancelled' } }
      recorder.askResolved(ask.id)
      this.push(live, { type: 'permission.resolved', sessionId: id, askId: ask.id, outcome: result.outcome.outcome === 'selected' ? result.outcome.optionId : 'cancelled', at: now() })
      return result
    })
    rpc.onClose(reason => this.closed(live, reason))
    const abort = () => this.dispose(live, 'cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    const active = () => { if (this.sessions.get(id) !== live || signal?.aborted) throw new Error('会话建立已取消') }
    let preparingMcp = false
    try {
      const init = await this.initialize(rpc)
      active()
      summary.capabilities = init.agentCapabilities
      if (saved && init.agentCapabilities?.loadSession !== true) throw new Error('当前引擎不支持恢复会话')
      preparingMcp = true
      const mcpServers = await this.mcpServersFor(input, id)
      active()
      preparingMcp = false
      if (saved) {
        const loaded = await rpc.request(ACP_METHODS.sessionLoad, { sessionId: saved.engineSessionId, cwd: input.cwd, mcpServers }, this.options.initTimeoutMs ?? 60_000)
        summary.models = readSessionModels(loaded)
        summary.modes = sessionModes(loaded)
      } else {
        const created = await rpc.request<NewSessionResponse>(ACP_METHODS.sessionNew, { cwd: input.cwd, mcpServers }, this.options.initTimeoutMs ?? 60_000)
        if (typeof created?.sessionId !== 'string' || created.sessionId === '') throw new Error('引擎未返回 sessionId')
        summary.engineSessionId = created.sessionId
        summary.models = readSessionModels(created)
        summary.modes = sessionModes(created)
      }
      active()
      if (input.modelId) {
        summary.models = await changeSessionModel(rpc, summary.engineSessionId, summary.models, input.modelId)
        active()
      }
      if (summary.models?.currentModelId) summary.modelId = summary.models.currentModelId
      if (summary.capabilities?.loadSession === true) this.index.put(summary)
      summary.state = 'idle'
      this.journal.put(summary)
      recorder.sessionStarted(summary.engineSessionId)
      this.push(live, { type: 'session.started', sessionId: id, engineId: input.engineId, engineSessionId: summary.engineSessionId, at: now() })
      for (const capability of pendingCapabilities) this.onUpdate(live, capability)
      return { ...summary }
    } catch (error) {
      const alreadyClosed = live.summary.state === 'closed'
      this.dispose(live, 'failed')
      // MCP 生成可能在 abort 后才完成；再次撤销，覆盖后生成的临时 token。
      if (alreadyClosed && preparingMcp) {
        try { this.options.onSessionClosed?.(id) } catch { /* 清理不可覆盖原始失败 */ }
      }
      throw error
    } finally { signal?.removeEventListener('abort', abort); this.startingIds.delete(id) }
  }

  async setModel(id: string, scope: SessionScope, modelId: string): Promise<SessionSummary> {
    const live = this.owned(id, scope)
    if ('error' in live) throw new Error(live.error)
    if (live.summary.state !== 'idle' || live.configuring || this.preparations.has(id)) throw new Error('请等待当前回合或模型切换完成')
    live.configuring = true
    try {
      const models = await changeSessionModel(live.rpc, live.summary.engineSessionId, live.summary.models, modelId)
      if (this.sessions.get(id) !== live) throw new Error('会话已关闭')
      live.summary.models = models; live.summary.modelId = models.currentModelId
      this.push(live, { type: 'session.models', sessionId: id, models, at: now() })
      if (live.summary.capabilities?.loadSession) this.index.put(live.summary)
      return { ...live.summary }
    } finally { live.configuring = false }
  }

  async setMode(id: string, scope: SessionScope, modeId: string): Promise<SessionSummary> {
    const live = this.owned(id, scope)
    if ('error' in live) throw new Error(live.error)
    if (live.summary.state !== 'idle' || live.configuring || this.preparations.has(id)) throw new Error('请等待当前回合或设置完成')
    if (!live.summary.modes?.availableModes.some(mode => mode.id === modeId)) throw new Error('当前引擎未提供此模式')
    live.configuring = true
    try {
      await live.rpc.request('session/set_mode', { sessionId: live.summary.engineSessionId, modeId }, this.options.initTimeoutMs ?? 60_000)
      if (this.sessions.get(id) !== live) throw new Error('会话已关闭')
      live.summary.modes = { ...live.summary.modes, currentModeId: modeId }
      this.push(live, { type: 'session.modes', sessionId: id, modes: live.summary.modes, at: now() })
      return { ...live.summary }
    } finally { live.configuring = false }
  }

  /** Persist the user message and receipt before dispatch; an ambiguous turn is never replayed. */
  prompt(id: string, scope: SessionScope, prompt: string | ContentBlock[], display?: { text: string; attachments: ChatAttachment[] } & PromptContext, options: { clientMessageId?: string; workspaceOwner?: string; digest?: string; preparationSignal?: AbortSignal } = {}): { ok: true; duplicate?: boolean; receipt?: PromptReceipt } | { ok: false; error: string } {
    const clientMessageId = options.clientMessageId ?? randomUUID()
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(clientMessageId)) return { ok: false, error: '消息标识无效' }
    const digest = options.digest ?? promptDigest(display ?? prompt)
    try { const receipt = this.receipt(id, scope, clientMessageId, digest); if (receipt) return { ok: true, duplicate: true, receipt } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    const live = this.owned(id, scope)
    if ('error' in live) return { ok: false, error: live.error }
    if (options.preparationSignal?.aborted) return { ok: false, error: '请求已取消' }
    if (this.preparations.has(id) && this.preparations.get(id)?.signal !== options.preparationSignal) return { ok: false, error: '上下文正在加载' }
    if (live.configuring) return { ok: false, error: '模型或模式切换尚未完成' }
    if (live.summary.state !== 'idle') return { ok: false, error: live.summary.state === 'running' ? '上一轮还在进行中' : '会话不可用' }
    const blocks: ContentBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
    if (blocks.length === 0) return { ok: false, error: '提示词不能为空' }
    let release: (() => void) | undefined
    const previous = { ...live.summary }
    try {
      this.flush(live)
      release = this.reserveWorkspace(live.summary.cwd, options.workspaceOwner ?? `session:${id}`)
      live.summary.updatedAt = now()
      const title = (display?.text ?? (typeof prompt === 'string' ? prompt : '')).trim().replace(/\s+/gu, ' ').slice(0, 80)
      if (!live.summary.title && title) live.summary.title = title
      live.summary.state = 'running'
      delete live.summary.storageError
      const events: SessionEvent[] = [{ type: 'turn.started', sessionId: id, at: now() }]
      if (display) events.push({ type: 'message.chunk', sessionId: id, role: 'user', ...display, at: now() })
      else for (const block of blocks) if (block.type === 'text') events.push({ type: 'message.chunk', sessionId: id, role: 'user', text: textOf(block), at: now() })
      const stored = events.map((event, i) => ({ seq: live.seq + i + 1, event }))
      const receipt: PromptReceipt = { clientMessageId, digest, status: 'accepted', at: now() }
      this.journal.append(live.summary, stored, receipt)
      live.clientMessageId = clientMessageId
      live.releaseWorkspace = release
      live.recorder.turnStarted()
      for (const event of stored) this.publish(live, event)
      live.turn = live.rpc.request<PromptResponse>(ACP_METHODS.sessionPrompt, { sessionId: live.summary.engineSessionId, prompt: live.summary.handoff && !live.handoffSent ? [{ type: 'text', text: `用户确认的前序会话交接摘要：\n${live.summary.handoff.summary}\n本条用户消息仍是当前任务，请据此继续。` }, ...blocks] : blocks }, 0)
      live.handoffSent = true
      live.turn.then(result => this.endTurn(live, result?.stopReason ?? 'end_turn'), error => this.endTurn(live, 'error', error instanceof Error ? error.message : String(error)))
      return { ok: true }
    } catch (error) {
      release?.(); live.releaseWorkspace = undefined
      Object.assign(live.summary, previous)
      if (!previous.title) delete live.summary.title
      if (!previous.updatedAt) delete live.summary.updatedAt
      return { ok: false, error: `消息未发送：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  cancel(id: string, scope: SessionScope): { ok: boolean; error?: string } {
    const live = this.owned(id, scope)
    if ('error' in live) return { ok: false, error: live.error }
    const preparation = this.preparations.get(id)
    if (preparation) { preparation.abort(new Error('请求已取消')); return { ok: true } }
    if (live.summary.state !== 'running') return { ok: false, error: '当前没有进行中的回合' }
    // ACP：先取消待决权限（规范要求客户端对挂起的 request_permission 回 cancelled），再发 session/cancel
    this.options.asks.cancelSession(id)
    live.rpc.notify(ACP_METHODS.sessionCancel, { sessionId: live.summary.engineSessionId })
    return { ok: true }
  }

  /** Explicit force-stop only: retain interrupted history and never resend a prompt. */
  terminate(id: string, scope: SessionScope): boolean {
    if (!this.get(id, scope)) return false
    const live = this.sessions.get(id) ?? this.unsavedClosed.get(id)
    if (!live) return true
    if (live.summary.state === 'closed') {
      this.flush(live)
      this.unsavedClosed.delete(id)
      return true
    }
    this.dispose(live, 'terminated')
    return true
  }

  close(id: string, scope: SessionScope): boolean { return this.release(id, scope) }
  release(id: string, scope: SessionScope): boolean {
    const summary = this.get(id, scope)
    if (!summary) return false
    this.preparations.get(id)?.abort(new Error('会话已释放'))
    const live = this.sessions.get(id) ?? this.unsavedClosed.get(id)
    if (live?.summary.state === 'running' || live?.configuring) throw new Error('请先停止当前回合并等待引擎确认，再释放进程')
    if (live) this.flush(live)
    this.journal.put({ ...(live?.summary ?? summary), state: summary.capabilities?.loadSession ? 'detached' : 'closed' })
    if (live) this.dispose(live, 'completed')
    this.unsavedClosed.delete(id)
    return true
  }
  delete(id: string, scope: SessionScope): boolean {
    if (!this.get(id, scope)) return false
    this.preparations.get(id)?.abort(new Error('会话已删除'))
    const live = this.sessions.get(id)
    if (live?.summary.state === 'running' || live?.configuring) throw new Error('请先停止当前回合再删除历史')
    this.index.remove(id)
    if (live) this.dispose(live, 'completed')
    this.journal.remove(id)
    this.unsavedClosed.delete(id)
    return true
  }
  /** Runtime shutdown stops processes while preserving journals and recovery metadata. */
  closeAll(): void { for (const live of [...this.sessions.values()]) this.dispose(live, 'cancelled') }

  private dispose(live: Live, reason: 'completed' | 'cancelled' | 'failed' | 'terminated'): void {
    if (live.summary.state === 'closed') return
    live.recorder.sessionClosed(reason === 'terminated' ? 'cancelled' : reason)
    this.closed(live, reason)
    live.rpc.close()
  }

  /** 订阅会话事件；afterSeq 用于断线续传。返回取消订阅函数。 */
  subscribe(id: string, scope: SessionScope, afterSeq: number, listener: (seq: number, event: SessionEvent) => void, replayInfo?: (info: SessionReplayInfo) => void): (() => void) | undefined {
    const session = this.get(id, scope)
    if (!session) return undefined
    const live = this.sessions.get(id) ?? this.unsavedClosed.get(id)
    const events = live?.events ?? this.journal.page(id, undefined, this.options.eventBuffer ?? 2000)?.events ?? []
    const seq = live?.seq ?? this.journal.sequence(id)
    const firstSeq = events[0]?.seq ?? seq + 1
    const reason = afterSeq < firstSeq - 1 ? 'buffer_truncated' : afterSeq > seq ? 'cursor_ahead' : undefined
    const cursor = reason ? firstSeq - 1 : afterSeq
    replayInfo?.({ session, seq, firstSeq, ...(reason ? { resetAfter: cursor, reason } : {}) })
    for (const e of events) if (e.seq > cursor) listener(e.seq, e.event)
    live?.listeners.add(listener)
    return () => { live?.listeners.delete(listener) }
  }

  private owned(id: string, scope: SessionScope): Live | { error: string } {
    const live = this.sessions.get(id)
    if (!live) return { error: '会话不存在' }
    if (!sameScope(live.summary, scope)) return { error: '无权操作此会话' }
    return live
  }

  private open(engineId: string, cwd: string): { rpc: JsonRpcConnection } {
    const resolved = this.options.registry.resolve(engineId)
    if ('error' in resolved) throw new Error(resolved.error)
    const spec: SpawnSpec = { bin: resolved.bin, args: resolved.args, cwd, env: engineEnv(resolved.definition, process.env, dirname(resolved.bin)) }
    let transport: MessageTransport
    if (this.options.connect) transport = this.options.connect(resolved, spec)
    else {
      const raw = spawnStdioTransport(spec, this.options.spawner)
      transport = resolved.definition.protocol === 'codex-app-server' ? bridgeCodexToAcp(raw) : raw
    }
    return { rpc: new JsonRpcConnection(transport) }
  }

  private initialize(rpc: JsonRpcConnection): Promise<InitializeResponse> {
    return rpc.request<InitializeResponse>(ACP_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'lumo-acp-engines', version: '0.1.0' },
    }, this.options.initTimeoutMs ?? 60_000)
  }

  private onUpdate(live: Live, n: SessionNotification): void {
    if (live.summary.state === 'closed') return
    if (!n || n.sessionId !== live.summary.engineSessionId || !n.update) return
    const id = live.summary.id
    const u = n.update as Record<string, unknown> & { sessionUpdate: string }
    switch (u.sessionUpdate) {
      case 'available_commands_update':
        live.summary.commands = sessionCommands(u.availableCommands)
        this.push(live, { type: 'session.commands', sessionId: id, commands: live.summary.commands, at: now() })
        return
      case 'current_mode_update':
        if (typeof u.currentModeId === 'string' && live.summary.modes) {
          live.summary.modes = { ...live.summary.modes, currentModeId: u.currentModeId }
          this.push(live, { type: 'session.modes', sessionId: id, modes: live.summary.modes, at: now() })
        }
        return
      case 'config_option_update': {
        const models = readSessionModels(u)
        if (models) {
          live.summary.models = models; live.summary.modelId = models.currentModelId
          this.push(live, { type: 'session.models', sessionId: id, models, at: now() })
          try { if (live.summary.capabilities?.loadSession) this.index.put(live.summary) }
          catch { this.push(live, { type: 'session.notice', sessionId: id, text: '当前模型已更新，但恢复配置保存失败；请在重启前重试模型切换。', at: now() }) }
        }
        return
      }
      case 'agent_message_chunk': case 'user_message_chunk': case 'agent_thought_chunk': {
        const text = textOf(u.content as ContentBlock)
        if (!text) return
        const role = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'user'
        if (role === 'user') return // 用户消息由 prompt() 自己回显，引擎回放的跳过
        this.push(live, { type: 'message.chunk', sessionId: id, role, text, at: now() })
        return
      }
      case 'tool_call': {
        const toolCallId = String(u.toolCallId ?? '')
        if (!toolCallId) return
        const title = typeof u.title === 'string' ? u.title : undefined
        const kind = typeof u.kind === 'string' ? u.kind : undefined
        const status = typeof u.status === 'string' ? u.status : undefined
        live.recorder.toolStarted(toolCallId, title, kind)
        if (status === 'completed' || status === 'failed') live.recorder.toolUpdated(toolCallId, status)
        this.push(live, { type: 'tool.call', sessionId: id, toolCallId, ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...toolDetail(u), at: now() })
        return
      }
      case 'tool_call_update': {
        const toolCallId = String(u.toolCallId ?? '')
        if (!toolCallId) return
        const status = typeof u.status === 'string' ? u.status : undefined
        const title = typeof u.title === 'string' ? u.title : undefined
        live.recorder.toolUpdated(toolCallId, status as 'completed' | undefined, title, typeof u.kind === 'string' ? u.kind : undefined)
        this.push(live, { type: 'tool.update', sessionId: id, toolCallId, ...(status ? { status } : {}), ...(title ? { title } : {}), ...toolDetail(u), at: now() })
        return
      }
      case 'plan':
        this.push(live, { type: 'plan', sessionId: id, entries: planEntries(u.entries), at: now() })
        return
      default: return
    }
  }

  private endTurn(live: Live, stop: StopReason | 'error', error?: string): void {
    this.options.asks.cancelSession(live.summary.id)
    delete live.turn
    live.releaseWorkspace?.(); live.releaseWorkspace = undefined
    if (live.summary.state === 'closed') return
    live.summary.state = 'idle'
    live.recorder.turnEnded(stop)
    this.push(live, { type: 'turn.ended', sessionId: live.summary.id, stopReason: stop, ...(error ? { error } : {}), at: now() })
  }

  private closed(live: Live, reason: string): void {
    if (live.summary.state === 'closed' || this.sessions.get(live.summary.id) !== live) return
    this.preparations.get(live.summary.id)?.abort(new Error('引擎连接已结束'))
    const starting = live.summary.state === 'starting'
    const running = live.summary.state === 'running'
    live.summary.state = 'closed'
    if (starting && reason === 'terminated' && !live.summary.engineSessionId && live.summary.capabilities) {
      live.summary.capabilities = { ...live.summary.capabilities, loadSession: false }
    }
    live.releaseWorkspace?.(); live.releaseWorkspace = undefined
    if (running) this.push(live, { type: 'turn.ended', sessionId: live.summary.id, stopReason: 'error', error: reason === 'terminated' ? '引擎已强制结束；执行结果未确认，请核对实际修改后再继续。' : `引擎连接结束：${reason}`, at: now() })
    this.options.asks.cancelSession(live.summary.id)
    try { this.options.onSessionClosed?.(live.summary.id) } catch { /* 忽略 */ }
    if (!['completed', 'cancelled', 'failed', 'terminated'].includes(reason)) live.recorder.sessionClosed('failed')
    if (!starting || reason === 'terminated') this.push(live, { type: 'session.closed', sessionId: live.summary.id, reason, at: now() })
    this.sessions.delete(live.summary.id)
    if (live.pending.length) this.unsavedClosed.set(live.summary.id, live)
    live.listeners.clear()
  }

  private async mcpServersFor(input: CreateSessionInput, sessionRef: string): Promise<unknown[]> {
    if (!this.options.mcpServers) return []
    return this.options.mcpServers({ realm: input.realm, userId: input.userId, ...(input.projectId !== undefined ? { projectId: input.projectId } : {}), sessionRef })
  }

  /** Keep uncommitted events until the same batch can be durably retried. */
  private flush(live: Live): void {
    if (!live.pending.length) return
    const error = live.summary.storageError, incomplete = live.summary.historyIncomplete
    delete live.summary.storageError
    if (error && !live.incompleteBeforeFailure) delete live.summary.historyIncomplete
    try {
      this.journal.append(live.summary, live.pending)
      live.pending = []; live.incompleteBeforeFailure = undefined
    } catch (failure) {
      if (error) live.summary.storageError = error
      if (incomplete !== undefined) live.summary.historyIncomplete = incomplete
      throw failure
    }
  }
  private push(live: Live, event: SessionEvent): void {
    const stored = { seq: live.seq + 1, event }
    live.pending.push(stored)
    try { this.flush(live) }
    catch (error) {
      const firstFailure = !live.summary.storageError
      if (firstFailure) live.incompleteBeforeFailure = live.summary.historyIncomplete
      live.summary.historyIncomplete = true
      live.summary.storageError = `会话记录保存失败，已保留待重试事件并请求停止执行：${error instanceof Error ? error.message : String(error)}`
      this.publish(live, stored)
      if (firstFailure) {
        const notice: StoredEvent = { seq: live.seq + 1, event: { type: 'session.notice', sessionId: live.summary.id, text: live.summary.storageError, at: now() } }
        live.pending.push(notice); this.publish(live, notice)
        if (live.summary.state === 'running') {
          this.options.asks.cancelSession(live.summary.id)
          live.rpc.notify(ACP_METHODS.sessionCancel, { sessionId: live.summary.engineSessionId })
        }
      }
      return
    }
    this.publish(live, stored)
  }
  private publish(live: Live, stored: StoredEvent): void {
    live.seq = stored.seq
    live.events.push(stored)
    const cap = this.options.eventBuffer ?? 2000
    if (live.events.length > cap) live.events.splice(0, live.events.length - cap)
    for (const listener of live.listeners) { try { listener(stored.seq, stored.event) } catch { /* independent subscribers */ } }
  }

}

function now(): string { return new Date().toISOString() }
function isDirectory(path: string): boolean { try { return statSync(path).isDirectory() } catch { return false } }

export function promptDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
