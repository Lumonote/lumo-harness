import { ChatButton } from './chat-button.tsx'
import { useEffect, useState, type ReactNode } from 'react'
import { acpCall } from './acp-session-state.ts'
import { CheckIcon, PinIcon, PinnedIcon, ArchiveIcon, UnarchiveIcon, DownloadIcon, TrashIcon } from './chat-icons.tsx'
import './conversation-details.css'
export function ConversationSettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="lumo-settings-section" aria-label={title}><h4>{title}</h4>{children}</section>
}
export function ConversationManagement({ scopePath, title, archived, pinned, disabled, nameField = 'title', save, remove }: {
  scopePath: string; title: string; archived?: boolean | undefined; pinned?: boolean | undefined; disabled: boolean; nameField?: 'title' | 'name'
  save(value: {title?: string; name?: string; archived?: boolean; pinned?: boolean}): void; remove(): void
}) {
  const [name, setName] = useState(title), [deleting, setDeleting] = useState(false)
  useEffect(() => { setName(title); setDeleting(false) }, [scopePath, title])
  return <section className="lumo-conversation-management" aria-label="聊天记录管理">
    <label>对话名称<input aria-label="对话名称" title={name} value={name} disabled={disabled} maxLength={120} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !disabled && name.trim() && name.trim() !== title) { e.preventDefault(); save({ [nameField]: name.trim() }) } }} /></label>
    <div className="lumo-conversation-management-actions">
      <ChatButton type="button" variant="ghost" className="lumo-settings-icon" aria-label="重命名" title="保存名称 · Enter" disabled={disabled || !name.trim() || name.trim() === title} onClick={() => save({ [nameField]: name.trim() })}><CheckIcon size={16} /></ChatButton>
      <ChatButton type="button" variant="ghost" className="lumo-settings-icon" aria-label={pinned ? '取消置顶' : '置顶'} title={pinned ? '取消置顶' : '置顶'} aria-pressed={!!pinned} disabled={disabled} onClick={() => save({ pinned: !pinned })}>{pinned ? <PinnedIcon size={16} /> : <PinIcon size={16} />}</ChatButton>
      <ChatButton type="button" variant="ghost" className="lumo-settings-icon" aria-label={archived ? '恢复到对话列表' : '归档'} title={archived ? '恢复到对话列表' : '归档'} disabled={disabled} onClick={() => save({ archived: !archived })}>{archived ? <UnarchiveIcon size={16} /> : <ArchiveIcon size={16} />}</ChatButton>
      <a className="lumo-settings-icon" aria-label="导出记录" title="导出记录" href={`${scopePath}/export`} download><DownloadIcon size={16} /></a>
      <ChatButton type="button" variant="ghost" className="lumo-settings-icon lumo-settings-delete" aria-label="删除" title="删除对话" aria-expanded={deleting} disabled={disabled} onClick={() => setDeleting(!deleting)}><TrashIcon size={16} /></ChatButton></div>
    {deleting ? <div className="lumo-settings-confirm" role="group" aria-label="确认删除记录"><p>删除后无法恢复此对话记录。</p><div className="lumo-settings-actions"><ChatButton type="button" className="lumo-settings-delete" disabled={disabled} onClick={remove}>确认删除对话记录</ChatButton><ChatButton type="button" onClick={() => setDeleting(false)}>取消</ChatButton></div></div> : null}
  </section>
}
interface StorageStats { usedBytes: number; limitBytes: number; referencedBytes: number; reclaimableBytes: number; files: number }
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`
export function AttachmentStorage() {
  const [open, setOpen] = useState(false), [stats, setStats] = useState<StorageStats>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const read = async () => { try { const result = await acpCall<StorageStats>('/lumo/api/acp/attachments/stats'); setStats(result); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  const clean = async () => { setBusy(true); try { await acpCall('/lumo/api/acp/attachments/cleanup', { method: 'POST', body: '{}' }); await read() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  return <details className="lumo-settings-storage" open={open} onToggle={e => { const next = e.currentTarget.open; setOpen(next); if (next && !stats) void read() }}><summary>附件存储</summary>{stats ? <><p>{bytes(stats.usedBytes)} / {bytes(stats.limitBytes)} · {stats.files} 个附件</p><small>可清理 {bytes(stats.reclaimableBytes)}，对话引用 {bytes(stats.referencedBytes)}</small><ChatButton type="button" disabled={busy || !stats.reclaimableBytes} onClick={() => void clean()}>{busy ? '清理中…' : '清理过期未引用附件'}</ChatButton></> : null}{error ? <p role="alert">{error}</p> : null}</details>
}
