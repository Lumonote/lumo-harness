import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import './workforce-progress-panel.css'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ProgressRecord {
  task_id: string; run_id: string; revision: number; status: 'on_track' | 'at_risk' | 'blocked'; percent: number
  summary: string; next_step: string; blocked_reason?: string; due_at?: string; updated_by: string; updated_at: string; source: string
}
interface ProgressView { current_run_id: string; revision: number; progress: ProgressRecord | null; history: ProgressRecord[]; can_update: boolean }
interface WorkforceTask { id: string; title: string; state: string; assignee_name?: string; assignee_user_id?: string; assignee_worker_id?: string; project_id?: string }
interface WorkforceItem { task: WorkforceTask; run?: { id: string; state: string }; progress?: ProgressRecord; health: { blocked: boolean; overdue: boolean; stale: boolean; awaiting_review: boolean } }
interface WorkforcePage {
  items: WorkforceItem[]; summary: { total: number; active: number; blocked: number; overdue: number; stale: number; awaiting_review: number; accepted: number; at_risk?: number }
  summary_scope: 'page' | 'filtered_scope'; next_cursor?: string
  by_worker_kind?: Record<'employee' | 'agent' | 'unassigned', { total: number }>
}
const statusLabels = { on_track: '按计划推进', at_risk: '存在风险', blocked: '需要协助' }
const healthLabels = { blocked: '阻塞', overdue: '逾期', stale: '待更新', awaiting_review: '待验收' }
const taskStates: Record<string, string> = { ASSIGNED: '已分派', QUEUED: '排队中', RUNNING: '执行中', CANCELLING: '取消中', BLOCKED: '阻塞', COMPLETED: '执行完成', FAILED: '失败', CANCELED: '已取消', CANCELLED: '已取消' }
const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

function validProgress(value: unknown): value is ProgressRecord {
  if (value === null || typeof value !== 'object') return false
  const p = value as ProgressRecord
  return typeof p.task_id === 'string' && typeof p.run_id === 'string' && Number.isSafeInteger(p.revision) && p.revision > 0 &&
    ['on_track', 'at_risk', 'blocked'].includes(p.status) && Number.isInteger(p.percent) && p.percent >= 0 && p.percent <= 100 &&
    typeof p.summary === 'string' && typeof p.next_step === 'string' && typeof p.updated_by === 'string' &&
    typeof p.updated_at === 'string' && Number.isFinite(Date.parse(p.updated_at))
}
function validView(value: ProgressView, taskID: string): boolean {
  return value !== null && typeof value === 'object' && typeof value.current_run_id === 'string' &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.can_update === 'boolean' &&
    Array.isArray(value.history) && value.history.every(p => validProgress(p) && p.task_id === taskID) &&
    (value.progress === null || (validProgress(value.progress) && value.progress.task_id === taskID && value.progress.run_id === value.current_run_id))
}
function validPage(value: WorkforcePage): boolean {
  return value !== null && typeof value === 'object' && ['page', 'filtered_scope'].includes(value.summary_scope) &&
    (value.next_cursor === undefined || typeof value.next_cursor === 'string') &&
    value.summary !== null && typeof value.summary === 'object' &&
    ['total', 'active', 'blocked', 'overdue', 'stale', 'awaiting_review', 'accepted'].every(key => { const count = value.summary[key as keyof WorkforcePage['summary']]; return Number.isSafeInteger(count) && count! >= 0 }) &&
    (value.summary_scope === 'page' || Number.isSafeInteger(value.summary.at_risk) && value.summary.at_risk! >= 0) &&
    (value.by_worker_kind === undefined || ['employee', 'agent', 'unassigned'].every(key => {
      const group = value.by_worker_kind?.[key as keyof NonNullable<WorkforcePage['by_worker_kind']>]
      return group && Number.isSafeInteger(group.total) && group.total >= 0
    })) &&
    Array.isArray(value.items) && value.items.every(item => item?.task && typeof item.task.id === 'string' && typeof item.task.title === 'string' && typeof item.task.state === 'string' &&
      item.health && ['blocked', 'overdue', 'stale', 'awaiting_review'].every(key => typeof item.health[key as keyof WorkforceItem['health']] === 'boolean') &&
      (item.run === undefined || (typeof item.run.id === 'string' && typeof item.run.state === 'string')) &&
      (item.progress === undefined || (validProgress(item.progress) && item.progress.task_id === item.task.id && (!item.run || item.progress.run_id === item.run.id))))
}

function dateLabel(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未设置' }
function localDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function ProgressBar({ progress }: { progress?: ProgressRecord | null | undefined }) {
  return <div className="lumo-progress-meter"><progress max={100} value={progress?.percent ?? 0} aria-label="阶段进度" /><b>{progress ? `${progress.percent}%` : '未汇报'}</b></div>
}

export function TaskProgressPanel({ request, taskID, onSaved, onEditingChange }: { request: Request; taskID: string; onSaved?: () => void; onEditingChange?: (editing: boolean) => void }) {
  const [view, setView] = useState<ProgressView | null>(null)
  const [draft, setDraft] = useState({ status: 'on_track', percent: '0', summary: '', next_step: '', blocked_reason: '', due_at: '' })
  const [editing, setEditing] = useState(false)
  const [conflict, setConflict] = useState(false)
  const baseline = useRef({ runID: '', revision: 0 })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const sequence = useRef(0)
  const pending = useRef(false)
  const saveEpoch = useRef(0)
  const editingRef = useRef(false)
  const editingCallback = useRef(onEditingChange)
  editingCallback.current = onEditingChange
  useEffect(() => { editingCallback.current?.(editing); return () => { editingCallback.current?.(false) } }, [editing])
  const path = `/lumo/api/tasks/${encodeURIComponent(taskID)}/progress`
  const adopt = (value: ProgressView) => {
    const p = value.progress
    setDraft({ status: p?.status ?? 'on_track', percent: String(p?.percent ?? 0), summary: p?.summary ?? '', next_step: p?.next_step ?? '', blocked_reason: p?.blocked_reason ?? '', due_at: localDate(p?.due_at) })
  }
  const load = useCallback(async (reset = false) => {
    const generation = ++sequence.current
    setLoading(true)
    try {
      const value = await request<ProgressView>(path)
      if (generation !== sequence.current) return
      if (!validView(value, taskID)) throw new Error('任务进度响应无效，请重新读取。')
      setView(value); setError('')
      if (reset) { adopt(value); setConflict(false); setEditing(false); editingRef.current = false }
      else if (editingRef.current) setConflict(!value.can_update || value.current_run_id !== baseline.current.runID || value.revision !== baseline.current.revision)
    } catch (reason) { if (generation === sequence.current) {
      setError(reasonText(reason))
      // Keep editable text through transient failures; never imply the cached
      // write authority is still current after a failed refresh.
      if (editingRef.current) setConflict(true)
      else setView(null)
    } }
    finally { if (generation === sequence.current) setLoading(false) }
  }, [request, path, taskID])
  useEffect(() => {
    setView(null); setEditing(false); editingRef.current = false; setConflict(false); setNotice(''); pending.current = false; setBusy(false)
    void load(true)
    const timer = window.setInterval(() => { if (!editingRef.current && !pending.current && document.visibilityState !== 'hidden') void load() }, 30000)
    return () => { ++sequence.current; ++saveEpoch.current; window.clearInterval(timer) }
  }, [load])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!view?.can_update || pending.current || conflict || loading) return
    const percent = Number(draft.percent)
    if (!Number.isInteger(percent) || percent < 0 || percent > 100 || !draft.summary.trim() || !draft.next_step.trim() || (draft.status === 'blocked' && !draft.blocked_reason.trim())) {
      setError('请填写进展、下一步和阻塞原因，并使用 0–100 的整数进度。'); return
    }
    pending.current = true; setBusy(true); setError(''); setNotice('')
    const generation = ++sequence.current
    const epoch = saveEpoch.current
    try {
      const result = await request<ProgressRecord>(path, { method: 'PUT', body: JSON.stringify({ run_id: baseline.current.runID, expected_revision: baseline.current.revision, status: draft.status, percent,
        summary: draft.summary.trim(), next_step: draft.next_step.trim(), blocked_reason: draft.status === 'blocked' ? draft.blocked_reason.trim() : '', due_at: draft.due_at ? new Date(draft.due_at).toISOString() : null }) })
      if (generation !== sequence.current) return
      if (!validProgress(result) || result.task_id !== taskID || result.run_id !== baseline.current.runID || result.revision !== baseline.current.revision + 1) {
        setConflict(true); throw new Error('保存回执与本次进度不一致，请核对最新记录；草稿已保留。')
      }
      setNotice('进度已记录，完成状态仍需结果验收。'); setEditing(false); editingRef.current = false
      await load(true); onSaved?.()
    } catch (reason) {
      if (generation !== sequence.current) return
      const stale = typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409
      if (stale) setConflict(true)
      setError(stale ? '进度或执行尝试已变化。草稿已保留，请核对最新记录。' : reasonText(reason))
    } finally { if (epoch === saveEpoch.current) { pending.current = false; setBusy(false) } }
  }
  return <section className="lumo-section lumo-task-progress" aria-label="任务进度" aria-busy={loading || busy}>
    <div className="lumo-section-title"><div><b>任务进度</b><span>阶段汇报 · 保留最近 30 条历史</span></div><button type="button" className="lumo-button lumo-secondary" disabled={busy || loading} onClick={() => void load(!editing)}>{conflict ? '读取最新记录' : editing ? '核对最新进度' : '刷新进度'}</button></div>
    {error ? <div role="alert" className="lumo-cluster-feedback error">{error}</div> : null}
    {notice ? <div role="status" className="lumo-cluster-feedback">{notice}</div> : null}
    {view ? <>
      <p className="lumo-progress-run">当前执行：{view.current_run_id || '尚未分派'} · 记录版本 {view.revision}</p>
      <ProgressBar progress={view.progress} />
      {view.progress ? <div className="lumo-progress-details"><b>{statusLabels[view.progress.status]}</b><p>{view.progress.summary}</p><p><strong>下一步</strong> {view.progress.next_step}</p>{view.progress.blocked_reason ? <p className="lumo-progress-blocker"><strong>需要协助</strong> {view.progress.blocked_reason}</p> : null}<small>{view.progress.updated_by} · {dateLabel(view.progress.updated_at)} · 截止 {dateLabel(view.progress.due_at)}</small></div> : <p className="lumo-inline-empty">当前执行尝试尚未汇报进度。</p>}
      {view.can_update && !editing ? <button type="button" className="lumo-button lumo-primary" onClick={() => { ++sequence.current; setLoading(false); baseline.current = { runID: view.current_run_id, revision: view.revision }; adopt(view); setEditing(true); editingRef.current = true; setNotice('') }}>更新进度</button> : null}
      {!view.can_update ? <p className="lumo-inline-empty">当前任务只读；进度仅能由有权参与者在有效执行尝试中更新。</p> : null}
      {editing ? <form className="lumo-progress-form" onSubmit={save}>
        <p className="wide lumo-workforce-note">正在编辑执行 {baseline.current.runID} 的版本 {baseline.current.revision}；刷新仅核对服务器记录，保留以下草稿。</p>
        {conflict ? <div className="wide lumo-progress-conflict" role="status"><p>{view.current_run_id !== baseline.current.runID ? '任务已开始新的执行尝试，旧草稿不能提交到新执行。' : !view.can_update ? '当前执行已结束或写入权限已变更，保留草稿供复制。' : '服务器记录已变化，请先核对上方最新进度，再决定如何继续。'}</p><div>{view.can_update && view.current_run_id === baseline.current.runID && !error ? <button type="button" className="lumo-button lumo-secondary" disabled={busy || loading} onClick={() => { baseline.current = { runID: view.current_run_id, revision: view.revision }; setConflict(false); setError('') }}>保留草稿，以最新版本继续编辑</button> : null}<button type="button" className="lumo-button lumo-secondary" disabled={busy || loading} onClick={() => void load(true)}>放弃草稿并读取最新进度</button></div></div> : null}
        <label>推进状态<select value={draft.status} disabled={busy} onChange={e => setDraft({ ...draft, status: e.target.value })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>阶段进度（%）<input type="number" min={0} max={100} step={1} required disabled={busy} value={draft.percent} onChange={e => setDraft({ ...draft, percent: e.target.value })} /></label>
        <label className="wide">已完成的进展<textarea required maxLength={4000} rows={3} disabled={busy} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} /></label>
        <label className="wide">下一步与交接说明<textarea required maxLength={2000} rows={2} disabled={busy} value={draft.next_step} onChange={e => setDraft({ ...draft, next_step: e.target.value })} /></label>
        {draft.status === 'blocked' ? <label className="wide">阻塞原因与所需协助<textarea required maxLength={2000} rows={2} disabled={busy} value={draft.blocked_reason} onChange={e => setDraft({ ...draft, blocked_reason: e.target.value })} /></label> : null}
        <label>目标截止时间<input type="datetime-local" disabled={busy} value={draft.due_at} onChange={e => setDraft({ ...draft, due_at: e.target.value })} /></label>
        <div className="lumo-form-actions"><button className="lumo-button lumo-primary" type="submit" disabled={busy || loading || conflict || !view.can_update}>{busy ? '正在保存' : '保存进度'}</button><button type="button" className="lumo-button lumo-secondary" disabled={busy} onClick={() => { setEditing(false); editingRef.current = false; setConflict(false); setError('') }}>取消</button></div>
      </form> : null}
      {view.history.length ? <details className="lumo-progress-history"><summary>进度记录（{view.history.length}）</summary><ol>{view.history.map(record => <li key={record.revision}><div><b>{record.percent}% · {statusLabels[record.status]}</b><small>{record.source === 'runtime' ? '智能体' : record.updated_by} · {dateLabel(record.updated_at)} · 版本 {record.revision}</small></div><p>{record.summary}</p><p>下一步：{record.next_step}</p>{record.blocked_reason ? <p>阻塞：{record.blocked_reason}</p> : null}<small>执行 {record.run_id}</small></li>)}</ol></details> : null}
    </> : !loading ? <p className="lumo-inline-empty">进度暂不可用，请刷新重试。</p> : null}
  </section>
}

export function WorkforceProgressPanel({ request, onOpen }: { request: Request; onOpen?: (taskID: string) => void }) {
  const [scope, setScope] = useState('mine')
  const [roles, setRoles] = useState<string[]>([])
  const [cursors, setCursors] = useState([''])
  const [page, setPage] = useState<WorkforcePage | null>(null)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [workerKind, setWorkerKind] = useState('all')
  const [selected, setSelected] = useState('')
  const [editingTask, setEditingTask] = useState(false)
  const editingTaskRef = useRef(false)
  const trackEditing = useCallback((value: boolean) => {
    editingTaskRef.current = value; setEditingTask(value)
    if (value) { ++sequence.current; inflight.current = false; setLoading(false) }
  }, [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [synced, setSynced] = useState('')
  const sequence = useRef(0)
  const inflight = useRef(false)
  const cursor = cursors[cursors.length - 1]!
  useEffect(() => { let active = true; void request<{ roles: string[] }>('/auth/account', { headers: { 'X-Lumo-Auth-Request': '1' } }).then(account => { if (active) setRoles(account.roles ?? []) }).catch(() => {}); return () => { active = false } }, [request])
  const load = useCallback(async () => {
    const generation = ++sequence.current
    inflight.current = true; setLoading(true)
    try {
      const value = await request<WorkforcePage>(`/lumo/api/workforce/progress?${new URLSearchParams({ scope, limit: '50', cursor, q: appliedQuery, risk: filter, worker_kind: workerKind })}`)
      if (generation !== sequence.current) return
      if (!validPage(value)) throw new Error('团队进度响应无效，请重新读取。')
      setPage(value); setError(''); setSynced(new Date().toLocaleTimeString('zh-CN'))
    } catch (reason) { if (generation === sequence.current) { setError(reasonText(reason)); setPage(null) } }
    finally { if (generation === sequence.current) { setLoading(false); inflight.current = false } }
  }, [request, scope, cursor, appliedQuery, filter, workerKind])
  useEffect(() => {
    setPage(null); setSelected(''); void load()
    const timer = window.setInterval(() => { if (!inflight.current && !editingTaskRef.current && document.visibilityState !== 'hidden') void load() }, 30000)
    return () => { ++sequence.current; window.clearInterval(timer) }
  }, [load])
  const admin = roles.some(role => ['platform_admin', 'realm_admin', 'admin'].includes(role))
  const completeScope = page?.summary_scope === 'filtered_scope'
  const items = completeScope ? page.items : (page?.items ?? []).filter(item => (filter === 'all' || (filter === 'at_risk' ? item.progress?.status === 'at_risk' : item.health[filter as keyof WorkforceItem['health']])) && `${item.task.title} ${item.task.assignee_name ?? ''} ${item.task.assignee_user_id ?? ''} ${item.task.assignee_worker_id ?? ''} ${item.progress?.summary ?? ''}`.toLowerCase().includes(appliedQuery.toLowerCase()))
  return <section className="lumo-section lumo-workforce-progress" aria-label="员工与智能体进度" aria-busy={loading}>
    <div className="lumo-section-title"><div><b>员工与智能体进度</b><span>{synced ? `同步于 ${synced} · 每 30 秒更新` : '正在读取任务进度'}</span></div><button type="button" className="lumo-button lumo-secondary" disabled={loading || editingTask} onClick={() => void load()}>刷新看板</button></div>
    <form className="lumo-workforce-toolbar" onSubmit={event => { event.preventDefault(); if (!editingTask) { setAppliedQuery(query.trim()); setCursors(['']) } }}>
      <label>任务范围<select disabled={editingTask} value={scope} onChange={e => { setScope(e.target.value); setCursors(['']) }}><option value="mine">与我相关</option>{admin || roles.includes('dept_manager') ? <option value="department">我的部门</option> : null}{admin ? <option value="all">全组织</option> : null}</select></label>
      <label>搜索任务与负责人<input type="search" maxLength={200} disabled={editingTask} placeholder="任务、员工、Agent 或进展" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>关注状态<select disabled={editingTask} value={filter} onChange={e => { setFilter(e.target.value); setCursors(['']) }}><option value="all">全部</option>{Object.entries(healthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="at_risk">存在风险</option><option value="active">进行中</option><option value="accepted">已验收</option></select></label>
      <label>负责人类型<select disabled={editingTask} value={workerKind} onChange={e => { setWorkerKind(e.target.value); setCursors(['']) }}><option value="all">员工与 Agent</option><option value="employee">员工</option><option value="agent">Agent</option><option value="unassigned">未分派</option></select></label>
      <button type="submit" className="lumo-button lumo-secondary" disabled={editingTask || loading}>搜索</button>
    </form>
    {error ? <div role="alert" className="lumo-cluster-feedback error">{error}</div> : null}
    {page ? <>
      <div className="lumo-workforce-metrics" aria-label={completeScope ? '筛选范围任务统计' : '当前页任务统计'}>{([['total', '可见任务'], ['active', '进行中'], ['blocked', '阻塞'], ['overdue', '逾期'], ['at_risk', '有风险'], ['stale', '待更新'], ['awaiting_review', '待验收']] as const).map(([key, label]) => <div key={key}><span>{label}</span><b>{page.summary[key] ?? 0}</b></div>)}</div>
      {completeScope && page.by_worker_kind ? <div className="lumo-workforce-kinds" aria-label="负责人任务分布"><span>员工任务 <b>{page.by_worker_kind.employee.total}</b></span><span>Agent 任务 <b>{page.by_worker_kind.agent.total}</b></span><span>未分派 <b>{page.by_worker_kind.unassigned.total}</b></span></div> : null}
      <p className="lumo-workforce-note">{editingTask ? '正在编辑进度，已暂停看板刷新与切换；保存或取消后恢复。' : ''}{completeScope ? '统计与搜索覆盖当前筛选下全部有权查看的任务，翻页不改变统计范围。' : '当前控制面仅提供页内统计；统计与筛选仅覆盖当前页有权查看的任务。'}阶段百分比由参与者或智能体汇报，交付完成以验收结果为准。</p>
      <div className="lumo-workforce-list">{items.map(item => <article key={item.task.id} className={item.health.blocked || item.health.overdue ? 'attention' : ''}>
        <header><div><b>{item.task.title}</b><small>{item.task.assignee_name || item.task.assignee_worker_id || item.task.assignee_user_id || '待分派'} · {taskStates[item.task.state] ?? item.task.state}</small></div><div className="lumo-workforce-badges">{Object.entries(healthLabels).filter(([key]) => item.health[key as keyof WorkforceItem['health']]).map(([key, label]) => <span key={key}>{label}</span>)}{item.progress?.status === 'at_risk' ? <span>存在风险</span> : null}</div></header>
        <ProgressBar progress={item.progress} /><p>{item.progress?.summary || '等待首次进度汇报'}</p>{item.progress?.blocked_reason ? <p className="lumo-progress-blocker">{item.progress.blocked_reason}</p> : null}{item.progress?.next_step ? <p><strong>下一步</strong> {item.progress.next_step}</p> : null}
        <footer><small>{item.progress ? `更新 ${dateLabel(item.progress.updated_at)}` : '尚未更新'}{item.progress?.due_at ? ` · 截止 ${dateLabel(item.progress.due_at)}` : ''}</small><div><button type="button" className="lumo-button lumo-secondary" disabled={editingTask} onClick={() => setSelected(selected === item.task.id ? '' : item.task.id)}>{selected === item.task.id ? '收起进度' : '查看与汇报'}</button>{onOpen ? <button type="button" className="lumo-button lumo-secondary" disabled={editingTask} onClick={() => onOpen(item.task.id)}>协作与运行</button> : null}</div></footer>
      </article>)}</div>
      {!items.length ? <p className="lumo-inline-empty">{completeScope ? '当前筛选下没有更多任务。' : '当前页没有符合条件的任务。'}{page.next_cursor ? '仍可继续查看下一页。' : ''}</p> : null}
      <nav className="lumo-workforce-pages" aria-label="任务进度分页"><button type="button" className="lumo-button lumo-secondary" disabled={loading || editingTask || cursors.length === 1} onClick={() => setCursors(values => values.slice(0, -1))}>上一页</button><span>第 {cursors.length} 页 · {items.length} / {page.items.length} 项</span><button type="button" className="lumo-button lumo-secondary" disabled={loading || editingTask || !page.next_cursor} onClick={() => { if (page.next_cursor) setCursors(values => [...values, page.next_cursor!]) }}>下一页</button></nav>
      {selected && page.items.some(item => item.task.id === selected) ? <TaskProgressPanel key={selected} request={request} taskID={selected} onEditingChange={trackEditing} onSaved={() => void load()} /> : null}
    </> : null}
  </section>
}
