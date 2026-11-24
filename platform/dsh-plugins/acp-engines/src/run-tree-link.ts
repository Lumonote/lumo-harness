/**
 * ACP 会话 / 工具调用 → P0-3 运行树事件。
 *
 * 节点约定（不改 run-tree 契约，只用已有的 node.upsert / subagent.* / ask.* 事件）：
 *   ACP 会话   → run 节点   `run:acp-<lumoSessionId>`，sessionId = lumoSessionId，agent = 引擎 id
 *                若调用方给了 parentRunId（例如由某个任务派生），挂在其下
 *   工具调用   → subagent 节点（subagent.start / subagent.end），childSessionId = `acp-tool:<lumoSessionId>:<toolCallId>`，
 *                parentSessionId = lumoSessionId，于是 reducer 自动把它挂到会话 run 下
 *   权限 Ask   → ask.pending / ask.resolved（sessionRef = lumoSessionId），节点进入 awaiting_ask
 *
 * 状态映射：ACP stopReason end_turn→succeeded（回合级；会话 run 本身保持 running 直到关闭），cancelled→cancelled，
 *            refusal/max_*→failed；工具 completed→completed，failed→error。
 */
import type { RunTreeEvent, RunTreeStatus } from '../../../shared/seam-contracts/run-tree.ts'
import type { StopReason, ToolCallStatus } from './acp-protocol.ts'

export interface RunTreeSink { apply(event: RunTreeEvent): unknown }

export function acpRunId(lumoSessionId: string): string { return `acp-${lumoSessionId}` }
export function acpToolSessionId(lumoSessionId: string, toolCallId: string): string { return `acp-tool:${lumoSessionId}:${toolCallId}` }

export function stopReasonStatus(stop: StopReason | 'error'): RunTreeStatus {
  if (stop === 'end_turn') return 'succeeded'
  if (stop === 'cancelled') return 'cancelled'
  return 'failed'
}

/** ACP 工具状态 → dsh SubagentStopReason（run-tree.statusFromStopReason 的输入） */
export function toolStopReason(status: ToolCallStatus | undefined): string | undefined {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'error'
  return undefined
}

export class AcpRunTreeRecorder {
  private readonly openTools = new Set<string>()
  private readonly doneTools = new Set<string>()
  constructor(private readonly sink: RunTreeSink | undefined, private readonly lumoSessionId: string, private readonly engineId: string, private readonly options: { parentRunId?: string; title?: string; model?: string; now?: () => string } = {}) {}

  private at(): string { return this.options.now?.() ?? new Date().toISOString() }
  private emit(event: RunTreeEvent): void { try { this.sink?.apply(event) } catch { /* 运行树故障不影响会话 */ } }

  get runId(): string { return acpRunId(this.lumoSessionId) }

  sessionStarted(engineSessionId: string): void {
    this.emit({ type: 'node.upsert', node: {
      id: `run:${this.runId}`, kind: 'run', status: 'running', title: this.options.title ?? `${this.engineId} 会话`,
      agent: this.engineId, sessionId: this.lumoSessionId, startedAt: this.at(), detail: `acp:${engineSessionId}`,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.parentRunId ? { parentId: `run:${this.options.parentRunId}` } : {}),
    } })
  }

  turnStarted(): void { this.emit({ type: 'node.upsert', node: { id: `run:${this.runId}`, kind: 'run', status: 'running' } }) }

  turnEnded(stop: StopReason | 'error'): void {
    // 回合结束：未收尾的工具一律按回合结果收尾，避免树上残留 running
    for (const toolCallId of [...this.openTools]) this.toolEnded(toolCallId, stop === 'end_turn' ? 'completed' : stop === 'cancelled' ? 'aborted' : 'error')
    if (stop !== 'end_turn') this.emit({ type: 'node.upsert', node: { id: `run:${this.runId}`, kind: 'run', status: stopReasonStatus(stop) } })
    else this.emit({ type: 'node.upsert', node: { id: `run:${this.runId}`, kind: 'run', status: 'pending', detail: `空闲 · 上一回合 ${this.at()}` } })
  }

  sessionClosed(reason: 'completed' | 'cancelled' | 'failed'): void {
    for (const toolCallId of [...this.openTools]) this.toolEnded(toolCallId, 'aborted')
    const status: RunTreeStatus = reason === 'completed' ? 'succeeded' : reason
    this.emit({ type: 'node.upsert', node: { id: `run:${this.runId}`, kind: 'run', status, endedAt: this.at() } })
  }

  toolStarted(toolCallId: string, title: string | undefined, kind: string | undefined): void {
    if (this.openTools.has(toolCallId)) return
    this.openTools.add(toolCallId)
    this.emit({ type: 'subagent.start', runId: this.runId, childSessionId: acpToolSessionId(this.lumoSessionId, toolCallId), parentSessionId: this.lumoSessionId, provider: `${this.engineId}:${kind ?? 'tool'}`, at: this.at(), name: (title ?? kind ?? toolCallId).slice(0, 200) })
  }

  toolUpdated(toolCallId: string, status: ToolCallStatus | undefined, title?: string, kind?: string, summary?: string): void {
    if (this.doneTools.has(toolCallId)) return // 已收尾的工具，迟到的 update 忽略
    // 没见过 tool_call 就直接来 update 的引擎：补一个 start，保证树上有节点
    if (!this.openTools.has(toolCallId)) this.toolStarted(toolCallId, title, kind)
    const stop = toolStopReason(status)
    if (stop) this.toolEnded(toolCallId, stop, summary)
  }

  private toolEnded(toolCallId: string, stopReason: string, summary?: string): void {
    if (!this.openTools.delete(toolCallId)) return
    this.doneTools.add(toolCallId)
    this.emit({ type: 'subagent.end', runId: this.runId, childSessionId: acpToolSessionId(this.lumoSessionId, toolCallId), parentSessionId: this.lumoSessionId, provider: this.engineId, stopReason, at: this.at(), ...(summary ? { summary } : {}) })
  }

  askPending(askId: string): void { this.emit({ type: 'ask.pending', askId, runId: this.runId, sessionRef: this.lumoSessionId }) }
  askResolved(askId: string): void { this.emit({ type: 'ask.resolved', askId, runId: this.runId, sessionRef: this.lumoSessionId }) }
}
