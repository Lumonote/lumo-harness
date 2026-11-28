import { openSurface } from './surface-navigation.ts'

export const AGENT_ROOM_EVENT = 'lumo:agent-room'
let pending: { roomId: string; identity: string } | undefined
export const openAgentRoom = (roomId: string, identity: string) => {
  pending = { roomId, identity }
  openSurface('agents')
  window.dispatchEvent(new Event(AGENT_ROOM_EVENT))
}
export const takeAgentRoom = (identity: string) => {
  const target = pending; pending = undefined
  return target?.identity === identity ? target.roomId : undefined
}
