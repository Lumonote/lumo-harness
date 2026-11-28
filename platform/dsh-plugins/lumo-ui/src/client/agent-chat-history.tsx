import type { NativeHistoryEntry } from './conversation-host.ts'
import { ConversationHistoryMenu } from './conversation-history-menu.tsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { acpCall, scopeKey, type SessionIdentity, type SessionView } from './acp-session-state.ts'
import { ArchiveIcon, FolderIcon } from './chat-icons.tsx'
import { ChatButton } from './chat-button.tsx'
import './agent-chat-history.css'
import { EngineLogo } from './engine-logo.tsx'
import { RoomLogo } from './room-appearance.tsx'
import type { RoomSummary } from '../../../acp-engines/src/role-room-model.ts'

export function useAgentSessionHistory(identity: string, active = true) {
  const [sessions, setSessions] = useState<SessionView[]>([]), [error, setError] = useState('')
  const version = useRef(0)
  const update = useCallback((entries: SessionView[]) => {
    ++version.current; setSessions(entries.filter(s => scopeKey(s) === identity)); setError('')
  }, [identity])
  const refresh = useCallback(async () => {
    if (!identity) return
    const current = ++version.current
    try {
      const result = await acpCall<{ sessions: SessionView[]; identity: SessionIdentity }>('/lumo/api/acp/sessions')
      if (current !== version.current) return
      if (!Array.isArray(result.sessions) || !result.identity) throw new Error('会话记录暂时不可用')
      if (scopeKey(result.identity) !== identity) { setSessions([]); return }
      setSessions(result.sessions.filter(s => scopeKey(s) === identity)); setError('')
    } catch (e) { if (current === version.current) {
      if ([401, 403].includes((e as { status?: number }).status ?? 0)) setSessions([])
      setError(e instanceof Error ? e.message : '会话记录暂时不可用')
    } }
  }, [identity])
  useEffect(() => { setSessions([]); setError('') }, [identity])
  useEffect(() => {
    if (!active) return
    void refresh()
    const focus = () => void refresh(), timer = setInterval(() => { if (!document.hidden) void refresh() }, 15_000)
    window.addEventListener('focus', focus)
    return () => { ++version.current; clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [refresh, active])
  return { sessions, update, refresh, error }
}

export type HistoryEntry = { id: string; kind: 'room' | 'session' | 'native'; name: string; cwd: string; updatedAt: string; detail: string; room?: RoomSummary; session?: SessionView; native?: NativeHistoryEntry }
const projectName = (cwd: string) => cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd
const directoryKey = (cwd: string) => cwd.replace(/[\\/]+$/u, '') || (cwd ? '/' : '')
const timestamp = (value: number) => Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : ''
const timeUnits = { minutes: '分钟', hours: '小时', days: '天', months: '个月', years: '年' }
function RecentTime({ at, now }: { at: string; now: number }) {
  const epoch = Date.parse(at)
  if (!Number.isFinite(epoch)) return <small>时间未知</small>
  const time = relativeTime(epoch, now)
  return <small><time dateTime={at} title={new Date(epoch).toLocaleString('zh-CN', { hour12: false })}>{time.unit === 'now' ? '刚刚' : `${time.n} ${timeUnits[time.unit]}前`}</time></small>
}

export function AgentChatHistory({ rooms, sessions, query, selected, disabled, searched = false, openRoom, openSession, native = [], openNative, manage, projects: knownProjects = [], openProject }: {
  rooms: RoomSummary[]; sessions: SessionView[]; query: string; selected: string; disabled: boolean; searched?: boolean
  openRoom(id: string): void; openSession(id: string): void; native?: NativeHistoryEntry[]; openNative?(id: string): void
  manage?(entry: HistoryEntry, change: {title?: string; archived?: boolean; pinned?: boolean}): Promise<void>
  projects?: readonly { workspaceId: string; path: string; title?: string }[]; openProject?(workspaceId: string): void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [archived, showArchived] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const tick = () => { if (!document.hidden) setNow(Date.now()) }, timer = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [])
  const entries: HistoryEntry[] = [
    ...native.map(entry => ({ id: entry.id, kind: 'native' as const, name: entry.title || entry.displayTitle, cwd: entry.cwd ?? '', updatedAt: timestamp(entry.updatedAt), detail: entry.running ? '正在回复…' : 'DeepSeek Harness', native: entry })),
    ...rooms.map(room => ({ id: room.id, kind: 'room' as const, name: room.name, cwd: room.cwd, updatedAt: room.updatedAt ?? '', detail: room.busy ? '正在回复…' : room.preview || '群组对话', room })),
    // A new group member receives its room binding after engine initialization.
    // Keep provisional sessions out of the directory until that binding is known.
    ...sessions.filter(session => !session.room && session.state !== 'starting').map(session => ({ id: session.id, kind: 'session' as const, name: session.title || session.engineId, cwd: session.cwd, updatedAt: session.updatedAt ?? session.createdAt ?? '', detail: session.state === 'running' ? '正在回复…' : session.state === 'detached' ? '可恢复' : session.engineId, session })),
  ].sort((a: HistoryEntry, b: HistoryEntry) => Number(!!(b.room?.pinned ?? b.session?.pinned ?? b.native?.pinned)) - Number(!!(a.room?.pinned ?? a.session?.pinned ?? a.native?.pinned)) || b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
  const needle = query.trim().toLowerCase()
  const visible = entries.filter(entry => !!(entry.room?.archived ?? entry.session?.archived ?? entry.native?.archived) === archived && (entry.kind === 'native' || searched || `${entry.name} ${entry.cwd} ${entry.detail}`.toLowerCase().includes(needle)))
  const projects = new Map<string, HistoryEntry[]>()
  if (!archived) for (const project of knownProjects) if (!needle || `${project.path} ${project.title ?? ''}`.toLowerCase().includes(needle)) projects.set(directoryKey(project.path), [])
  for (const entry of visible) {
    const key = directoryKey(entry.cwd), list = projects.get(key) ?? []
    list.push(entry); projects.set(key, list)
  }
  const row = (entry: HistoryEntry, recent: boolean) => <div className="lumo-history-row" key={`${entry.kind}:${entry.id}`}><button type="button" key={`${entry.kind}:${entry.id}`} className="lumo-chat-history-entry"
    aria-label={`打开${entry.kind === 'room' ? '群组' : '对话'} ${entry.name}`} aria-current={selected === `${entry.kind}:${entry.id}` ? 'page' : undefined}
    disabled={disabled || entry.session?.state === 'starting'} title={recent ? entry.name : `${entry.name}\n${entry.cwd}\n${entry.detail}`}
    onClick={() => entry.kind === 'room' ? openRoom(entry.id) : entry.kind === 'native' ? openNative?.(entry.id) : openSession(entry.id)}>
    {entry.room ? <RoomLogo appearance={entry.room.appearance} engines={entry.room.engineIds ?? []} /> : <EngineLogo engineId={entry.session?.engineId ?? 'deepseek'} small />}
    <span className="lumo-history-copy"><b>{entry.name}</b>{recent ? <RecentTime at={entry.updatedAt} now={now} /> : <small>{entry.detail}</small>}</span>
  </button>{manage ? <ConversationHistoryMenu entry={entry} disabled={disabled || !!entry.native?.running || entry.session?.state === 'running' || !!entry.room?.busy} manage={manage} /> : null}</div>
  return <div className="lumo-chat-history-sections"><ChatButton className="lumo-history-archive" variant="ghost" type="button" aria-pressed={archived} onClick={() => showArchived(!archived)}><ArchiveIcon size={13} />{archived ? '返回活跃对话' : '已归档对话'}</ChatButton>
    <section aria-label="项目"><div className="lumo-chat-history-heading"><small>项目</small></div>
      {[...projects].map(([cwd, project]) => <div className="lumo-chat-project-group" key={cwd}>
        <button type="button" className="lumo-chat-project-heading" aria-label={`项目 ${cwd}`} title={cwd} aria-expanded={!!needle || !collapsed.has(cwd)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(cwd)) next.delete(cwd); else next.add(cwd); return next })}>
          <FolderIcon size={15} /><span>{knownProjects.find(item => directoryKey(item.path) === cwd)?.title || projectName(cwd) || '未分配项目'}</span><small>{project.length}</small><span aria-hidden="true">{collapsed.has(cwd) && !needle ? '›' : '⌄'}</span>
        </button>
        {needle || !collapsed.has(cwd) ? <nav className="lumo-chat-history" aria-label={`${cwd} 的对话`}>{project.map(entry => row(entry, false))}{!project.length && openProject ? <ChatButton type="button" variant="ghost" onClick={() => { const item = knownProjects.find(item => directoryKey(item.path) === cwd); if (item) openProject(item.workspaceId) }}>开始对话</ChatButton> : null}</nav> : null}
      </div>)}
      {!projects.size ? <p className="lumo-muted">{needle ? '没有匹配的项目' : '开始对话后，项目会显示在这里'}</p> : null}
    </section>
    <section aria-label="最近对话"><div className="lumo-chat-history-heading"><small>最近对话</small></div>
      <nav className="lumo-chat-history" aria-label="最近对话记录">{visible.slice(0, 20).map(entry => row(entry, true))}</nav>
      {!visible.length ? <p className="lumo-muted">{needle ? '没有匹配的对话' : '暂无对话'}</p> : null}
    </section>
  </div>
}
