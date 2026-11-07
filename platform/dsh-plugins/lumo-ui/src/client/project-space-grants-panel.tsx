import { useCallback, useEffect, useRef, useState } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
type Permission = 'read' | 'edit' | 'comment' | 'publish'
interface Grant { user_id: string; permissions: Permission[]; revision: number }
export interface SpaceMember { userId: string; role?: string }
const permissions: { id: Permission; label: string }[] = [{ id: 'read', label: '读取' }, { id: 'edit', label: '编辑' }, { id: 'comment', label: '评论' }, { id: 'publish', label: '发布' }]

export function ProjectSpaceGrantsPanel({ request, projectID, spaceID, members, editable }: {
  request: Request; projectID: string; spaceID: string; members: SpaceMember[]; editable: boolean
}) {
  const [grants, setGrants] = useState<Grant[]>([])
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState<Permission[]>([])
  const [baseline, setBaseline] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(false)
  const pending = useRef(false)
  const sequence = useRef(0)
  const path = `/lumo/api/projects/${encodeURIComponent(projectID)}/spaces/${encodeURIComponent(spaceID)}/grants`
  const choose = (userID: string, values = grants) => {
    const grant = values.find(value => value.user_id === userID)
    setSelected(userID); setDraft(grant?.permissions ?? []); setBaseline(grant?.revision ?? 0); setConfirm(false); setNotice('')
  }
  const load = useCallback(async () => {
    if (pending.current) return
    const version = ++sequence.current
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await request<{ grants: Grant[] }>(path)
      if (version !== sequence.current) return
      if (!Array.isArray(result.grants)) throw new Error('空间授权响应无效，请重试。')
      setGrants(result.grants); setLoaded(true); setConflict(false)
      setSelected(''); setDraft([]); setBaseline(0); setConfirm(false); setNotice('')
    } catch (reason) { if (version === sequence.current) { setLoaded(false); setError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { pending.current = false; if (version === sequence.current) setBusy(false) }
  }, [path, request])
  useEffect(() => { pending.current = false; void load(); return () => { sequence.current++ } }, [load])
  const save = async (values: Permission[]) => {
    if (!editable || !loaded || !selected || conflict || pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    const version = sequence.current
    try {
      const saved = await request<Grant>(`${path}/${encodeURIComponent(selected)}`, { method: 'PUT', body: JSON.stringify({ permissions: values, expectedRevision: baseline }) })
      if (version !== sequence.current) return
      setGrants(current => [...current.filter(grant => grant.user_id !== saved.user_id), saved]); setDraft(saved.permissions); setBaseline(saved.revision); setConfirm(false)
      setNotice(saved.permissions.length ? '空间授权已保存。' : '空间授权已撤回。')
    } catch (reason) { if (version === sequence.current) { setError(reason instanceof Error ? reason.message : String(reason)); setConflict(reason instanceof Error && 'status' in reason && reason.status === 409) } }
    finally { pending.current = false; if (version === sequence.current) setBusy(false) }
  }
  const users = [...new Set([...members.map(member => member.userId), ...grants.map(grant => grant.user_id)])]
  return <section className="lumo-cluster-panel" aria-label="空间授权管理">
    <header className="lumo-section-title"><div><h4>空间访问权限</h4><p className="lumo-muted">选择项目成员，分别授予读取、编辑、评论与发布权限。</p></div><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy} onClick={() => void load()}>重新读取授权</button></header>
    {error ? <p role="alert" className="lumo-cluster-feedback error">{error}{conflict ? '；请重新读取授权后再编辑。' : ''}</p> : null}
    {notice ? <p role="status" className="lumo-cluster-feedback">{notice}</p> : null}
    {loaded ? <>
      <div className="lumo-cluster-list">{grants.filter(grant => grant.permissions.length).map(grant => <div key={grant.user_id}><span><b>{grant.user_id}</b><small>{permissions.filter(permission => grant.permissions.includes(permission.id)).map(permission => permission.label).join(' · ')}</small></span><span>v{grant.revision}</span></div>)}</div>
      {!grants.some(grant => grant.permissions.length) ? <p className="lumo-muted">尚未向成员授予此空间权限。</p> : null}
      {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={event => { event.preventDefault(); void save(draft) }}>
        <label>项目成员<select aria-label="空间授权成员" value={selected} disabled={busy || conflict} onChange={event => choose(event.target.value)}><option value="">选择成员</option>{users.map(userID => <option key={userID} value={userID}>{userID}{members.some(member => member.userId === userID) ? '' : '（已离开项目，仅可撤回）'}</option>)}</select></label>
        <fieldset disabled={busy || conflict || !selected}><legend>空间权限</legend>{permissions.map(permission => <label key={permission.id} className="lumo-cluster-checkbox"><input type="checkbox" aria-label={`空间${permission.label}`} checked={draft.includes(permission.id)} onChange={event => { setDraft(current => event.target.checked ? [...current, permission.id] : current.filter(value => value !== permission.id)); setConfirm(false) }} />{permission.label}</label>)}</fieldset>
        <div className="lumo-form-actions"><button type="submit" className="lumo-button lumo-secondary lumo-small" disabled={busy || conflict || !selected || !draft.length}>保存空间授权</button>{confirm ? <><button type="button" className="lumo-button lumo-danger lumo-small" disabled={busy || conflict} onClick={() => void save([])}>确认撤回授权</button><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy} onClick={() => setConfirm(false)}>取消撤回</button></> : <button type="button" className="lumo-button lumo-danger lumo-small" disabled={busy || conflict || !selected || baseline === 0} onClick={() => setConfirm(true)}>撤回全部权限</button>}</div>
      </form> : <p className="lumo-muted">项目已归档，恢复后可修改空间授权。</p>}
    </> : null}
  </section>
}
