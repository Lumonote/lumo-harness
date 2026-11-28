import { CheckIcon, EditIcon, FolderIcon } from './chat-icons.tsx'
import { useEffect, useId, useRef, useState } from 'react'

interface Workspace { workspaceId: string; title?: string; path?: string }
export interface AgentProjectServices {
  workspaces: { list: { getSnapshot(): { items: readonly Workspace[] }; subscribe?(listener: () => void): () => void } }
  uiWorkspace: { pickDirectory(): Promise<string | null> }
}
let services: AgentProjectServices | undefined
const listeners = new Set<() => void>()
export function installAgentProjectServices(value: AgentProjectServices) {
  if (!value?.workspaces?.list?.getSnapshot || typeof value.uiWorkspace?.pickDirectory !== 'function') return () => {}
  services = value; listeners.forEach(fn => fn())
  return () => { if (services === value) { services = undefined; listeners.forEach(fn => fn()) } }
}
export function AgentProjectPicker({ value, onChange, recent = [], disabled = false, label = '工作区目录' }: {
  value: string; onChange(value: string): void; recent?: string[]; disabled?: boolean; label?: string
}) {
  const [, refresh] = useState(0), [picking, setPicking] = useState(false), [error, setError] = useState('')
  const current = useRef({ value, disabled, onChange }); current.current = { value, disabled, onChange }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { const update = () => refresh(n => n + 1); listeners.add(update); return () => { listeners.delete(update) } }, [])
  const source = services
  useEffect(() => source?.workspaces.list.subscribe?.(() => refresh(n => n + 1)), [source])
  const projects = new Map<string, string>()
  for (const w of source?.workspaces.list.getSnapshot().items ?? []) if (w.path) projects.set(w.path, w.title || w.path.split(/[\\/]/u).filter(Boolean).at(-1) || w.path)
  for (const path of [...recent, value]) if (path && !projects.has(path)) projects.set(path, path.split(/[\\/]/u).filter(Boolean).at(-1) || path)
  const [editing, setEditing] = useState(!projects.size)
  const fieldId = useId(), input = useRef<HTMLInputElement>(null), beforeEdit = useRef(value)
  useEffect(() => { if (editing) input.current?.focus() }, [editing])
  const pick = async () => {
    if (!source || picking || disabled) return
    const before = value; setPicking(true); setError('')
    try {
      const path = await source.uiWorkspace.pickDirectory()
      if (mounted.current && !current.current.disabled && current.current.value === before && path) { current.current.onChange(path); setEditing(false) }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '文件夹选择失败') }
    finally { if (mounted.current) setPicking(false) }
  }
  return <div className="lumo-agent-project-picker">
    <label htmlFor={fieldId}>项目文件夹</label>
    <div>{editing ? <input id={fieldId} ref={input} aria-label={label} title={value} value={value} disabled={disabled || picking} maxLength={4096} placeholder="项目文件夹绝对路径" onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter' && value.trim()) { e.preventDefault(); setEditing(false) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onChange(beforeEdit.current); setEditing(false) } }} />
      : <select id={fieldId} aria-label="选择项目" title={value} value={value} disabled={disabled || picking} onChange={e => { onChange(e.target.value); if (!e.target.value) { beforeEdit.current = value; setEditing(true) } }}>
        <option value="">选择项目或输入目录</option>{[...projects].map(([path, title]) => <option key={path} value={path}>{title}</option>)}
      </select>}
      <button type="button" className="lumo-chat-icon-button" aria-label={editing ? '完成路径编辑' : '编辑项目路径'} title={editing ? '完成路径编辑 · Enter' : '编辑项目路径'} disabled={disabled || picking || (editing && !value.trim())} onClick={() => { beforeEdit.current = value; setEditing(!editing) }}>{editing ? <CheckIcon size={16} /> : <EditIcon size={16} />}</button>
      {source ? <button type="button" className="lumo-chat-icon-button" aria-label="选择文件夹" title={picking ? '正在选择…' : '选择文件夹'} disabled={disabled || picking} onClick={() => void pick()}><FolderIcon size={18} /></button> : null}</div>
    {error ? <small role="alert">{error}</small> : null}
  </div>
}
