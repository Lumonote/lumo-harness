import { refreshConversationCatalog } from './conversation-events.ts'
import { readDraft, writeDraft } from './conversation-drafts.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { acpCall, scopeKey, type AskView, type SessionIdentity } from './acp-session-state.ts'
import type { RoomView, RoomSummary } from '../../../acp-engines/src/role-room-model.ts'
import type { RoomChange } from '../../../acp-engines/src/role-room-events.ts'
import type { EngineProbeView } from './acp-session-panel.tsx'
import { workflowSessions } from '../../../acp-engines/src/project-workflow-model.ts'

const ROOT = '/lumo/api/acp'
type Snapshot = { identity: SessionIdentity; room: RoomView }
export const useRoleRooms = () => {
  const [rooms, setRooms] = useState<RoomSummary[]>([]), [room, setRoom] = useState<RoomView>()
  const [approvalError, setApprovalError] = useState('')
  const [engines, setEngines] = useState<EngineProbeView[]>([]), [asks, setAsks] = useState<AskView[]>([])
  const [identity, setIdentity] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false)
  const selected = useRef(''), scope = useRef(''), alive = useRef(false), epoch = useRef(0), writing = useRef(false), reading = useRef(false)
  const streamConnected = useRef(false), roomRef = useRef<RoomView>()
  roomRef.current = room
  const queuedRead = useRef(false)
  const live = useRef(false), lastRead = useRef(0)
  const clearIdentity = () => { ++epoch.current; scope.current = ''; selected.current = ''; setIdentity(''); setRoom(undefined); setRooms([]); setAsks([]); setApprovalError(''); setReady(false) }
  const applyScope = (value: SessionIdentity): boolean => {
    if (!value?.realm || !value.userId) throw new Error('角色协作身份无效')
    const key = scopeKey(value)
    if (scope.current === key) return true
    ++epoch.current; scope.current = key; selected.current = readDraft(key, 'selectedRoom', ''); setIdentity(key); setRoom(undefined); setRooms([]); setAsks([]); setApprovalError('')
    return false
  }
  const refresh = useCallback(async () => {
    if (reading.current) { queuedRead.current = true; return }
    reading.current = true
    let generation = epoch.current
    try {
      const list = await acpCall<{ rooms: RoomSummary[]; identity: SessionIdentity }>(`${ROOT}/rooms?includeArchived=true`)
      if (!alive.current || epoch.current !== generation) return
      if (!Array.isArray(list.rooms)) throw new Error('角色协作列表无效')
      applyScope(list.identity); generation = epoch.current; setRooms(list.rooms); setReady(true)
      if (!list.rooms.some(r => r.id === selected.current)) { selected.current = list.rooms.find(room => !room.archived)?.id ?? list.rooms[0]?.id ?? ''; setRoom(undefined); setAsks([]) }
      const id = selected.current, current = epoch.current
      if (!id) { setRoom(undefined); setAsks([]); return }
      const result = await acpCall<Snapshot>(`${ROOT}/rooms/${encodeURIComponent(id)}`)
      if (!alive.current || epoch.current !== current || selected.current !== id || !applyScope(result.identity)) return
      if (roomRef.current?.id === id && (roomRef.current.revision ?? 0) > (result.room.revision ?? 0)) return
      setRoom(previous => previous?.revision !== undefined && previous.id === result.room.id && previous.revision > (result.room.revision ?? 0) ? previous : result.room); live.current = result.room.busy
      const pending = await acpCall<{ asks: AskView[]; warnings?: string[] }>(`${ROOT}/asks?status=pending`)
      if (!alive.current || epoch.current !== current || selected.current !== id) return
      const sessions = new Set([...result.room.roles.map(r => r.sessionId).filter(Boolean), ...(result.room.workflows ?? []).flatMap(workflowSessions)])
      setAsks(pending.asks.filter(a => sessions.has(a.source.session_ref))); setApprovalError(pending.warnings?.join('；') ?? '')
    } catch (e) {
      if (alive.current && epoch.current === generation) {
        if ([401, 403].includes((e as { status?: number }).status ?? 0)) clearIdentity()
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally { reading.current = false; lastRead.current = Date.now(); if (queuedRead.current && alive.current) { queuedRead.current = false; void refresh() } }
  }, [])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    void acpCall<{ engines: EngineProbeView[] }>(`${ROOT}/engines`, { signal: controller.signal }).then(r => { if (alive.current && Array.isArray(r.engines)) setEngines(r.engines) }).catch(e => { if (!controller.signal.aborted) setError(String(e)) })
    void refresh()
    const timer = setInterval(() => { if (!document.hidden && Date.now() - lastRead.current >= (streamConnected.current ? 30_000 : live.current ? 3000 : 30_000)) void refresh() }, 1500)
    const focus = () => void refresh(); window.addEventListener('focus', focus)
    return () => { alive.current = false; ++epoch.current; controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [refresh])
  useEffect(() => {
    const id = room?.id
    if (!id || typeof EventSource === 'undefined') return
    const events = new EventSource(`${ROOT}/rooms/${encodeURIComponent(id)}/events?after=${room?.revision ?? 0}`)
    events.onopen = () => { streamConnected.current = true }
    events.onerror = () => { streamConnected.current = false }
    events.addEventListener('room.snapshot', (raw: MessageEvent) => {
      try { const result = JSON.parse(raw.data) as Snapshot; if (selected.current === id && scopeKey(result.identity) === scope.current && result.room.id === id) { setRoom(previous => previous?.id === id && (previous.revision ?? 0) > (result.room.revision ?? 0) ? previous : result.room); live.current = result.room.busy } } catch { void refresh() }
    })
    events.addEventListener('room.changed', (raw: MessageEvent) => {
      try {
        const payload = JSON.parse(raw.data)
        const change = (payload.change ?? payload) as RoomChange & { revision: number }
        if (payload.identity && scopeKey(payload.identity) !== scope.current) return
        if (change.id !== id || selected.current !== id || (roomRef.current?.revision ?? -1) >= change.revision) return
        setRoom(previous => previous?.id !== id || (previous.revision ?? -1) >= change.revision ? previous : { ...previous, revision: change.revision, busy: change.busy, ...(change.archived !== undefined ? {archived: change.archived} : {}), ...(change.pinned !== undefined ? {pinned: change.pinned} : {}), ...(change.name ? {name: change.name} : {}), ...(change.updatedAt ? {updatedAt: change.updatedAt} : {}), ...(change.error ? {error: change.error} : {}), ...(change.sessionStates ? {sessionStates: change.sessionStates} : {}), ...(change.sessionModels ? {sessionModels: change.sessionModels} : {}),
          ...(change.workflows ? { workflows: change.workflows } : {}),
          roles: change.roleSessions ? previous.roles.map(role => {
            const sessionId = change.roleSessions[role.id]
            if (sessionId === undefined) return role
            const { sessionId: _previous, ...profile } = role
            return sessionId === null ? profile : { ...profile, sessionId }
          }) : previous.roles,
          turns: change.turn ? previous.turns.some(turn => turn.id === change.turn!.id) ? previous.turns.map(turn => turn.id === change.turn!.id ? change.turn! : turn) : [...previous.turns, change.turn] : previous.turns })
        live.current = change.busy
        if (change.refresh || !change.busy) void refresh()
      } catch { void refresh() }
    })
    return () => { streamConnected.current = false; events.close() }
  }, [room?.id, identity, refresh])
  useEffect(() => {
    if (!room?.id || !room.busy) return
    const id = room.id, current = epoch.current
    const timer = setInterval(() => {
      if (document.hidden) return
      void acpCall<{asks: AskView[]; warnings?: string[]}>(`${ROOT}/asks?status=pending`).then(result => {
        if (selected.current !== id || !alive.current || epoch.current !== current) return
        const sessions = new Set([...(roomRef.current?.roles.map(role => role.sessionId) ?? []), ...(roomRef.current?.workflows ?? []).flatMap(workflowSessions)])
        setAsks(result.asks.filter(ask => sessions.has(ask.source.session_ref))); setApprovalError(result.warnings?.join('；') ?? '')
      }).catch(() => undefined)
    }, 5000)
    return () => clearInterval(timer)
  }, [room?.id, room?.busy])
  const refreshEngines = async () => {
    try { const result = await acpCall<{ engines: EngineProbeView[] }>(`${ROOT}/engines`); if (alive.current && Array.isArray(result.engines)) setEngines(result.engines) }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
  }
  const select = useCallback((id: string) => { if (selected.current === id) return; ++epoch.current; selected.current = id; writeDraft(scope.current, 'selectedRoom', id); live.current = true; setRoom(undefined); setAsks([]); setApprovalError(''); setError(''); void refresh() }, [refresh])
  const mutate = async (path: string, body: unknown = {}): Promise<boolean> => {
    if (writing.current || !ready) return false
    writing.current = true; setBusy(true); setError(''); const current = epoch.current
    try {
      const result = await acpCall<Partial<Snapshot>>(`${ROOT}${path}`, { method: 'POST', body: JSON.stringify(body) })
      if (!alive.current || epoch.current !== current) return false
      if (result.identity && !applyScope(result.identity)) return false
      ++epoch.current
      if (result.room?.id) {
        const next = result.room; selected.current = next.id; writeDraft(scope.current, 'selectedRoom', next.id); setRoom(next); live.current = next.busy
        setRooms(previous => [...previous.filter(r => r.id !== next.id), { id: next.id, name: next.name, cwd: next.cwd, busy: next.busy, ...(next.appearance ? { appearance: next.appearance } : {}), engineIds: next.roles.map(role => role.engineId), preview: next.turns.at(-1)?.text.slice(0, 120) ?? '', updatedAt: next.updatedAt ?? next.turns.at(-1)?.createdAt ?? next.createdAt, ...(next.archived !== undefined ? {archived: next.archived} : {}), ...(next.pinned !== undefined ? {pinned: next.pinned} : {}), ...(next.revision !== undefined ? {revision: next.revision} : {}) }])
      } else if (path.endsWith('/delete')) { const id = selected.current; selected.current = ''; setRoom(undefined); setRooms(previous => previous.filter(r => r.id !== id)) }
      setAsks([]); refreshConversationCatalog(); void refresh(); return true
    } catch (e) { if (alive.current && epoch.current === current) {
      if ([401, 403].includes((e as { status?: number }).status ?? 0)) clearIdentity()
      setError(`${e instanceof Error ? e.message : String(e)}。可刷新核对状态；重试同一消息会复用原请求。`)
    } return false }
    finally { writing.current = false; if (alive.current) setBusy(false) }
  }
  return { rooms, room, engines, asks, identity, error: error || approvalError, busy, ready, refresh, refreshEngines, select, mutate }
}
