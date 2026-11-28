import { AddIcon, CloseIcon, FileTypeIcon } from './chat-icons.tsx'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { ATTACHMENT_LIMITS, type ChatAttachment } from '../../../acp-engines/src/chat-attachments.ts'
import { cachedAttachments, readAttachments, saveAttachments } from './conversation-drafts.ts'
import { acpCall } from './acp-session-state.ts'

interface Draft { key: string; file: File; preview?: string; uploaded?: ChatAttachment }
const imageType = (type: string) => /^image\/(png|jpeg|gif|webp)$/u.test(type)
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const base64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.readAsDataURL(file)
})
export function useChatAttachments(context: string) {
  const [files, setFiles] = useState<Draft[]>([]), [error, setError] = useState(''), [sending, setSending] = useState(false)
  const drafts = useRef(files), generation = useRef(0), operation = useRef<AbortController>()
  const replace = (next: Draft[], persist = true) => { drafts.current = next; setFiles(next); if (persist) void saveAttachments(context, next).catch(() => { if (next.length && drafts.current === next) setError('附件草稿仅保留在当前窗口，刷新后可能丢失。') }) }
  const remove = (key: string) => {
    const file = drafts.current.find(f => f.key === key); if (file?.preview) URL.revokeObjectURL(file.preview)
    replace(drafts.current.filter(f => f.key !== key)); setError('')
  }
  useEffect(() => {
    const epoch = ++generation.current; operation.current?.abort(); operation.current = undefined
    const restore = (saved: Draft[]) => saved.map(f => ({ ...f, ...(imageType(f.file.type) && typeof URL.createObjectURL === 'function' ? { preview: URL.createObjectURL(f.file) } : {}) }))
    drafts.current.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview) })
    const cached = cachedAttachments(context)
    replace(restore(cached ?? []), false); setError(''); setSending(false)
    const initial = drafts.current
    if (!cached) void readAttachments(context).then(saved => {
      if (generation.current === epoch && drafts.current === initial) replace(restore(saved), false)
    }).catch(() => { /* Persistence errors are shown when adding a draft, not for an empty composer. */ })
    return () => { ++generation.current; operation.current?.abort(); operation.current = undefined; drafts.current.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview) }) }
  }, [context])
  const add = (incoming: File[]) => {
    if (operation.current) return
    const next = [...drafts.current]; let problem = ''
    for (const file of incoming) {
      if (next.some(f => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified)) continue
      if (file.size > ATTACHMENT_LIMITS.fileBytes) { problem = `${file.name} 超过 8 MB`; continue }
      if (next.length >= ATTACHMENT_LIMITS.count || next.reduce((sum, f) => sum + f.file.size, file.size) > ATTACHMENT_LIMITS.totalBytes) { problem = '每条消息最多 4 个附件，总大小不超过 16 MB'; break }
      next.push({ key: crypto.randomUUID(), file, ...(imageType(file.type) && typeof URL.createObjectURL === 'function' ? { preview: URL.createObjectURL(file) } : {}) })
    }
    replace(next); setError(problem)
  }
  const sendWith = async (send: (attachments: ChatAttachment[]) => Promise<boolean | undefined>) => {
    if (operation.current) return
    const epoch = generation.current, snapshot = [...drafts.current], controller = new AbortController()
    operation.current = controller; setSending(true); setError('')
    try {
      const attachments: ChatAttachment[] = []
      for (const draft of snapshot) {
        // Verify cached uploads: an unsent draft may outlast the server's grace period.
        if (draft.uploaded) {
          const existing = await fetch(`/lumo/api/acp/attachments/${draft.uploaded.id}`, { credentials: 'same-origin', signal: controller.signal })
          if (existing.status === 404) delete draft.uploaded
          else if (!existing.ok) throw new Error(`附件暂不可用：${draft.file.name}（HTTP ${existing.status}）`)
          else { try { await existing.body?.cancel() } catch { /* Headers already confirmed availability. */ } }
        }
        if (!draft.uploaded) {
          const data = await base64(draft.file)
          if (controller.signal.aborted) return
          const result = await acpCall<{ attachment: ChatAttachment }>('/lumo/api/acp/attachments', { method: 'POST', signal: controller.signal, body: JSON.stringify({ name: draft.file.name, mimeType: draft.file.type || 'application/octet-stream', data }) })
          draft.uploaded = result.attachment
          if (generation.current === epoch) void saveAttachments(context, drafts.current).catch(() => undefined)
        }
        attachments.push(draft.uploaded)
      }
      if (generation.current !== epoch) return
      if (await send(attachments) && generation.current === epoch) snapshot.forEach(f => remove(f.key))
    } catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : '附件发送失败，请重试') }
    finally { if (operation.current === controller) { operation.current = undefined; setSending(false) } }
  }
  const drop = (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); add(Array.from(event.dataTransfer.files)) } }
  const paste = (event: ClipboardEvent) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); add(files) } }
  return { files, error, sending, add, remove, sendWith, drop, paste }
}
export function AttachmentComposer({ draft, disabled }: { draft: ReturnType<typeof useChatAttachments>; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="lumo-chat-attachments">
    <input ref={input} type="file" multiple hidden aria-label="选择附件" disabled={disabled || draft.sending} onChange={e => { draft.add(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    <button type="button" className="lumo-chat-icon-button" aria-label="添加附件" title="添加附件 · 可拖入文件或粘贴图片，单个最多 8 MB" disabled={disabled || draft.sending} onClick={() => input.current?.click()}><AddIcon size={20} /></button>
  </div>
}
export function AttachmentCards({ draft }: { draft: ReturnType<typeof useChatAttachments> }) {
  return <><div className="lumo-chat-file-list">{draft.files.map(f => <div className="lumo-chat-file" key={f.key}>{f.preview ? <img src={f.preview} alt="" /> : <FileTypeIcon path={f.file.name} size={22} />}<span title={f.file.name}><b>{f.file.name}</b><small>{size(f.file.size)}</small></span><button type="button" disabled={draft.sending} aria-label={`移除附件 ${f.file.name}`} onClick={() => draft.remove(f.key)}><CloseIcon size={14} /></button></div>)}</div>{draft.error ? <small role="alert">{draft.error}</small> : null}</>
}
export function MessageAttachments({ files }: { files?: ChatAttachment[] | undefined }) {
  return files?.length ? <div className="lumo-chat-file-list lumo-chat-sent-files">{files.map(f => <a className="lumo-chat-file" key={f.id} href={`/lumo/api/acp/attachments/${f.id}`} target="_blank" rel="noreferrer" download={f.name}>
    {imageType(f.mimeType) ? <img src={`/lumo/api/acp/attachments/${f.id}`} alt={f.name} /> : <FileTypeIcon path={f.name} size={22} />}<span title={f.name}><b>{f.name}</b><small>{size(f.size)}</small></span>
  </a>)}</div> : null
}
