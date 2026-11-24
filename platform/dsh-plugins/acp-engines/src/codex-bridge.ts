/**
 * Codex app-server → ACP 桥（进程内）。
 *
 * Codex 没有原生 ACP，只有 `codex app-server`：一套自有的 stdio JSON-RPC（thread/turn/item 模型）。
 * 设计参考 gugu `electron/runtime/codex-app-server-acp.mjs` 的思路（把桥做成「对上说 ACP、
 * 对下说 app-server」的适配层，让上层只认一个协议），实现为本插件自写的精简版，只覆盖
 * 会话所需的最小子集：
 *
 * | ACP（上）                    | Codex app-server（下）                                     |
 * |-----------------------------|------------------------------------------------------------|
 * | initialize                  | initialize {clientInfo} + initialized 通知                  |
 * | session/new {cwd}           | thread/start {cwd, approvalPolicy:'on-request'} → thread.id |
 * | session/prompt              | turn/start {threadId, input} … 直到 turn/completed          |
 * | session/cancel              | turn/interrupt {threadId, turnId}                           |
 * | session/update 文本流         | item/agentMessage/delta                                     |
 * | session/update 思考流         | item/reasoning/textDelta（及 summaryTextDelta）             |
 * | tool_call / tool_call_update | item/started / item/completed（commandExecution、fileChange、mcpToolCall、webSearch） |
 * | session/request_permission  | item/commandExecution/requestApproval、item/fileChange/requestApproval |
 *
 * app-server 的方法名在 Codex 版本间有过调整；未知通知一律忽略，不让桥崩。
 */
import { JsonRpcConnection, RpcRemoteError, memoryTransportPair, type MessageTransport } from './jsonrpc.ts'
import { ACP_METHODS, ACP_PROTOCOL_VERSION, textOf, type ContentBlock, type PermissionOption, type RequestPermissionResponse, type StopReason, type ToolKind } from './acp-protocol.ts'

export const CODEX_METHODS = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  turnCompleted: 'turn/completed',
  agentDelta: 'item/agentMessage/delta',
  reasoningDelta: 'item/reasoning/textDelta',
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
} as const

export const BRIDGE_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'accept', name: '允许本次', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: '本会话内都允许', kind: 'allow_always' },
  { optionId: 'decline', name: '拒绝', kind: 'reject_once' },
]

interface CodexItem { id?: string; type?: string; command?: string | string[]; cwd?: string; changes?: unknown; server?: string; tool?: string; query?: string; status?: string; aggregatedOutput?: string; exitCode?: number }

function itemKind(type: string | undefined): ToolKind | undefined {
  switch (type) {
    case 'commandExecution': return 'execute'
    case 'fileChange': return 'edit'
    case 'mcpToolCall': return 'other'
    case 'webSearch': return 'fetch'
    default: return undefined // agentMessage / reasoning / userMessage 不是工具调用
  }
}

function itemTitle(item: CodexItem): string {
  const cmd = Array.isArray(item.command) ? item.command.join(' ') : item.command
  switch (item.type) {
    case 'commandExecution': return cmd ? `执行：${cmd}`.slice(0, 200) : '执行命令'
    case 'fileChange': return '修改文件'
    case 'mcpToolCall': return `工具：${item.server ?? ''}${item.tool ? `.${item.tool}` : ''}`
    case 'webSearch': return `搜索：${item.query ?? ''}`.slice(0, 200)
    default: return item.type ?? '工具调用'
  }
}

function turnStop(status: unknown): StopReason {
  if (status === 'interrupted') return 'cancelled'
  if (status === 'failed') return 'refusal' // ACP 没有 error 停止原因；失败以 refusal 上报，详情在 agent_message 里
  return 'end_turn'
}

function codexInput(prompt: ContentBlock[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const block of prompt) {
    if (block.type === 'text') out.push({ type: 'text', text: textOf(block) })
    else if (block.type === 'image' && typeof (block as { data?: unknown }).data === 'string') {
      const b = block as { data: string; mimeType: string }
      out.push({ type: 'image', url: `data:${b.mimeType};base64,${b.data}` })
    } else if (block.type === 'resource_link') {
      const b = block as { uri: string; name: string }
      out.push({ type: 'text', text: `@${b.name} (${b.uri})` })
    }
  }
  return out
}

interface TurnWaiter { turnId?: string; resolve: (stop: StopReason) => void }

/**
 * 在 codex 传输之上开一个 ACP agent 端，返回给上层 AcpClient 使用的 ACP 传输。
 * `codex` 是连到 `codex app-server` 子进程的传输。
 */
export function bridgeCodexToAcp(codex: MessageTransport, options: { approvalPolicy?: string; sandbox?: string; clientVersion?: string } = {}): MessageTransport {
  const [upstream, agentSide] = memoryTransportPair()
  const acp = new JsonRpcConnection(agentSide, 0)
  const cx = new JsonRpcConnection(codex, 120_000)
  /** ACP sessionId 直接用 Codex threadId */
  const turns = new Map<string, TurnWaiter>()
  const toolStatus = new Map<string, string>()

  const update = (sessionId: string, u: Record<string, unknown>) => acp.notify(ACP_METHODS.sessionUpdate, { sessionId, update: u })

  acp.onRequest(ACP_METHODS.initialize, async () => {
    await cx.request(CODEX_METHODS.initialize, { clientInfo: { name: 'lumo-acp-engines', title: 'Lumo', version: options.clientVersion ?? '0.1.0' } })
    cx.notify(CODEX_METHODS.initialized)
    return { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false } }, authMethods: [], agentInfo: { name: 'codex (app-server bridge)' } }
  })
  acp.onRequest(ACP_METHODS.sessionNew, async params => {
    const p = params as { cwd?: string }
    const result = await cx.request<{ thread?: { id?: string } }>(CODEX_METHODS.threadStart, { cwd: p.cwd, approvalPolicy: options.approvalPolicy ?? 'on-request', sandbox: options.sandbox ?? 'workspace-write' })
    const id = result?.thread?.id
    if (typeof id !== 'string' || id === '') throw new RpcRemoteError(-32603, 'codex thread/start 未返回 thread.id')
    return { sessionId: id }
  })
  acp.onRequest(ACP_METHODS.sessionLoad, async params => {
    const p = params as { sessionId: string; cwd?: string }
    await cx.request(CODEX_METHODS.threadResume, { threadId: p.sessionId, cwd: p.cwd })
    return {}
  })
  acp.onRequest(ACP_METHODS.sessionPrompt, async params => {
    const p = params as { sessionId: string; prompt: ContentBlock[] }
    if (turns.has(p.sessionId)) throw new RpcRemoteError(-32602, '该会话已有进行中的回合')
    const done = new Promise<StopReason>(resolve => { turns.set(p.sessionId, { resolve }) })
    try {
      const started = await cx.request<{ turn?: { id?: string } }>(CODEX_METHODS.turnStart, { threadId: p.sessionId, input: codexInput(p.prompt) })
      const waiter = turns.get(p.sessionId)
      if (waiter && started?.turn?.id) waiter.turnId = started.turn.id
    } catch (error) {
      turns.delete(p.sessionId)
      throw error
    }
    return { stopReason: await done }
  })
  acp.onNotification(ACP_METHODS.sessionCancel, params => {
    const p = params as { sessionId: string }
    const waiter = turns.get(p.sessionId)
    if (waiter?.turnId) void cx.request(CODEX_METHODS.turnInterrupt, { threadId: p.sessionId, turnId: waiter.turnId }).catch(() => { /* 已结束 */ })
  })

  cx.onNotification(CODEX_METHODS.agentDelta, params => {
    const p = params as { threadId: string; delta?: string }
    if (p.delta) update(p.threadId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: p.delta } })
  })
  const thought = (params: unknown) => {
    const p = params as { threadId: string; delta?: string }
    if (p.delta) update(p.threadId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: p.delta } })
  }
  cx.onNotification(CODEX_METHODS.reasoningDelta, thought)
  cx.onNotification(CODEX_METHODS.reasoningSummaryDelta, thought)
  cx.onNotification(CODEX_METHODS.itemStarted, params => {
    const p = params as { threadId: string; item?: CodexItem }
    const kind = itemKind(p.item?.type)
    if (!kind || !p.item?.id) return
    toolStatus.set(p.item.id, 'in_progress')
    update(p.threadId, { sessionUpdate: 'tool_call', toolCallId: p.item.id, title: itemTitle(p.item), kind, status: 'in_progress', rawInput: p.item, ...(p.item.cwd ? { locations: [{ path: p.item.cwd }] } : {}) })
  })
  cx.onNotification(CODEX_METHODS.itemCompleted, params => {
    const p = params as { threadId: string; item?: CodexItem }
    const kind = itemKind(p.item?.type)
    if (!kind || !p.item?.id) return
    const failed = p.item.status === 'failed' || p.item.status === 'declined' || (typeof p.item.exitCode === 'number' && p.item.exitCode !== 0)
    toolStatus.delete(p.item.id)
    update(p.threadId, { sessionUpdate: 'tool_call_update', toolCallId: p.item.id, status: failed ? 'failed' : 'completed', rawOutput: p.item, ...(p.item.aggregatedOutput ? { content: [{ type: 'content', content: { type: 'text', text: p.item.aggregatedOutput.slice(-8000) } }] } : {}) })
  })
  cx.onNotification(CODEX_METHODS.turnCompleted, params => {
    const p = params as { threadId: string; turn?: { id?: string; status?: string; error?: { message?: string } } }
    const waiter = turns.get(p.threadId)
    if (!waiter) return
    if (p.turn?.status === 'failed' && p.turn.error?.message) update(p.threadId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n[Codex 回合失败] ${p.turn.error.message}` } })
    turns.delete(p.threadId)
    waiter.resolve(turnStop(p.turn?.status))
  })

  const approval = (kind: ToolKind) => async (params: unknown): Promise<unknown> => {
    const p = params as { threadId: string; itemId?: string; command?: string | string[]; cwd?: string; reason?: string }
    const toolCallId = p.itemId ?? `approval-${Date.now()}`
    const cmd = Array.isArray(p.command) ? p.command.join(' ') : p.command
    const response = await upstream_request<RequestPermissionResponse>(ACP_METHODS.requestPermission, {
      sessionId: p.threadId,
      toolCall: { toolCallId, kind, status: 'pending', title: kind === 'execute' ? `执行：${cmd ?? ''}`.slice(0, 200) : '修改文件', rawInput: { command: cmd, cwd: p.cwd, reason: p.reason } },
      options: BRIDGE_PERMISSION_OPTIONS,
    })
    const outcome = response?.outcome
    if (outcome?.outcome === 'selected' && (outcome.optionId === 'accept' || outcome.optionId === 'acceptForSession')) return { decision: outcome.optionId }
    if (outcome?.outcome === 'cancelled') return { decision: 'cancel' }
    return { decision: 'decline' }
  }
  // 桥发往上层客户端的请求（权限）走 acp 连接
  const upstream_request = <T>(method: string, params: unknown) => acp.request<T>(method, params, 0)
  cx.onRequest(CODEX_METHODS.commandApproval, approval('execute'))
  cx.onRequest(CODEX_METHODS.fileChangeApproval, approval('edit'))

  cx.onClose(reason => {
    for (const [, waiter] of turns) waiter.resolve('cancelled')
    turns.clear()
    acp.close()
    void reason
  })
  acp.onClose(() => { if (!cx.isClosed) cx.close() })
  return upstream
}
