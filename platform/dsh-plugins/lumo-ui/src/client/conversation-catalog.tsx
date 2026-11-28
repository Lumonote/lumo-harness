import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react'
import { AgentChatHistory, type HistoryEntry } from './agent-chat-history.tsx'
import { acpCall, scopeKey, type SessionIdentity, type SessionView } from './acp-session-state.ts'
import type { RoomSummary } from '../../../acp-engines/src/role-room-model.ts'
import { conversationHost, manageNativeConversation, useNativeHistory, type ConversationHost } from './conversation-host.ts'
import { openAgentRoom, openAgentSession } from './agent-navigation.ts'
import { useConversationSearch } from './use-conversation-search.ts'
import { ChatButton } from './chat-button.tsx'
import { FolderIcon, RefreshIcon } from './chat-icons.tsx'
import { openSurface, CLOSE_EVENT } from './surface-navigation.ts'
import './conversation-catalog.css'

import { CATALOG_CHANGED, refreshConversationCatalog, useCatalogSelection } from './conversation-events.ts'

export function ConversationCatalog({ wide, expandSidebar, useSectionScroller }: {
  wide: boolean; expandSidebar(): void; useSectionScroller?(): { bindScrollerRef: RefCallback<HTMLElement> }
}) {
  const scroller = useSectionScroller?.()
  const [query, setQuery] = useState(''), [error, setError] = useState('')
  const [snapshot, setExternal] = useState<{ source?: ConversationHost | undefined; available?: boolean; identity: string; sessions: SessionView[]; rooms: RoomSummary[] }>({ identity: '', sessions: [], rooms: [] })
  const generation = useRef(0), native = useNativeHistory(query), selection = useCatalogSelection()
  const source = native.host
  const external = snapshot.source === source ? snapshot : { identity: '', sessions: [], rooms: [], available: false }
  const search = useConversationSearch(query, external.identity)
  const refresh = useCallback(async () => {
    const at = ++generation.current
    try {
      const [sessions, rooms] = await Promise.all([
        acpCall<{ identity: SessionIdentity; sessions: SessionView[] }>('/lumo/api/acp/sessions'),
        acpCall<{ identity: SessionIdentity; rooms: RoomSummary[] }>('/lumo/api/acp/rooms?includeArchived=true'),
      ])
      if (at !== generation.current || source !== conversationHost()) return
      const identity = scopeKey(sessions.identity)
      if (identity !== scopeKey(rooms.identity)) throw new Error('身份已变化，请刷新对话记录')
      setExternal({ source, available: true, identity, sessions: sessions.sessions.filter(row => scopeKey(row) === identity), rooms: rooms.rooms }); setError('')
    } catch (reason) {
      if (at !== generation.current || source !== conversationHost()) return
      const status = (reason as { status?: number }).status
      if ([401, 403, 501].includes(status ?? 0)) setExternal({ source, available: false, identity: '', sessions: [], rooms: [] })
      setError(status === 501 ? '' : reason instanceof Error ? reason.message : String(reason))
    }
  }, [source])
  useEffect(() => {
    setExternal({ source, available: false, identity: '', sessions: [], rooms: [] }); setError('')
    void refresh()
    const onRefresh = () => { if (!document.hidden) void refresh() }, timer = setInterval(onRefresh, 15_000)
    window.addEventListener('focus', onRefresh); window.addEventListener(CATALOG_CHANGED, onRefresh)
    return () => { ++generation.current; clearInterval(timer); window.removeEventListener('focus', onRefresh); window.removeEventListener(CATALOG_CHANGED, onRefresh) }
  }, [refresh])
  const manage = async (entry: HistoryEntry, change: { title?: string; archived?: boolean; pinned?: boolean }) => {
    if (entry.kind === 'native') {
      if (!source) throw new Error('原生宿主尚未连接')
      await manageNativeConversation(source, entry.id, change)
    } else {
      if (source !== conversationHost() || !external.identity) throw new Error('连接已切换，请刷新对话记录')
      const { title, ...metadata } = change
      await acpCall(`/lumo/api/acp/${entry.kind === 'room' ? 'rooms' : 'sessions'}/${encodeURIComponent(entry.id)}/metadata`, { method: 'POST', body: JSON.stringify({ ...metadata, ...(title === undefined ? {} : { [entry.kind === 'room' ? 'name' : 'title']: title }) }) })
      refreshConversationCatalog(); await refresh()
    }
  }
  const openNative = (id: string) => { window.dispatchEvent(new Event(CLOSE_EVENT)); source?.uiWorkspace.openSession(id) }
  const addProject = async () => {
    if (!source) return
    try {
      const path = await source.uiWorkspace.pickDirectory()
      if (!path || source !== conversationHost()) return
      const workspace = await source.workspaces.create({ path })
      if (source === conversationHost()) source.uiWorkspace.startSession(workspace.workspaceId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  if (!wide) return <div className="lumo-catalog-rail"><ChatButton variant="ghost" type="button" aria-label="展开对话记录" title="对话记录" onClick={expandSidebar}><FolderIcon size={18} /></ChatButton></div>
  return <section className="lumo-conversation-catalog" aria-label="全部对话" ref={scroller?.bindScrollerRef}>
    <div className="lumo-catalog-controls"><input type="search" aria-label="搜索全部对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} />
      <ChatButton variant="ghost" type="button" className="lumo-chat-icon-button" aria-label="添加项目" title="添加项目" onClick={() => void addProject()}><FolderIcon size={16} /></ChatButton>
      <ChatButton variant="ghost" type="button" className="lumo-chat-icon-button" aria-label="刷新全部对话" title="刷新" onClick={() => { void refresh(); void source?.sessions.refresh().catch(reason => setError(String(reason))) }}><RefreshIcon size={16} /></ChatButton>
    </div>
    {external.available ? <div className="lumo-catalog-new"><ChatButton variant="ghost" type="button" onClick={() => openSurface('agents')}>多工具对话与群组</ChatButton></div> : null}
    {native.loading || search.loading ? <small role="status">正在搜索…</small> : null}
    {error || native.error || search.error ? <small role="alert">{error || native.error || search.error}</small> : null}
    {native.more ? <small role="status">搜索结果较多，请缩小关键词范围。</small> : null}
    <AgentChatHistory native={native.entries} rooms={search.result?.rooms ?? external.rooms} sessions={search.result?.sessions ?? external.sessions} query={query} searched={!!search.result}
      projects={native.projects} openProject={id => source?.uiWorkspace.startSession(id)}
      selected={native.activePanel === 'lumo-agents' ? selection.identity === external.identity ? selection.key : '' : native.activePanel === null ? `native:${native.entries.find(entry => entry.retainedBy?.mainView)?.id ?? ''}` : ''} disabled={false} openNative={openNative} openRoom={id => openAgentRoom(id, external.identity)} openSession={id => openAgentSession(id, external.identity)} manage={manage} />
  </section>
}
