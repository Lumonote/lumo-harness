import { openSurface } from './surface-navigation.ts'

export const AGENT_ROOM_EVENT = 'lumo:agent-room'
let pending: { roomId: string; identity: string } | undefined
export const openAgentRoom = (roomId: string, identity: string) => {
  pendingSession = undefined
  pending = { roomId, identity }
  openSurface('agents')
  window.dispatchEvent(new Event(AGENT_ROOM_EVENT))
}
export const takeAgentRoom = (identity: string) => {
  const target = pending; pending = undefined
  return target?.identity === identity ? target.roomId : undefined
}

export const AGENT_SESSION_EVENT = 'lumo:agent-session'
let pendingSession: { id: string; identity: string } | undefined
export function openAgentSession(id: string, identity: string) {
  pending = undefined
  pendingSession = { id, identity }
  openSurface('agents')
  window.dispatchEvent(new Event(AGENT_SESSION_EVENT))
}
export function takeAgentSession(identity: string) {
  const target = pendingSession; pendingSession = undefined
  return target?.identity === identity ? target.id : undefined
}
