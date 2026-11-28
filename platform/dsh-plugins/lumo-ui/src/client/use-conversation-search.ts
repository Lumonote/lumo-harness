import { useEffect, useState } from 'react'
import { acpCall, scopeKey, type SessionIdentity, type SessionView } from './acp-session-state.ts'
import type { RoomSummary } from '../../../acp-engines/src/role-room-model.ts'
/** Server searches persisted message bodies; local list matching remains immediate while typing. */
export function useConversationSearch(query: string, identity: string) {
  const [result, setResult] = useState<{identity: string; query: string; rooms: RoomSummary[]; sessions: SessionView[]}>(), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  useEffect(() => {
    const controller = new AbortController(); setError('')
    if (!query.trim() || !identity) { setResult(undefined); setLoading(false); return }
    setLoading(true)
    const timer = setTimeout(() => {
      const q = encodeURIComponent(query.trim())
      void Promise.all([
        acpCall<{rooms: RoomSummary[]; identity: SessionIdentity}>(`/lumo/api/acp/rooms?includeArchived=true&q=${q}`, {signal: controller.signal}),
        acpCall<{sessions: SessionView[]; identity: SessionIdentity}>(`/lumo/api/acp/sessions?q=${q}`, {signal: controller.signal}),
      ]).then(([rooms, sessions]) => {
        if (!controller.signal.aborted && scopeKey(rooms.identity) === identity && scopeKey(sessions.identity) === identity) setResult({identity, query, rooms: rooms.rooms, sessions: sessions.sessions.filter(session => scopeKey(session) === identity)})
      }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, identity])
  return {result: result?.identity === identity && result.query === query ? result : undefined, error, loading}
}
