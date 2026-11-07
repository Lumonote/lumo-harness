import { useEffect, useRef, useState, type FormEvent } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ProjectSettingsProject { id: string; name: string; status: string }

export function ProjectSettingsPanel({ request, project, role, refresh }: {
  request: Request; project: ProjectSettingsProject; role: string; refresh: () => Promise<void>
}) {
  const [name, setName] = useState(project.name)
  const [baseline, setBaseline] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const pending = useRef(false)
  const editable = project.status === 'active' && (role === 'owner' || role === 'editor')
  // Keep unsaved text when a remote update is received. The old baseline is
  // submitted as a precondition, so a stale draft cannot overwrite that update.
  useEffect(() => {
    setName(current => current === baseline ? project.name : current)
    if (name === baseline) setBaseline(project.name)
  }, [project.name])
  const reset = () => {
    setName(project.name); setBaseline(project.name); setConflict(false); setError(''); setNotice('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editable || conflict || pending.current || !name.trim() || name.trim() === baseline) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const saved = await request<ProjectSettingsProject>(`/lumo/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH', body: JSON.stringify({ name: name.trim(), expectedName: baseline }),
      })
      setName(saved.name); setBaseline(saved.name); setNotice('项目名称已保存。')
      try { await refresh() } catch (reason) { setError(`已保存，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const stale = reason instanceof Error && 'status' in reason && reason.status === 409
      setConflict(stale)
      setError(stale ? `保存冲突：${message}。请重新读取当前名称后再编辑。` : message)
    } finally { pending.current = false; setBusy(false) }
  }
  const reload = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const snapshot = await request<{ project: ProjectSettingsProject }>(`/lumo/api/projects/${encodeURIComponent(project.id)}`)
      setName(snapshot.project.name); setBaseline(snapshot.project.name); setConflict(false); setNotice('已读取当前项目名称。')
      try { await refresh() } catch (reason) { setError(`名称已读取，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className="lumo-section lumo-cluster-panel" aria-label="项目设置">
    <div className="lumo-section-title"><div><h3>项目设置</h3><p className="lumo-muted">为团队设置清晰的项目名称。</p></div><span className="lumo-pill">{project.status === 'archived' ? '已归档' : '进行中'}</span></div>
    {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={submit}>
      <label>项目名称<input aria-label="项目名称" value={name} maxLength={120} disabled={busy} onChange={event => { setName(event.target.value); setNotice('') }} required /></label>
      <div className="lumo-form-actions"><button className="lumo-button" type="submit" disabled={busy || conflict || !name.trim() || name.trim() === baseline}>{busy ? '处理中…' : '保存名称'}</button><button className="lumo-button lumo-secondary" type="button" disabled={busy || conflict || name === project.name} onClick={reset}>取消修改</button>{conflict ? <button className="lumo-button lumo-secondary" type="button" disabled={busy} onClick={() => void reload()}>重新读取名称</button> : null}</div>
    </form> : <p className="lumo-muted">{project.status === 'archived' ? '项目已归档，恢复后可编辑项目内容。' : '当前角色可查看项目设置，编辑需 owner 或 editor 权限。'}</p>}
    {error ? <div className="lumo-cluster-feedback error" role="alert">{error}</div> : null}
    {notice ? <div className="lumo-cluster-feedback" role="status">{notice}</div> : null}
  </section>
}
