import { useState } from 'react'
import type { HistoryEntry } from './agent-chat-history.tsx'
import { ChatButton } from './chat-button.tsx'

export function ConversationHistoryMenu({ entry, disabled, manage }: {
  entry: HistoryEntry; disabled: boolean
  manage(entry: HistoryEntry, change: { title?: string; archived?: boolean; pinned?: boolean }): Promise<void>
}) {
  const [open, setOpen] = useState(false), [editing, setEditing] = useState(false), [title, setTitle] = useState(entry.name)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const metadata = entry.native ?? entry.session ?? entry.room
  const save = async (change: { title?: string; archived?: boolean; pinned?: boolean }) => {
    if (busy || disabled) return
    setBusy(true); setError('')
    try { await manage(entry, change); setOpen(false); setEditing(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className="lumo-history-menu">
    <ChatButton type="button" variant="ghost" className="lumo-chat-icon-button" aria-label={`管理 ${entry.name}`} title="管理对话" aria-expanded={open} onClick={() => { setOpen(!open); setTitle(entry.name); setError('') }}>⋯</ChatButton>
    {open ? <div className="lumo-history-popover" role="group" aria-label={`${entry.name} 的操作`} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation() } }}>
      {editing ? <form onSubmit={event => { event.preventDefault(); if (title.trim()) void save({ title: title.trim() }) }}><input aria-label="对话名称" value={title} autoFocus maxLength={120} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} /><ChatButton type="submit" disabled={disabled || busy || !title.trim()}>保存</ChatButton></form>
        : <ChatButton type="button" variant="ghost" disabled={disabled || busy} onClick={() => setEditing(true)}>重命名</ChatButton>}
      <ChatButton type="button" variant="ghost" disabled={disabled || busy} onClick={() => void save({ pinned: !metadata?.pinned })}>{metadata?.pinned ? '取消置顶' : '置顶'}</ChatButton>
      <ChatButton type="button" variant="ghost" disabled={disabled || busy} onClick={() => void save({ archived: !metadata?.archived })}>{metadata?.archived ? '恢复到对话列表' : '归档'}</ChatButton>
      <ChatButton type="button" variant="ghost" onClick={() => setOpen(false)}>关闭</ChatButton>{error ? <small role="alert">{error}</small> : null}
    </div> : null}
  </div>
}
