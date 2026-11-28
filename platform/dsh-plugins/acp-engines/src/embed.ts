import type { AgentSkills } from './prompt-context.ts'
/**
 * 嵌入入口：不依赖 Cordis / webServer 类型，供 lumo-ui 直接相对导入（lumo-ui 不需要把本包加进依赖）。
 * 开关语义见 index.ts 顶部注释。
 */
import { EngineHost, type EngineHostOptions } from './engine-host.ts'
import { SessionAskBroker } from './permission-asks.ts'
import { BUILTIN_ENGINES, EngineRegistry } from './registry.ts'
import type { RunTreeSink } from './run-tree-link.ts'
import { dirname, join } from 'node:path'
import { RoleRooms } from './role-rooms.ts'
import { AttachmentStore } from './attachment-store.ts'
import { RoleRoomStore } from './role-room-store.ts'

export { handleAcpRoute, ACP_PREFIX, type AcpRouteDeps } from './routes.ts'

export interface AcpEngines { host: EngineHost; asks: SessionAskBroker; rooms: RoleRooms; attachments: AttachmentStore; skills?: AgentSkills | undefined }

export function acpEnginesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LUMO_ACP_ENGINES ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'legacy')
}

/** 关闭时返回 undefined；路由据此回 501。 */
export function createAcpEngines(options: { skills?: AgentSkills; recoveryIndexPath?: string; runTree?: RunTreeSink; env?: NodeJS.ProcessEnv; mcpServers?: EngineHostOptions['mcpServers']; onSessionClosed?: EngineHostOptions['onSessionClosed'] } = {}): AcpEngines | undefined {
  const env = options.env ?? process.env
  if (!acpEnginesEnabled(env)) return undefined
  const disabled = new Set((env.LUMO_ACP_DISABLED_ENGINES ?? '').split(',').map(s => s.trim()).filter(Boolean))
  const max = Number(env.LUMO_ACP_MAX_SESSIONS ?? 8)
  const asks = new SessionAskBroker()
  const host = new EngineHost({ ...(options.recoveryIndexPath ? { recoveryIndexPath: options.recoveryIndexPath } : {}), registry: new EngineRegistry(BUILTIN_ENGINES, disabled), asks, ...(options.runTree ? { runTree: options.runTree } : {}), ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}), ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}), maxSessions: Number.isSafeInteger(max) && max > 0 ? max : 8 })
  const attachments = new AttachmentStore(options.recoveryIndexPath ? join(dirname(options.recoveryIndexPath), 'acp-attachments') : undefined)
  const rooms = new RoleRooms(host, new RoleRoomStore(options.recoveryIndexPath ? join(dirname(options.recoveryIndexPath), 'acp-role-rooms.json') : undefined), attachments, options.skills)
  return { host, asks, rooms, attachments, skills: options.skills }
}
