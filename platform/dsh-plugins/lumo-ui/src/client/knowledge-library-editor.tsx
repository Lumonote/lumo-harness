import { useMemo, useRef, useState, type FormEvent } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface LibraryEditorFolder { folderId: string; name: string; parentId: string | null; revision?: number; canEdit?: boolean }
export interface LibraryEditorFile { docId: string; filename: string; folderId: string | null; revision?: number; canEdit?: boolean }
export type LibraryEditorResource = { type: 'file'; file: LibraryEditorFile } | { type: 'folder'; folder: LibraryEditorFolder }

function displayFolder(folder: LibraryEditorFolder, folders: LibraryEditorFolder[]): string {
  const parts = [folder.name]
  const visited = new Set([folder.folderId])
  let parent = folder.parentId
  while (parent !== null && !visited.has(parent)) {
    visited.add(parent)
    const ancestor = folders.find(item => item.folderId === parent)
    if (!ancestor) break
    parts.unshift(ancestor.name)
    parent = ancestor.parentId
  }
  return parts.join(' / ')
}

/** Parent should key by resource identity so switching files starts a fresh editor. */
export function KnowledgeLibraryEditor({ request, resource, folders, onSaved, onClose }: {
  request: Request; resource: LibraryEditorResource; folders: LibraryEditorFolder[]; onSaved: () => Promise<void>; onClose: () => void
}) {
  const initialName = resource.type === 'file' ? resource.file.filename : resource.folder.name
  const initialFolder = resource.type === 'file' ? resource.file.folderId : resource.folder.parentId
  const id = resource.type === 'file' ? resource.file.docId : resource.folder.folderId
  const revision = resource.type === 'file' ? resource.file.revision : resource.folder.revision
  const canEdit = resource.type === 'file' ? resource.file.canEdit : resource.folder.canEdit
  const [name, setName] = useState(initialName)
  const [folderId, setFolderId] = useState(initialFolder ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const pending = useRef(false)
  const blocked = useMemo(() => {
    const ids = new Set<string>()
    if (resource.type !== 'folder') return ids
    ids.add(resource.folder.folderId)
    let changed = true
    while (changed) {
      changed = false
      for (const folder of folders) if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.folderId)) {
        ids.add(folder.folderId); changed = true
      }
    }
    return ids
  }, [resource, folders])
  const targets = folders.filter(folder => folder.canEdit === true && !blocked.has(folder.folderId))
  const untouched = name.trim() === initialName && folderId === (initialFolder ?? '')
  const editable = canEdit === true && Number.isSafeInteger(revision) && (revision ?? 0) >= 1
  const refreshSaved = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await onSaved(); onClose() }
    catch (reason) { setError(`已保存，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { pending.current = false; setBusy(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editable || busy || pending.current || conflict || saved || untouched || !name.trim()) return
    pending.current = true; setBusy(true); setError('')
    const body = resource.type === 'file'
      ? { expectedRevision: revision, ...(name.trim() === initialName ? {} : { filename: name.trim() }), ...(folderId === (initialFolder ?? '') ? {} : { folderId: folderId || null }) }
      : { expectedRevision: revision, ...(name.trim() === initialName ? {} : { name: name.trim() }), ...(folderId === (initialFolder ?? '') ? {} : { parentId: folderId || null }) }
    try {
      await request(`/lumo/api/knowledge/library/${resource.type === 'file' ? 'files' : 'folders'}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
      setSaved(true)
      try { await onSaved(); onClose() }
      catch (reason) { setError(`已保存，刷新失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    } catch (reason) {
      const stale = reason instanceof Error && 'status' in reason && reason.status === 409
      setConflict(stale)
      setError(stale ? '资料已被其他人更新。请关闭此面板，刷新后重新编辑。' : reason instanceof Error ? reason.message : String(reason))
    } finally { pending.current = false; setBusy(false) }
  }
  return <section className="lumo-section lumo-cluster-panel" aria-label={resource.type === 'file' ? '整理文件' : '整理目录'}>
    <div className="lumo-section-title"><div><h3>{resource.type === 'file' ? '整理文件' : '整理目录'}</h3><p className="lumo-muted">修改名称或移动到可编辑的目录。移动后将继承目标目录的分享权限。</p></div><button className="lumo-button lumo-secondary" type="button" disabled={busy} onClick={onClose}>关闭</button></div>
    {!editable ? <p className="lumo-muted">当前资料不可编辑，或需要刷新以读取最新版本。</p> : <form className="lumo-governance-form lumo-cluster-form" onSubmit={submit}>
      <label>名称<input aria-label="资料名称" value={name} maxLength={240} disabled={busy || conflict || saved} onChange={event => setName(event.target.value)} required /></label>
      <label>位置<select aria-label="目标资料目录" value={folderId} disabled={busy || conflict || saved} onChange={event => setFolderId(event.target.value)}>
        <option value="">资料库根目录</option>
        {initialFolder !== null && !targets.some(folder => folder.folderId === initialFolder) ? <option value={initialFolder}>当前位置</option> : null}
        {targets.map(folder => <option key={folder.folderId} value={folder.folderId}>{displayFolder(folder, folders)}</option>)}
      </select></label>
      {resource.type === 'file' ? <p className="lumo-muted">重命名请保留原文件扩展名。</p> : null}
      <div className="lumo-form-actions"><button className="lumo-button" type="submit" disabled={busy || conflict || saved || untouched || !name.trim()}>{busy ? '处理中…' : '保存更改'}</button>{saved ? <button className="lumo-button lumo-secondary" type="button" disabled={busy} onClick={() => void refreshSaved()}>重新加载列表</button> : null}</div>
    </form>}
    {error ? <div className="lumo-cluster-feedback error" role="alert">{error}</div> : null}
    {saved ? <div className="lumo-cluster-feedback" role="status">更改已保存。</div> : null}
  </section>
}
