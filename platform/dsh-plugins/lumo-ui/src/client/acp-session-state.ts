import { promptContext, type PromptContext } from '../../../acp-engines/src/prompt-context.ts'
import { attachmentRefs, type ChatAttachment } from '../../../acp-engines/src/chat-attachments.ts'
import type { SessionModels } from '../../../acp-engines/src/session-models.ts'
export interface SessionView { id: string; engineId: string; state: string; cwd: string; realm: string; userId: string; projectId?: string; createdAt?: string; updatedAt?: string; historyIncomplete?: boolean; handoff?: {sessionId: string; summary: string; createdAt?: string}; archived?: boolean; pinned?: boolean; historyOnly?: boolean; storageError?: string; commands?: Array<{name: string; description: string; input?: {hint: string}}>; modes?: {currentModeId: string; availableModes: Array<{id: string; name: string; description?: string}>}; title?: string; modelId?: string; models?: SessionModels; room?: { id: string; name: string; roleId: string; roleName: string } }
export interface SessionIdentity { realm: string; userId: string; projectId?: string }
export interface AskView { id: string; title: string; detail?: string; status: string; options?: import('../../../../shared/seam-contracts/asks.ts').AskOption[]; source: { session_ref?: string } }
export type TranscriptItem =
  | ({ kind: 'text'; role: 'agent' | 'user' | 'thought'; text: string; attachments?: ChatAttachment[] } & PromptContext)
  | { kind: 'tool'; toolCallId: string; title: string; status: string; input?: string; output?: string; locations?: Array<{path: string; line?: number}>; diffs?: Array<{path: string; oldText?: string; newText: string}>; exitCode?: number }
  | { kind: 'plan'; entries: Array<{content: string; status: string; priority?: string}> }
  | { kind: 'notice'; text: string }
export const scopeKey = (identity: SessionIdentity) => JSON.stringify([identity.realm, identity.userId, identity.projectId ?? null])
export const historyNotice = '已恢复引擎上下文；历史聊天转写不完整，此处只显示恢复后的事件。'
export async function acpCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status })
  return body
}
const toolFields = (event: Record<string, unknown>) => Object.fromEntries(['input', 'output', 'locations', 'diffs', 'exitCode'].filter(key => event[key] !== undefined).map(key => [key, event[key]]))
export function reduceTranscript(items: TranscriptItem[], event: Record<string, unknown>): TranscriptItem[] {
  switch (event.type) {
    case 'session.notice': return [...items, { kind: 'notice', text: String(event.text ?? '') }]
    case 'message.chunk': {
      const role = event.role as 'agent' | 'user' | 'thought'; const text = String(event.text ?? ''); const last = items.at(-1)
      if (last?.kind === 'text' && last.role === role && role !== 'user') return [...items.slice(0, -1), { ...last, text: last.text + text }]
      return [...items, { kind: 'text', role, text, ...promptContext(event), ...(event.attachments ? { attachments: attachmentRefs(event.attachments) } : {}) }]
    }
    case 'plan.updated':
    case 'plan': return [...items.filter(item => item.kind !== 'plan'), { kind: 'plan', entries: Array.isArray(event.entries) ? event.entries as Array<{content: string; status: string; priority?: string}> : [] }]
    case 'tool.call': return [...items, { ...toolFields(event), kind: 'tool', toolCallId: String(event.toolCallId), title: String(event.title ?? event.kind ?? '工具调用'), status: String(event.status ?? 'pending') }]
    case 'tool.update': return items.map(i => i.kind === 'tool' && i.toolCallId === event.toolCallId ? { ...i, ...toolFields(event), status: String(event.status ?? i.status), ...(event.title ? { title: String(event.title) } : {}) } : i)
    case 'turn.ended': return event.stopReason === 'end_turn' ? items : [...items, { kind: 'notice', text: `回合结束：${String(event.stopReason)}${event.error ? `（${String(event.error)}）` : ''}` }]
    case 'session.closed': return [...items, { kind: 'notice', text: '会话已关闭' }]
    default: return items
  }
}
