import type { RoomTurn, RoomView } from './role-room-model.ts'

export type RoomChange = Pick<RoomView, 'id' | 'revision' | 'busy' | 'name' | 'archived' | 'pinned' | 'updatedAt' | 'sessionStates' | 'sessionModels' | 'error'> & { roleSessions: Record<string, string | null>; turn?: RoomTurn; refresh?: boolean }
export type RoomEvent = { type: 'room.snapshot'; revision: number; room: RoomView } | { type: 'room.changed'; revision: number; change: RoomChange }

/** Small replay window for transport interruptions; older cursors receive an authoritative snapshot. */
export class RoomEvents {
  private listeners = new Map<string, Set<(event: RoomEvent) => void>>()
  private replay = new Map<string, RoomEvent[]>()
  publish(room: RoomView, refresh = false): void {
    const event: RoomEvent = { type: 'room.changed', revision: room.revision ?? 0, change: {
      id: room.id, revision: room.revision ?? 0, busy: room.busy, name: room.name, archived: room.archived ?? false,
      roleSessions: Object.fromEntries(room.roles.map(role => [role.id, role.sessionId ?? null])),
      pinned: room.pinned ?? false, ...(room.updatedAt ? { updatedAt: room.updatedAt } : {}), sessionStates: room.sessionStates, ...(room.sessionModels ? { sessionModels: room.sessionModels } : {}),
      ...(room.error ? { error: room.error } : {}), ...(room.turns.at(-1) ? { turn: room.turns.at(-1)! } : {}), ...(refresh ? { refresh: true } : {}),
    } }
    const recent = [...(this.replay.get(room.id) ?? []), event].slice(-16); this.replay.set(room.id, recent)
    for (const listener of this.listeners.get(room.id) ?? []) { try { listener(event) } catch { /* A disconnected observer cannot interrupt execution. */ } }
  }
  subscribe(room: RoomView, after: number | undefined, listener: (event: RoomEvent) => void): () => void {
    const recent = this.replay.get(room.id) ?? [], revision = room.revision ?? 0
    if (after === undefined || after > revision || (!recent.length && after < revision) || after < (recent[0]?.revision ?? revision) - 1) listener({ type: 'room.snapshot', revision, room })
    else for (const event of recent) if (event.revision > after) listener(event)
    const set = this.listeners.get(room.id) ?? new Set(); set.add(listener); this.listeners.set(room.id, set)
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(room.id) }
  }
  remove(id: string): void { this.replay.delete(id); this.listeners.delete(id) }
}
