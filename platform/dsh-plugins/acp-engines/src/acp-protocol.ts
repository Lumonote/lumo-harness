/**
 * ACP（Agent Client Protocol）客户端用到的最小协议面。
 * 字段名对齐 ACP v1 规范（agentclientprotocol.com）：initialize / session/new /
 * session/prompt / session/cancel / session/update / session/request_permission。
 * 只声明本插件真正读写的字段，其余透传（unknown）。
 */

export const ACP_PROTOCOL_VERSION = 1

export const ACP_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
  fsRead: 'fs/read_text_file',
  fsWrite: 'fs/write_text_file',
} as const

export interface ClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean }
  terminal: boolean
}

export interface InitializeRequest { protocolVersion: number; clientCapabilities: ClientCapabilities; clientInfo?: { name: string; version: string } }
export interface InitializeResponse {
  protocolVersion: number
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    mcpCapabilities?: { http?: boolean; sse?: boolean }
  }
  authMethods?: Array<{ id: string; name: string; description?: string }>
  agentInfo?: { name?: string; version?: string }
}

export interface McpServerStdio { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
export interface NewSessionRequest { cwd: string; mcpServers: McpServerStdio[] }
export interface NewSessionResponse { sessionId: string; modes?: unknown; models?: unknown }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string }
  | { type: string; [key: string]: unknown }

export interface PromptRequest { sessionId: string; prompt: ContentBlock[] }
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
export interface PromptResponse { stopReason: StopReason }

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'

export interface ToolCallFields {
  toolCallId: string
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  content?: unknown[]
  locations?: Array<{ path: string; line?: number }>
  rawInput?: unknown
  rawOutput?: unknown
}

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' } & ToolCallFields)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallFields)
  | { sessionUpdate: 'plan'; entries: Array<{ content: string; priority?: string; status?: string }> }
  | { sessionUpdate: 'available_commands_update'; availableCommands: unknown[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: string; [key: string]: unknown }

export interface SessionNotification { sessionId: string; update: SessionUpdate }

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
export interface PermissionOption { optionId: string; name: string; kind: PermissionOptionKind }
export interface RequestPermissionRequest { sessionId: string; toolCall: ToolCallFields; options: PermissionOption[] }
export type RequestPermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
export interface RequestPermissionResponse { outcome: RequestPermissionOutcome }

export function textOf(block: ContentBlock | undefined): string {
  return block && block.type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''
}
