import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getDesktopPetServices, subscribeDesktopPetServices, type DesktopPetServices, type DesktopSessionSummary } from './desktop-pet.ts'
import './desktop-pet-tasks.css'

const subscribeServices = (listener: () => void) => subscribeDesktopPetServices(window, listener)
const getServices = () => getDesktopPetServices(window)
const noopSubscribe = () => () => {}

function updatedLabel(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '更新时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function SessionTasks({ services, onClose }: { services: DesktopPetServices; onClose(): void }) {
  const sessions = useSyncExternalStore(listener => services.sessions.list.subscribe?.(listener) ?? noopSubscribe(), () => services.sessions.list.getSnapshot())
  const workspaces = useSyncExternalStore(listener => services.workspaces.list.subscribe?.(listener) ?? noopSubscribe(), () => services.workspaces.list.getSnapshot())
  const [query, setQuery] = useState('')
  const [onlyRunning, setOnlyRunning] = useState(false)
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [limit, setLimit] = useState(30)
  const [error, setError] = useState('')
  const { options, bySession } = useMemo(() => {
    const options = workspaces.items.map(ws => ({ value: `ws:${ws.workspaceId}`, label: ws.title || ws.path || ws.workspaceId, path: ws.path, id: ws.workspaceId, sessionIds: ws.sessionIds }))
    const counts = new Map<string, number>()
    for (const { label } of options) counts.set(label, (counts.get(label) ?? 0) + 1)
    const bySession = new Map<string, typeof options>()
    for (const option of options) {
      if ((counts.get(option.label) ?? 0) > 1) option.label += ` · ${option.path && option.path !== option.label ? option.path : option.id}`
      for (const id of option.sessionIds) {
        const memberships = bySession.get(id)
        if (memberships) memberships.push(option)
        else bySession.set(id, [option])
      }
    }
    return { options, bySession }
  }, [workspaces.items])
  useEffect(() => {
    if (workspaces.phase === 'ready' && workspaceFilter.startsWith('ws:') && !options.some(option => option.value === workspaceFilter)) {
      setWorkspaceFilter('')
      setLimit(30)
    }
  }, [workspaces.phase, options, workspaceFilter])
  const archived = new Set(workspaces.archivedSessionIds ?? [])
  const rows = (sessions.ids ?? Object.keys(sessions.byId)).flatMap(id => {
    const summary = sessions.byId[id]
    return summary === undefined || archived.has(id) || summary.origin === 'subagent' || (summary.blank === true && summary.running !== true) ? [] : [{ id, ...summary, memberships: bySession.get(id) ?? [] }]
  }).sort((left, right) => Number(right.running === true) - Number(left.running === true) || right.updatedAt - left.updatedAt)
  const runningCount = rows.filter(row => row.running === true).length
  const needle = query.trim().toLocaleLowerCase()
  const visible = rows.filter(row => {
    if (onlyRunning && row.running !== true) return false
    if (workspaceFilter === 'unassigned' && row.memberships.length > 0) return false
    if (workspaceFilter.startsWith('ws:') && !row.memberships.some(ws => ws.value === workspaceFilter)) return false
    return [row.displayTitle ?? row.id, row.cwd, ...row.memberships.flatMap(ws => [ws.label, ws.path])].some(text => text?.toLocaleLowerCase().includes(needle))
  })
  const open = (id: string) => {
    try { services.uiWorkspace.openSession(id); onClose() }
    catch { setError('该对话暂时无法打开，请稍后重试。') }
  }
  const state = (row: DesktopSessionSummary) => row.running === true ? '进行中' : row.running === false ? '未在运行' : '状态未知'
  return <>
    <div className="lumo-pet-task-summary"><span><b>{runningCount}</b> 个对话正在运行</span><span>来自本机对话状态</span></div>
    <div className="lumo-pet-task-toolbar">
      <label><span className="lumo-pet-task-sr">搜索对话</span><input value={query} onChange={event => { setQuery(event.target.value); setLimit(30) }} placeholder="搜索对话、工作区或目录…" /></label>
      <select aria-label="筛选工作区" value={workspaceFilter} onChange={event => { setWorkspaceFilter(event.target.value); setLimit(30) }}>
        <option value="">全部工作区</option>
        {options.map(ws => <option key={ws.value} value={ws.value}>{ws.label}</option>)}
        <option value="unassigned">未归属工作区</option>
      </select>
      <label className="lumo-pet-task-filter"><input type="checkbox" checked={onlyRunning} onChange={event => { setOnlyRunning(event.target.checked); setLimit(30) }} />只看进行中</label>
    </div>
    {error ? <p className="lumo-pet-task-error" role="alert">{error}</p> : null}
    {sessions.phase !== 'ready' || workspaces.phase !== 'ready' ? <p className="lumo-pet-task-empty" role="status">正在同步本机对话…</p> : visible.length === 0 ? <p className="lumo-pet-task-empty" role="status">{query || onlyRunning || workspaceFilter ? '没有符合条件的对话。' : '还没有对话任务，从桌宠写下第一个想法吧。'}</p> : <ul className="lumo-pet-task-list">{visible.slice(0, limit).map(row => <li key={row.id}><button type="button" onClick={() => open(row.id)}>
      <span className="lumo-pet-task-row-head"><strong>{row.displayTitle ?? row.id}</strong><span data-running={row.running === true}>{state(row)}</span></span>
      <span className="lumo-pet-task-directory">{row.memberships.map(ws => ws.label).join('、') || '未归属工作区'} · {row.cwd ?? '未提供工作目录'}</span>
      <span className="lumo-pet-task-row-footer"><time>{updatedLabel(row.updatedAt)}</time><span>打开对话 ↗</span></span>
    </button></li>)}</ul>}
    {visible.length > limit ? <button type="button" className="lumo-pet-task-more" onClick={() => setLimit(value => value + 30)}>显示更多（还有 {visible.length - limit} 个）</button> : null}
  </>
}

/** A desktop-only view over real local Sessions; no cluster or scheduler API is required. */
export function DesktopPetTasks({ onClose }: { onClose(): void }) {
  const services = useSyncExternalStore(subscribeServices, getServices, () => undefined)
  const panel = useRef<HTMLElement>(null)
  const close = () => onClose()
  return <div className="lumo-pet-task-backdrop"><section ref={panel} className="lumo-pet-tasks" role="dialog" aria-modal="true" aria-label="本机对话任务" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (event.key !== 'Tab') return
    const focusable = [...panel.current?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select') ?? []].filter(element => !element.disabled)
    const first = focusable?.[0]; const last = focusable?.[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}><header><div><span>桌面伙伴</span><h1>本机对话任务</h1><p>查看运行中的工作，随时回到对话继续。</p></div><button type="button" autoFocus onClick={close} aria-label="关闭本机对话任务">×</button></header><main>{services === undefined ? <p className="lumo-pet-task-empty" role="status">本地工作台尚未就绪，请稍后重试。</p> : <SessionTasks services={services} onClose={close} />}</main><footer>“未在运行”仅表示当前没有模型执行，不代表任务已完成。<button type="button" onClick={close}>返回对话</button></footer></section></div>
}
