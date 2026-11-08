import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ProjectSpaceGrantsPanel, type SpaceMember } from './project-space-grants-panel.tsx'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ProjectResourceSpace { spaceId: string; name: string }
export interface ProjectResourceAutomation { automationId: string; triggerKind: string; triggerSpec: string; flowRef: string; enabled: boolean; revision: number }
export interface ProjectResourceArtifact { kind: string; name: string; version: string }
interface Shared { request: Request; projectID: string; editable: boolean; refresh: () => Promise<void> }
function useMutation(refresh: Shared['refresh']) {
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [busy, setBusy] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const run = async (operation: () => Promise<unknown>, success: string) => {
    if (pending.current || needsReload) return false
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await operation()
      if (!mounted.current) return false
      setNotice(success)
      try { await refresh() } catch (reason) {
        if (mounted.current) { setNeedsReload(true); setError(`已保存，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
      }
      return mounted.current
    } catch (reason) {
      if (!mounted.current) return false
      const conflict = reason instanceof Error && 'status' in reason && reason.status === 409
      if (conflict) setNeedsReload(true)
      setError(`${reason instanceof Error ? reason.message : String(reason)}${conflict ? '。请刷新数据后重新编辑。' : ''}`)
      return false
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const reload = async (reset: () => void) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      await refresh()
      if (!mounted.current) return
      reset(); setNeedsReload(false); setNotice('资源已重新读取，请选择最新记录后编辑。')
    } catch (reason) { if (mounted.current) setError(`读取失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return { busy, locked: busy || needsReload, needsReload, error, notice, run, reload }
}
function Feedback({ state, reset }: { state: ReturnType<typeof useMutation>; reset: () => void }) {
  return <>{state.error ? <p className="lumo-cluster-feedback error" role="alert">{state.error}</p> : null}{state.notice ? <p className="lumo-cluster-feedback" role="status">{state.notice}</p> : null}{state.needsReload ? <button type="button" className={button} disabled={state.busy} onClick={() => void state.reload(reset)}>重新读取资源并结束编辑</button> : null}</>
}
const button = 'lumo-button lumo-secondary lumo-small'

type SpacesProps = Shared & { spaces: ProjectResourceSpace[]; canManageGrants?: boolean; members?: SpaceMember[] }
export function ProjectSpacesPanel(props: SpacesProps) {
  return <ProjectSpacesEditor key={props.projectID} {...props} />
}
function ProjectSpacesEditor({ request, projectID, editable, refresh, spaces, canManageGrants = false, members = [] }: SpacesProps) {
  const action = useMutation(refresh)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<ProjectResourceSpace | null>(null)
  const [remove, setRemove] = useState<ProjectResourceSpace | null>(null)
  const [grantSpace, setGrantSpace] = useState('')
  const reset = () => { setName(''); setEditing(null); setRemove(null); setGrantSpace('') }
  const base = `/lumo/api/projects/${encodeURIComponent(projectID)}/spaces`
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!editable || !name.trim()) return
    const target = editing
    if (await action.run(() => request(target ? `${base}/${encodeURIComponent(target.spaceId)}` : base, { method: target ? 'PATCH' : 'POST', body: JSON.stringify({ name: name.trim(), ...(target ? { expectedName: target.name } : {}) }) }), target ? '空间名称已保存。' : '项目空间已创建。')) { setName(''); setEditing(null) }
  }
  const detach = async (space: ProjectResourceSpace) => {
    if (!editable || remove?.spaceId !== space.spaceId) return
    if (await action.run(() => request(`${base}/${encodeURIComponent(space.spaceId)}`, { method: 'DELETE', body: JSON.stringify({ expectedName: remove.name }) }), '空间已从项目移除，知识资料保留。')) { setRemove(null); if (editing?.spaceId === space.spaceId) { setName(''); setEditing(null) } if (grantSpace === space.spaceId) setGrantSpace('') }
  }
  return <section className="lumo-cluster-panel" aria-label="项目空间管理"><h4>知识空间</h4><Feedback state={action} reset={reset} />
    <div className="lumo-cluster-list">{spaces.map(space => <div key={space.spaceId}><span><b>{space.name}</b><small>{space.spaceId}</small></span>{editable ? <div className="lumo-form-actions"><button type="button" className={button} disabled={action.locked} aria-label={`重命名空间 ${space.name}`} onClick={() => { setEditing(space); setName(space.name); setRemove(null) }}>重命名</button>{remove?.spaceId === space.spaceId ? <><button type="button" className={`${button} lumo-danger`} disabled={action.locked} onClick={() => void detach(space)}>确认移除空间</button><button type="button" className={button} onClick={() => setRemove(null)}>取消</button></> : <button type="button" className={`${button} lumo-danger`} disabled={action.locked} aria-label={`移除空间 ${space.name}`} onClick={() => setRemove(space)}>移除</button>}</div> : null}</div>)}</div>
    {canManageGrants ? <div className="lumo-form-actions">{spaces.map(space => <button type="button" key={space.spaceId} className={button} onClick={() => setGrantSpace(current => current === space.spaceId ? '' : space.spaceId)}>{space.spaceId === grantSpace ? '收起授权' : '管理授权'} · {space.name}</button>)}</div> : null}
    {canManageGrants && spaces.some(space => space.spaceId === grantSpace) ? <ProjectSpaceGrantsPanel key={grantSpace} request={request} projectID={projectID} spaceID={grantSpace} members={members} editable={editable} /> : null}
    {!spaces.length ? <p className="lumo-muted">还没有项目空间。</p> : null}
    {remove ? <p className="lumo-form-hint">移除仅解除项目挂载，知识来源和原始资料会保留。</p> : null}
    {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={save}><label>空间名称<input aria-label="项目空间名称" value={name} maxLength={120} disabled={action.locked} onChange={event => setName(event.target.value)} required /></label><div className="lumo-form-actions"><button type="submit" className={button} disabled={action.locked || !name.trim()}>{editing ? '保存空间名称' : '创建空间'}</button>{editing ? <button type="button" className={button} disabled={action.locked} onClick={() => { setEditing(null); setName('') }}>取消重命名</button> : null}</div></form> : null}
  </section>
}

type AutomationsProps = Shared & { automations: ProjectResourceAutomation[] }
export function ProjectAutomationsPanel(props: AutomationsProps) {
  return <ProjectAutomationsEditor key={props.projectID} {...props} />
}
function ProjectAutomationsEditor({ request, projectID, editable, refresh, automations }: AutomationsProps) {
  const action = useMutation(refresh)
  const [editing, setEditing] = useState<ProjectResourceAutomation | null>(null)
  const [id, setID] = useState('')
  const [kind, setKind] = useState('event')
  const [spec, setSpec] = useState('')
  const [flow, setFlow] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [remove, setRemove] = useState<ProjectResourceAutomation | null>(null)
  const base = `/lumo/api/projects/${encodeURIComponent(projectID)}/automations`
  const reset = () => { setEditing(null); setID(''); setKind('event'); setSpec(''); setFlow(''); setEnabled(true); setRemove(null) }
  const edit = (rule: ProjectResourceAutomation) => { setEditing(rule); setID(rule.automationId); setKind(rule.triggerKind); setSpec(rule.triggerSpec); setFlow(rule.flowRef); setEnabled(rule.enabled); setRemove(null) }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!editable || !id.trim() || !spec.trim() || !flow.trim()) return
    const snapshot = editing
    if (await action.run(() => request(snapshot ? `${base}/${encodeURIComponent(snapshot.automationId)}` : base, { method: snapshot ? 'PATCH' : 'POST', body: JSON.stringify({ ...(snapshot ? { expectedRevision: snapshot.revision } : { automationId: id.trim() }), triggerKind: kind, triggerSpec: spec.trim(), flowRef: flow.trim(), enabled }) }), '自动化规则已保存。')) reset()
  }
  const toggle = async (rule: ProjectResourceAutomation) => {
    if (!editable || editing?.automationId === rule.automationId) return
    await action.run(() => request(`${base}/${encodeURIComponent(rule.automationId)}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: rule.revision, triggerKind: rule.triggerKind, triggerSpec: rule.triggerSpec, flowRef: rule.flowRef, enabled: !rule.enabled }) }), `规则已${rule.enabled ? '停用' : '启用'}。`)
  }
  const detach = async (rule: ProjectResourceAutomation) => {
    if (!editable || remove?.automationId !== rule.automationId) return
    if (await action.run(() => request(`${base}/${encodeURIComponent(rule.automationId)}?expectedRevision=${encodeURIComponent(remove.revision)}`, { method: 'DELETE' }), '自动化规则已删除。')) { setRemove(null); if (editing?.automationId === rule.automationId) reset() }
  }
  return <section className="lumo-cluster-panel" aria-label="项目自动化管理"><h4>自动化调度</h4><Feedback state={action} reset={reset} />
    <div className="lumo-cluster-list">{automations.map(rule => <div key={rule.automationId}><span><b>{rule.automationId}</b><small>{rule.triggerKind} · {rule.triggerSpec} · {rule.flowRef} · {rule.enabled ? '启用' : '停用'} · v{rule.revision}</small></span>{editable ? <div className="lumo-form-actions"><button type="button" className={button} disabled={action.locked} aria-label={`编辑自动化 ${rule.automationId}`} onClick={() => edit(rule)}>编辑</button><button type="button" className={button} disabled={action.locked || editing?.automationId === rule.automationId} aria-label={`${rule.enabled ? '停用' : '启用'}自动化 ${rule.automationId}`} onClick={() => void toggle(rule)}>{rule.enabled ? '停用' : '启用'}</button>{remove?.automationId === rule.automationId ? <><button type="button" className={`${button} lumo-danger`} disabled={action.locked} onClick={() => void detach(rule)}>确认删除自动化</button><button type="button" className={button} onClick={() => setRemove(null)}>取消</button></> : <button type="button" className={`${button} lumo-danger`} disabled={action.locked} aria-label={`删除自动化 ${rule.automationId}`} onClick={() => setRemove(rule)}>删除</button>}</div> : null}</div>)}</div>
    {!automations.length ? <p className="lumo-muted">还没有自动化规则。</p> : null}
    {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={save}><label>规则 ID<input aria-label="规则 ID" value={id} maxLength={128} disabled={action.locked || editing !== null} onChange={event => setID(event.target.value)} required /></label><label>触发类型<select aria-label="规则触发类型" value={kind} disabled={action.locked} onChange={event => setKind(event.target.value)}><option value="event">事件</option><option value="cron">定时</option><option value="webhook">Webhook</option></select></label><label>触发规则<input aria-label="自动化触发规则" value={spec} maxLength={2048} disabled={action.locked} onChange={event => setSpec(event.target.value)} required /></label><label>流程引用<input aria-label="自动化流程引用" value={flow} maxLength={512} disabled={action.locked} onChange={event => setFlow(event.target.value)} required /></label><label className="lumo-cluster-checkbox"><input type="checkbox" aria-label="规则启用状态" checked={enabled} disabled={action.locked} onChange={event => setEnabled(event.target.checked)} />启用</label><div className="lumo-form-actions"><button type="submit" className={button} disabled={action.locked || !id.trim() || !spec.trim() || !flow.trim()}>{editing ? '保存自动化修改' : '创建自动化'}</button>{editing ? <button type="button" className={button} disabled={action.locked} onClick={reset}>取消编辑</button> : null}</div></form> : null}
  </section>
}

type ArtifactsProps = Shared & { artifacts: ProjectResourceArtifact[] }
export function ProjectArtifactsPanel(props: ArtifactsProps) {
  return <ProjectArtifactsEditor key={props.projectID} {...props} />
}
function ProjectArtifactsEditor({ request, projectID, editable, refresh, artifacts }: ArtifactsProps) {
  const action = useMutation(refresh)
  const [kind, setKind] = useState('skill')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [editing, setEditing] = useState<ProjectResourceArtifact | null>(null)
  const [remove, setRemove] = useState<ProjectResourceArtifact | null>(null)
  const reset = () => { setKind('skill'); setName(''); setVersion(''); setEditing(null); setRemove(null) }
  const path = (item: { kind: string; name: string }) => `/lumo/api/projects/${encodeURIComponent(projectID)}/artifacts/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.name)}`
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!editable || !name.trim() || !version.trim()) return
    if (await action.run(() => request(path({ kind, name: name.trim() }), { method: 'PUT', body: JSON.stringify({ version: version.trim(), expectedVersion: editing?.version ?? '' }) }), '制品引用已保存。')) { setEditing(null); setName(''); setVersion('') }
  }
  const detach = async (item: ProjectResourceArtifact) => {
    if (!editable || (remove?.kind !== item.kind || remove.name !== item.name)) return
    if (await action.run(() => request(path(item), { method: 'DELETE', body: JSON.stringify({ expectedVersion: remove.version }) }), '制品已从项目卸载，源制品保留。')) { setRemove(null); if (editing?.kind === item.kind && editing.name === item.name) reset() }
  }
  return <section className="lumo-cluster-panel" aria-label="项目制品管理"><h4>制品引用</h4><Feedback state={action} reset={reset} /><div className="lumo-cluster-list">{artifacts.map(item => <div key={`${item.kind}:${item.name}`}><span><b>{item.name}</b><small>{item.kind} · {item.version}</small></span>{editable ? <div className="lumo-form-actions"><button type="button" className={button} disabled={action.locked} aria-label={`更新制品 ${item.name}`} onClick={() => { setEditing(item); setKind(item.kind); setName(item.name); setVersion(item.version) }}>更新版本</button>{remove?.kind === item.kind && remove.name === item.name ? <><button type="button" className={`${button} lumo-danger`} disabled={action.locked} onClick={() => void detach(item)}>确认卸载制品</button><button type="button" className={button} onClick={() => setRemove(null)}>取消</button></> : <button type="button" className={`${button} lumo-danger`} disabled={action.locked} aria-label={`卸载制品 ${item.name}`} onClick={() => setRemove(item)}>卸载</button>}</div> : null}</div>)}</div>
    {!artifacts.length ? <p className="lumo-muted">还没有挂载制品。</p> : null}
    {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={save}><label>制品类型<select aria-label="制品类型" value={kind} disabled={action.locked || editing !== null} onChange={event => setKind(event.target.value)}>{['component', 'skill', 'agent', 'connector', 'flow'].map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>制品名称<input aria-label="制品名称" value={name} disabled={action.locked || editing !== null} onChange={event => setName(event.target.value)} required /></label><label>制品版本<input aria-label="制品版本" value={version} disabled={action.locked} onChange={event => setVersion(event.target.value)} required /></label><div className="lumo-form-actions"><button type="submit" className={button} disabled={action.locked || !name.trim() || !version.trim()}>{editing ? '更新制品引用' : '挂载制品'}</button>{editing ? <button type="button" className={button} disabled={action.locked} onClick={() => { setEditing(null); setName(''); setVersion('') }}>取消版本更新</button> : null}</div></form> : null}
  </section>
}
