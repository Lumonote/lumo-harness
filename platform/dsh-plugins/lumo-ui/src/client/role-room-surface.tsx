import { selectCatalogConversation } from './conversation-events.ts'
import { ChatButton } from './chat-button.tsx'
import { useConversationSearch } from './use-conversation-search.ts'
import { useConversationDraft } from './conversation-drafts.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Notice } from './surface-shell.tsx'
import { useRoleRooms } from './use-role-rooms.ts'
import { RoleRoomCreate } from './role-room-create.tsx'
import { RoleRoomConversation } from './role-room-conversation.tsx'
import { AgentDirectory } from './agent-directory.tsx'
import { DevelopmentTools, type AgentSeed } from './development-tools.tsx'
import { AcpSessionPanel } from './acp-session-panel.tsx'
import { RoomLogo } from './room-appearance.tsx'
import type { AgentProfile } from '../../../acp-engines/src/agent-directory.ts'
import { AGENT_ROOM_EVENT, takeAgentRoom, AGENT_SESSION_EVENT, takeAgentSession } from './agent-navigation.ts'
import { AgentChatHistory, useAgentSessionHistory } from './agent-chat-history.tsx'
import { RefreshIcon } from './chat-icons.tsx'
import { EnvironmentEntry } from './environment-panel.tsx'
import './role-room.css'
import './agent-workbench.css'
import './agent-chat.css'

type Area = 'groups' | 'contacts' | 'tools' | 'sessions'
export const RoleRoomSurface = ({ onClose, initialArea = 'groups', embedded = false }: { onClose(): void; initialArea?: Area; embedded?: boolean }) => {
  const state = useRoleRooms()
  return <AgentWorkbench key={state.identity} state={state} onClose={onClose} initialArea={initialArea} embedded={embedded} />
}
const AgentWorkbench = ({ state, onClose, initialArea, embedded }: { embedded: boolean; state: ReturnType<typeof useRoleRooms>; onClose(): void; initialArea: Area }) => {
  const projectRequest = useRef<{ signature: string; id: string }>()
  const [creating, setCreating] = useState(false), [area, setArea] = useConversationDraft<Area>(`${state.identity}:workspace`, 'area', initialArea)
  const [seed, setSeed] = useState<AgentSeed>(), [members, setMembers] = useState<AgentProfile[]>()
  const [newOpen, setNewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false), [query, setQuery] = useState('')
  const history = useAgentSessionHistory(state.identity, area !== 'sessions')
  const search = useConversationSearch(query, state.identity)
  const [requestedSession, setRequestedSession] = useConversationDraft<string | undefined>(`${state.identity}:workspace`, 'session', undefined), [selectedSession, setSelectedSession] = useState('')
  const selectSession = useCallback((id: string) => { setSelectedSession(id); if (id && id !== requestedSession) setRequestedSession(id) }, [requestedSession, setRequestedSession])
  const [sessionOpenVersion, setSessionOpenVersion] = useState(0)
  const [sessionSeed, setSessionSeed] = useState<{ engineId: string; cwd: string; modelId?: string | undefined }>()
  useEffect(() => {
    if (!state.ready) return
    const navigate = () => { const id = takeAgentRoom(state.identity); if (id) { setArea('groups'); setCreating(false); setHistoryOpen(false); state.select(id) } }
    navigate(); window.addEventListener(AGENT_ROOM_EVENT, navigate)
    return () => window.removeEventListener(AGENT_ROOM_EVENT, navigate)
  }, [state.ready, state.identity, state.select])
  const switchProject = async (cwd: string) => {
    if (!state.room) return false
    const signature = JSON.stringify([state.identity, state.room.id, cwd])
    if (projectRequest.current?.signature !== signature) projectRequest.current = { signature, id: crypto.randomUUID() }
    const ok = await state.mutate('/rooms', { ...state.room, id: projectRequest.current.id, cwd, roles: state.room.roles.map(({ sessionId: _session, ...role }) => role) })
    if (ok) projectRequest.current = undefined
    return ok
  }
  useEffect(() => {
    if (!state.ready) return
    const navigate = () => { const id = takeAgentSession(state.identity); if (id !== undefined) { setSessionOpenVersion(n => n + 1); setRequestedSession(id || undefined); setSelectedSession(id); setArea('sessions') } }
    navigate(); window.addEventListener(AGENT_SESSION_EVENT, navigate)
    return () => window.removeEventListener(AGENT_SESSION_EVENT, navigate)
  }, [state.ready, state.identity])
  useEffect(() => { if (embedded) selectCatalogConversation(state.identity, area === 'groups' && !creating && state.room ? `room:${state.room.id}` : area === 'sessions' ? `session:${selectedSession}` : '') }, [embedded, state.identity, state.room?.id, area, creating, selectedSession])
  const base = state.room ? `/rooms/${encodeURIComponent(state.room.id)}` : ''
  const go = (id: Area) => { setArea(id); setSeed(undefined); setHistoryOpen(false) }
  const newGroup = () => { setMembers(undefined); setCreating(true); go('groups') }
  const openRoom = (id: string) => { go('groups'); setCreating(false); state.select(id) }
  const openSession = (id: string) => { if (area === 'sessions' && selectedSession === id) return; setSessionOpenVersion(n => n + 1); setRequestedSession(id); setSelectedSession(id); go('sessions') }
  return <div className="lumo-role-page lumo-chat-workspace" data-history-open={historyOpen}>
    {embedded ? <div className="lumo-native-agent-toolbar">
      <ChatButton type="button" variant="ghost" onClick={() => { setRequestedSession(undefined); setSessionSeed(undefined); setSelectedSession(''); setSessionOpenVersion(n => n + 1); go('sessions') }}>新建对话</ChatButton>
      <ChatButton type="button" variant="ghost" onClick={newGroup}>新建群组</ChatButton>
      <ChatButton type="button" variant="ghost" onClick={() => go('contacts')}>Agent 通讯录</ChatButton>
      <ChatButton type="button" variant="ghost" onClick={() => go('tools')}>工具与模型</ChatButton>
    </div> : null}
    <div className="lumo-chat-mobile-bar"><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? '收起记录' : '会话记录'}</button><span>Agent 对话</span><button type="button" onClick={onClose}>返回</button></div>
    <aside className="lumo-chat-sidebar" aria-label="会话导航">
      <div className="lumo-chat-sidebar-heading"><strong>Agent 对话</strong><button type="button" onClick={onClose} aria-label="返回主界面">←</button></div>
      <button className="lumo-chat-new" type="button" disabled={!state.ready || state.busy} aria-expanded={newOpen} onClick={() => setNewOpen(!newOpen)}>新建对话</button>{newOpen ? <div className="lumo-chat-nav" role="group" aria-label="新建对话类型"><button type="button" onClick={() => { setNewOpen(false); setRequestedSession(undefined); setSessionSeed(undefined); setSelectedSession(''); setSessionOpenVersion(n => n + 1); go('sessions') }}>独立会话</button><button type="button" onClick={() => { setNewOpen(false); newGroup() }}>Bot / Agent 协作群组</button></div> : null}
      <nav className="lumo-chat-nav" aria-label="Agent 工作台">{([['groups', '会话与群组'], ['sessions', '独立会话'], ['contacts', 'Agent 通讯录'], ['tools', '开发工具与模型']] as const).map(([id, label]) => <button key={id} type="button" aria-current={area === id ? 'page' : undefined} onClick={() => go(id)}>{label}</button>)}</nav>
      <div className="lumo-chat-history-search"><input type="search" aria-label="搜索会话记录" placeholder="搜索项目或对话" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" className="lumo-chat-icon-button" aria-label="刷新协作状态" title="刷新对话记录" onClick={() => { void state.refresh(); void history.refresh() }}><RefreshIcon size={15} /></button></div>
      <AgentChatHistory rooms={search.result?.rooms ?? state.rooms} sessions={search.result?.sessions ?? history.sessions} query={query} searched={!!search.result} selected={area === 'groups' && !creating && state.room ? `room:${state.room.id}` : area === 'sessions' ? `session:${selectedSession}` : ''} disabled={state.busy} openRoom={openRoom} openSession={openSession} />
      {search.loading ? <small role="status">正在搜索聊天内容…</small> : null}
      {search.error ? <small role="status">{search.error}</small> : null}
      {history.error ? <small role="status">{history.error}</small> : null}
      <div className="lumo-chat-sidebar-bottom"><EnvironmentEntry /></div>
    </aside>
    <main className={`lumo-chat-main ${area === 'groups' && !creating && state.room || area === 'sessions' ? 'is-chat' : 'is-settings'}`}>
      {state.error && (area !== 'sessions' || !state.ready) ? <Notice error>{state.error}</Notice> : null}
      {area === 'tools' && state.ready ? <DevelopmentTools key={state.identity} identity={state.identity} engines={state.engines} refresh={() => void state.refreshEngines()} createAgent={value => { setSeed(value); setArea('contacts') }} openSession={(engineId, cwd, modelId) => { setRequestedSession(undefined); setSessionSeed({ engineId, cwd, modelId }); go('sessions') }} /> : null}
      {area === 'contacts' && state.ready ? <AgentDirectory key={`${state.identity}:${seed?.engineId ?? ''}:${seed?.modelId ?? ''}`} identity={state.identity} engines={state.engines} seed={seed} tools={() => go('tools')} group={agents => { setMembers(agents); setCreating(true); go('groups') }} /> : null}
      {area === 'sessions' && state.ready ? <AcpSessionPanel key={`${state.identity}:${sessionOpenVersion}:${sessionSeed?.engineId ?? ''}:${sessionSeed?.cwd ?? ''}:${sessionSeed?.modelId ?? ''}`} hideHistory onSessions={history.update} onSelection={selectSession} initialSessionId={requestedSession} identityKey={state.identity} initialEngineId={sessionSeed?.engineId} initialModelId={sessionSeed?.modelId} defaultCwd={sessionSeed?.cwd ?? ''} /> : null}
      {area === 'groups' ? creating && state.ready ? <><button type="button" onClick={() => setCreating(false)}>返回对话</button><RoleRoomCreate key={`${state.identity}:${members?.map(a => a.id).join(',') ?? 'new'}`} initialAgents={members} refreshEngines={() => void state.refreshEngines()} manageTools={() => go('tools')} recentProjects={state.rooms.map(r => r.cwd)} engines={state.engines} busy={state.busy} create={async config => { const ok = await state.mutate('/rooms', config); if (ok) { setCreating(false); setMembers(undefined) } return ok }} /></>
        : state.room ? <RoleRoomConversation key={`${state.identity}:${state.room.id}`} room={state.room} recentProjects={state.rooms.map(r => r.cwd)} switchProject={switchProject} asks={state.asks} busy={state.busy}
          metadata={value => state.mutate(`${base}/metadata`, value)} continueTopic={value => state.mutate(`${base}/continue`, value)}
          workflowAction={value => state.mutate(`${base}/workflow`, value)}
          send={input => state.mutate(`${base}/turns`, input)} action={name => state.mutate(`${base}/${name}`)} connectRole={roleId => state.mutate(`${base}/connect`, { roleId })} setModel={(roleId, modelId) => state.mutate(`${base}/model`, { roleId, modelId })} setAppearance={value => state.mutate(`${base}/appearance`, value)} answer={(id, value) => state.mutate(`/asks/${encodeURIComponent(id)}/answer`, { value })} />
        : state.ready && !state.rooms.length ? <div className="lumo-chat-empty"><RoomLogo /><h2>你的 Agent 对话空间</h2><p>让不同角色、不同 AI 工具在同一条记录里协作。</p><button type="button" onClick={newGroup}>创建第一个群组</button><button type="button" onClick={() => go('sessions')}>开始独立对话</button></div>
        : <p role="status">{state.error ? '连接恢复后可刷新重试。' : '正在读取协作房间…'}</p> : null}
    </main>
  </div>
}
