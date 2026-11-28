import { useCallback, useEffect, useRef, useState } from 'react'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { acpCall, scopeKey, type SessionIdentity, type SessionView } from './acp-session-state.ts'
import { FolderIcon } from './chat-icons.tsx'
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

type Entry = { id: string; kind: 'room' | 'session'; name: string; cwd: string; updatedAt: string; detail: string; room?: RoomSummary; session?: SessionView }
const projectName = (cwd: string) => cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd
const directoryKey = (cwd: string) => cwd.replace(/[\\/]+$/u, '') || '/'
const timeUnits = { minutes: '分钟', hours: '小时', days: '天', months: '个月', years: '年' }
function RecentTime({ at, now }: { at: string; now: number }) {
  const epoch = Date.parse(at)
  if (!Number.isFinite(epoch)) return <small>时间未知</small>
  const time = relativeTime(epoch, now)
  return <small><time dateTime={at} title={new Date(epoch).toLocaleString('zh-CN', { hour12: false })}>{time.unit === 'now' ? '刚刚' : `${time.n} ${timeUnits[time.unit]}前`}</time></small>
}

export function AgentChatHistory({ rooms, sessions, query, selected, disabled, searched = false, openRoom, openSession }: {
  rooms: RoomSummary[]; sessions: SessionView[]; query: string; selected: string; disabled: boolean; searched?: boolean
  openRoom(id: string): void; openSession(id: string): void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [archived, showArchived] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const tick = () => { if (!document.hidden) setNow(Date.now()) }, timer = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [])
  const entries: Entry[] = [
    ...rooms.map(room => ({ id: room.id, kind: 'room' as const, name: room.name, cwd: room.cwd, updatedAt: room.updatedAt ?? '', detail: room.busy ? '正在回复…' : room.preview || '群组对话', room })),
    ...sessions.filter(session => !session.room).map(session => ({ id: session.id, kind: 'session' as const, name: session.title || session.engineId, cwd: session.cwd, updatedAt: session.updatedAt ?? session.createdAt ?? '', detail: session.state === 'running' ? '正在回复…' : session.state === 'detached' ? '可恢复' : session.engineId, session })),
  ].sort((a, b) => Number(!!((b.kind === 'room' ? b.room.pinned : b.session.pinned))) - Number(!!((a.kind === 'room' ? a.room.pinned : a.session.pinned))) || b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
  const needle = query.trim().toLowerCase()
  const visible = entries.filter(entry => !!(entry.room?.archived ?? entry.session?.archived) === archived && (searched || `${entry.name} ${entry.cwd} ${entry.detail}`.toLowerCase().includes(needle)))
  const projects = new Map<string, Entry[]>()
  for (const entry of visible) {
    const key = directoryKey(entry.cwd), list = projects.get(key) ?? []
    list.push(entry); projects.set(key, list)
  }
  const row = (entry: Entry, recent: boolean) => <button type="button" key={`${entry.kind}:${entry.id}`} className="lumo-chat-history-entry"
    aria-label={`打开${entry.kind === 'room' ? '群组' : '对话'} ${entry.name}`} aria-current={selected === `${entry.kind}:${entry.id}` ? 'page' : undefined}
    disabled={disabled || entry.session?.state === 'starting'} title={recent ? entry.name : `${entry.name}\n${entry.cwd}\n${entry.detail}`}
    onClick={() => entry.kind === 'room' ? openRoom(entry.id) : openSession(entry.id)}>
    {entry.room ? <RoomLogo appearance={entry.room.appearance} engines={entry.room.engineIds ?? []} /> : <EngineLogo engineId={entry.session!.engineId} small />}
    <span><b>{entry.name}</b>{recent ? <RecentTime at={entry.updatedAt} now={now} /> : <small>{entry.detail}</small>}</span>
  </button>
  return <div className="lumo-chat-history-sections"><button type="button" aria-pressed={archived} onClick={() => showArchived(!archived)}>{archived ? '返回活跃对话' : '已归档对话'}</button>
    <section aria-label="项目"><div className="lumo-chat-history-heading"><small>项目</small></div>
      {[...projects].map(([cwd, project]) => <div className="lumo-chat-project-group" key={cwd}>
        <button type="button" className="lumo-chat-project-heading" aria-label={`项目 ${cwd}`} title={cwd} aria-expanded={!!needle || !collapsed.has(cwd)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(cwd)) next.delete(cwd); else next.add(cwd); return next })}>
          <FolderIcon size={15} /><span>{projectName(cwd)}</span><small>{project.length}</small><span aria-hidden="true">{collapsed.has(cwd) && !needle ? '›' : '⌄'}</span>
        </button>
        {needle || !collapsed.has(cwd) ? <nav className="lumo-chat-history" aria-label={`${cwd} 的对话`}>{project.map(entry => row(entry, false))}</nav> : null}
      </div>)}
      {!projects.size ? <p className="lumo-muted">{needle ? '没有匹配的项目' : '开始对话后，项目会显示在这里'}</p> : null}
    </section>
    <section aria-label="最近对话"><div className="lumo-chat-history-heading"><small>最近对话</small></div>
      <nav className="lumo-chat-history" aria-label="最近对话记录">{visible.slice(0, 20).map(entry => row(entry, true))}</nav>
      {!visible.length ? <p className="lumo-muted">{needle ? '没有匹配的对话' : '暂无对话'}</p> : null}
    </section>
  </div>
}
