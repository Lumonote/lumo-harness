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
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

import { JsonRpcConnection, type MessageTransport } from './jsonrpc.ts'
import { ACP_METHODS, ACP_PROTOCOL_VERSION, textOf, type ContentBlock, type InitializeResponse, type NewSessionResponse, type PromptResponse, type RequestPermissionRequest, type SessionNotification, type StopReason } from './acp-protocol.ts'
import { bridgeCodexToAcp } from './codex-bridge.ts'
import { EngineRegistry, engineEnv, type EngineProbe, type ResolvedEngine } from './registry.ts'
import { SessionAskBroker, type PermissionContext } from './permission-asks.ts'
import { AcpRunTreeRecorder, type RunTreeSink } from './run-tree-link.ts'
import { spawnStdioTransport, type Spawner, type SpawnSpec } from './stdio.ts'

export type SessionEvent =
  | { type: 'session.started'; sessionId: string; engineId: string; engineSessionId: string; at: string }
  | { type: 'message.chunk'; sessionId: string; role: 'agent' | 'user' | 'thought'; text: string; at: string }
  | { type: 'tool.call'; sessionId: string; toolCallId: string; title?: string; kind?: string; status?: string; at: string }
  | { type: 'tool.update'; sessionId: string; toolCallId: string; status?: string; title?: string; at: string }
  | { type: 'plan'; sessionId: string; entries: unknown[]; at: string }
  | { type: 'permission.ask'; sessionId: string; askId: string; at: string }
  | { type: 'permission.resolved'; sessionId: string; askId: string; outcome: string; at: string }
  | { type: 'turn.started'; sessionId: string; at: string }
  | { type: 'turn.ended'; sessionId: string; stopReason: StopReason | 'error'; error?: string; at: string }
  | { type: 'session.closed'; sessionId: string; reason: string; at: string }

export interface SessionSummary {
  id: string; engineId: string; engineSessionId: string; cwd: string; userId: string
  state: 'starting' | 'idle' | 'running' | 'closed'; createdAt: string; capabilities?: InitializeResponse['agentCapabilities']
}

export interface CreateSessionInput {
  engineId: string; cwd: string; realm: string; userId: string; projectId?: string; parentRunId?: string; title?: string
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
}

interface Live {
  summary: SessionSummary
  rpc: JsonRpcConnection
  recorder: AcpRunTreeRecorder
  events: Array<{ seq: number; event: SessionEvent }>
  seq: number
  listeners: Set<(seq: number, event: SessionEvent) => void>
  turn?: Promise<PromptResponse>
}

export class EngineHost {
  private readonly sessions = new Map<string, Live>()
  constructor(private readonly options: EngineHostOptions) {}

  list(userId?: string): SessionSummary[] { return [...this.sessions.values()].map(s => s.summary).filter(s => !userId || s.userId === userId) }
  get(id: string): SessionSummary | undefined { return this.sessions.get(id)?.summary }
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

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    if (this.sessions.size >= (this.options.maxSessions ?? 8)) throw new Error('并发引擎会话已达上限')
    if (!isAbsolute(input.cwd) || !isDirectory(input.cwd)) throw new Error('需要已有的本机工作区目录（绝对路径）')
    const id = randomUUID()
    const { rpc } = this.open(input.engineId, input.cwd)
    const summary: SessionSummary = { id, engineId: input.engineId, engineSessionId: '', cwd: input.cwd, userId: input.userId, state: 'starting', createdAt: new Date().toISOString() }
    const recorder = new AcpRunTreeRecorder(this.options.runTree, id, input.engineId, { ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}), ...(input.title ? { title: input.title } : {}) })
    const live: Live = { summary, rpc, recorder, events: [], seq: 0, listeners: new Set() }
    this.sessions.set(id, live)
    const permissionContext: PermissionContext = { realm: input.realm, userId: input.userId, ...(input.projectId ? { projectId: input.projectId } : {}), lumoSessionId: id, runId: recorder.runId, engineId: input.engineId }

    rpc.onNotification(ACP_METHODS.sessionUpdate, params => this.onUpdate(live, params as SessionNotification))
    rpc.onRequest(ACP_METHODS.requestPermission, async params => {
      const request = params as RequestPermissionRequest
      const { ask, response } = this.options.asks.request(permissionContext, summary.engineSessionId, request)
      recorder.askPending(ask.id)
      this.push(live, { type: 'permission.ask', sessionId: id, askId: ask.id, at: now() })
      const result = await response
      recorder.askResolved(ask.id)
      this.push(live, { type: 'permission.resolved', sessionId: id, askId: ask.id, outcome: result.outcome.outcome === 'selected' ? result.outcome.optionId : 'cancelled', at: now() })
      return result
    })
    // 本插件不向引擎开放 fs/terminal 能力（initialize 里声明 false），引擎用自己的工具读写工作区；
    // 这样权限闸门完全落在引擎自身的 request_permission 上，不会出现两套文件权限。
    rpc.onClose(reason => this.closed(live, reason))

    try {
      const init = await this.initialize(rpc)
      summary.capabilities = init.agentCapabilities
      const created = await rpc.request<NewSessionResponse>(ACP_METHODS.sessionNew, { cwd: input.cwd, mcpServers: await this.mcpServersFor(input, id) }, this.options.initTimeoutMs ?? 60_000)
      if (typeof created?.sessionId !== 'string' || created.sessionId === '') throw new Error('引擎未返回 sessionId')
      summary.engineSessionId = created.sessionId
      summary.state = 'idle'
      recorder.sessionStarted(created.sessionId)
      this.push(live, { type: 'session.started', sessionId: id, engineId: input.engineId, engineSessionId: created.sessionId, at: now() })
      return summary
    } catch (error) {
      this.close(id, 'failed')
      throw error
    }
  }

  /** 发起一轮；立即返回，结果走事件流（turn.ended）。 */
  prompt(id: string, userId: string, prompt: string | ContentBlock[]): { ok: true } | { ok: false; error: string } {
    const live = this.owned(id, userId)
    if ('error' in live) return { ok: false, error: live.error }
    if (live.summary.state !== 'idle') return { ok: false, error: live.summary.state === 'running' ? '上一轮还在进行中' : '会话不可用' }
    const blocks: ContentBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
    if (blocks.length === 0) return { ok: false, error: '提示词不能为空' }
    live.summary.state = 'running'
    live.recorder.turnStarted()
    this.push(live, { type: 'turn.started', sessionId: id, at: now() })
    for (const b of blocks) if (b.type === 'text') this.push(live, { type: 'message.chunk', sessionId: id, role: 'user', text: textOf(b), at: now() })
    live.turn = live.rpc.request<PromptResponse>(ACP_METHODS.sessionPrompt, { sessionId: live.summary.engineSessionId, prompt: blocks }, 0)
    live.turn.then(result => {
      const stop = result?.stopReason ?? 'end_turn'
      this.endTurn(live, stop)
    }, error => this.endTurn(live, 'error', error instanceof Error ? error.message : String(error)))
    return { ok: true }
  }

  cancel(id: string, userId: string): { ok: boolean; error?: string } {
    const live = this.owned(id, userId)
    if ('error' in live) return { ok: false, error: live.error }
    if (live.summary.state !== 'running') return { ok: false, error: '当前没有进行中的回合' }
    // ACP：先取消待决权限（规范要求客户端对挂起的 request_permission 回 cancelled），再发 session/cancel
    this.options.asks.cancelSession(id)
    live.rpc.notify(ACP_METHODS.sessionCancel, { sessionId: live.summary.engineSessionId })
    return { ok: true }
  }

  close(id: string, reason: 'completed' | 'cancelled' | 'failed' = 'completed', userId?: string): boolean {
    const live = this.sessions.get(id)
    if (!live || (userId !== undefined && live.summary.userId !== userId)) return false
    live.recorder.sessionClosed(reason)
    this.closed(live, reason) // 先登记关闭，避免 rpc.close 回调再按「异常退出」记一次
    live.rpc.close()
    return true
  }

  closeAll(): void { for (const id of [...this.sessions.keys()]) this.close(id, 'cancelled') }

  /** 订阅会话事件；afterSeq 用于断线续传。返回取消订阅函数。 */
  subscribe(id: string, userId: string, afterSeq: number, listener: (seq: number, event: SessionEvent) => void): (() => void) | undefined {
    const live = this.sessions.get(id)
    if (!live || live.summary.userId !== userId) return undefined
    for (const e of live.events) if (e.seq > afterSeq) listener(e.seq, e.event)
    live.listeners.add(listener)
    return () => { live.listeners.delete(listener) }
  }

  private owned(id: string, userId: string): Live | { error: string } {
    const live = this.sessions.get(id)
    if (!live) return { error: '会话不存在' }
    if (live.summary.userId !== userId) return { error: '无权操作此会话' }
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
    if (!n || n.sessionId !== live.summary.engineSessionId || !n.update) return
    const id = live.summary.id
    const u = n.update as Record<string, unknown> & { sessionUpdate: string }
    switch (u.sessionUpdate) {
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
        this.push(live, { type: 'tool.call', sessionId: id, toolCallId, ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), at: now() })
        return
      }
      case 'tool_call_update': {
        const toolCallId = String(u.toolCallId ?? '')
        if (!toolCallId) return
        const status = typeof u.status === 'string' ? u.status : undefined
        const title = typeof u.title === 'string' ? u.title : undefined
        live.recorder.toolUpdated(toolCallId, status as 'completed' | undefined, title, typeof u.kind === 'string' ? u.kind : undefined)
        this.push(live, { type: 'tool.update', sessionId: id, toolCallId, ...(status ? { status } : {}), ...(title ? { title } : {}), at: now() })
        return
      }
      case 'plan':
        this.push(live, { type: 'plan', sessionId: id, entries: Array.isArray(u.entries) ? u.entries : [], at: now() })
        return
      default: return // available_commands_update / current_mode_update 等暂不展示
    }
  }

  private endTurn(live: Live, stop: StopReason | 'error', error?: string): void {
    delete live.turn
    if (live.summary.state === 'closed') return
    live.summary.state = 'idle'
    live.recorder.turnEnded(stop)
    this.push(live, { type: 'turn.ended', sessionId: live.summary.id, stopReason: stop, ...(error ? { error } : {}), at: now() })
  }

  private closed(live: Live, reason: string): void {
    if (live.summary.state === 'closed') return
    live.summary.state = 'closed'
    this.options.asks.cancelSession(live.summary.id)
    try { this.options.onSessionClosed?.(live.summary.id) } catch { /* 忽略 */ }
    if (!['completed', 'cancelled', 'failed'].includes(reason)) live.recorder.sessionClosed('failed')
    this.push(live, { type: 'session.closed', sessionId: live.summary.id, reason, at: now() })
    this.sessions.delete(live.summary.id)
    live.listeners.clear()
  }

  private async mcpServersFor(input: CreateSessionInput, sessionRef: string): Promise<unknown[]> {
    if (!this.options.mcpServers) return []
    try { return await this.options.mcpServers({ realm: input.realm, userId: input.userId, ...(input.projectId ? { projectId: input.projectId } : {}), sessionRef }) } catch { return [] }
  }

  private push(live: Live, event: SessionEvent): void {
    const seq = ++live.seq
    live.events.push({ seq, event })
    const cap = this.options.eventBuffer ?? 2000
    if (live.events.length > cap) live.events.splice(0, live.events.length - cap)
    for (const l of live.listeners) { try { l(seq, event) } catch { /* 忽略 */ } }
  }
}

function now(): string { return new Date().toISOString() }
function isDirectory(path: string): boolean { try { return statSync(path).isDirectory() } catch { return false } }
