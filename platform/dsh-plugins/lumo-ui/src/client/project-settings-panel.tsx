import { useEffect, useRef, useState, type FormEvent } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ProjectSettingsProject { id: string; name: string; status: string }

interface Props {
  request: Request; project: ProjectSettingsProject; role: string; refresh: () => Promise<void>
}
export function ProjectSettingsPanel(props: Props) {
  return <ProjectSettingsEditor key={props.project.id} {...props} />
}
function ProjectSettingsEditor({ request, project, role, refresh }: Props) {
  const [name, setName] = useState(project.name)
  const [baseline, setBaseline] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [remoteName, setRemoteName] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const validProject = (value: ProjectSettingsProject | undefined): value is ProjectSettingsProject => Boolean(value && value.id === project.id && typeof value.name === 'string' && value.name.trim() && ['active', 'archived'].includes(value.status))
  const editable = project.status === 'active' && (role === 'owner' || role === 'editor')
  // Keep unsaved text when a remote update is received. The old baseline is
  // submitted as a precondition, so a stale draft cannot overwrite that update.
  useEffect(() => {
    setName(current => current === baseline ? project.name : current)
    if (name === baseline) setBaseline(project.name)
  }, [project.name])
  const reset = () => {
    setName(project.name); setBaseline(project.name); setRemoteName(null); setConflict(false); setError(''); setNotice('')
  }
  const discardDraft = () => {
    if (remoteName === null) reset()
    else { setName(remoteName); setNotice('已取消草稿修改。') }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editable || conflict || pending.current || !name.trim() || name.trim() === baseline) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const saved = await request<ProjectSettingsProject>(`/lumo/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH', body: JSON.stringify({ name: name.trim(), expectedName: baseline }),
      })
      if (!mounted.current) return
      if (!validProject(saved)) { setConflict(true); throw Error('项目保存响应无效，请读取最新名称后核对。') }
      setName(saved.name); setBaseline(saved.name); setRemoteName(null); setNotice('项目名称已保存。')
      try { await refresh() } catch (reason) { if (mounted.current) setError(`已保存，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    } catch (reason) {
      if (!mounted.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      const stale = reason instanceof Error && 'status' in reason && reason.status === 409
      if (stale) setConflict(true)
      setError(stale ? `保存冲突：${message}。草稿已保留，请读取最新名称并核对后再保存。` : message)
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const reload = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const snapshot = await request<{ project: ProjectSettingsProject }>(`/lumo/api/projects/${encodeURIComponent(project.id)}`)
      if (!mounted.current) return
      if (!validProject(snapshot?.project)) throw Error('项目名称响应无效，请重试。')
      setBaseline(snapshot.project.name); setRemoteName(snapshot.project.name); setConflict(false); setNotice('已读取最新名称，草稿仍保留。请核对后保存，或采用已保存的名称。')
      try { await refresh() } catch (reason) { if (mounted.current) setError(`名称已读取，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="lumo-section lumo-cluster-panel" aria-label="项目设置">
    <div className="lumo-section-title"><div><h3>项目设置</h3><p className="lumo-muted">为团队设置清晰的项目名称。</p></div><span className="lumo-pill">{project.status === 'archived' ? '已归档' : '进行中'}</span></div>
    {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={submit}>
      <label>项目名称<input aria-label="项目名称" value={name} maxLength={120} disabled={busy} onChange={event => { setName(event.target.value); setNotice('') }} required /></label>
      {remoteName !== null ? <p className="lumo-settings-comparison">当前已保存：<strong>{remoteName}</strong><button className="lumo-button lumo-secondary lumo-small" type="button" disabled={busy} onClick={() => { setName(remoteName); setNotice('已采用当前保存的名称。') }}>采用已保存的名称</button></p> : null}
      <div className="lumo-form-actions"><button className="lumo-button" type="submit" disabled={busy || conflict || !name.trim() || name.trim() === baseline}>{busy ? '处理中…' : '保存名称'}</button><button className="lumo-button lumo-secondary" type="button" disabled={busy || conflict || name === (remoteName ?? project.name)} onClick={discardDraft}>取消修改</button>{conflict ? <button className="lumo-button lumo-secondary" type="button" disabled={busy} onClick={() => void reload()}>读取最新名称（保留草稿）</button> : null}</div>
    </form> : <p className="lumo-muted">{project.status === 'archived' ? '项目已归档，恢复后可编辑项目内容。' : '当前角色可查看项目设置，编辑需 owner 或 editor 权限。'}</p>}
    {error ? <div className="lumo-cluster-feedback error" role="alert">{error}</div> : null}
    {notice ? <div className="lumo-cluster-feedback" role="status">{notice}</div> : null}
  </section>
}
