import type { ComponentProps, ReactNode } from 'react'
import { AgentComposerInput } from './agent-composer-input.tsx'
import { AttachmentCards, AttachmentComposer, type useChatAttachments } from './chat-attachments.tsx'
import { ChatButton } from './chat-button.tsx'
import { FolderIcon, SendIcon, StopIcon } from './chat-icons.tsx'
import type { ChatPanel } from './agent-chat-dock.tsx'

export const chatCommands = (panel: (panel: ChatPanel) => void) => [
  { name: 'project', label: '选择项目', run: () => panel('settings') },
  { name: 'settings', label: '会话设置', run: () => panel('settings') },
  { name: 'files', label: '项目文件', run: () => panel('files') },
  { name: 'skills', label: '加载 Skill', run: () => panel('skills') },
  { name: 'tools', label: '共享工具与权限', run: () => panel('tools') },
  { name: 'activity', label: '执行记录', run: () => panel('activity') },
  { name: 'remote', label: '远程执行', run: () => panel('remote') },
]

/** A single submission, attachment and keyboard surface for external engines and groups. */
export function ChatComposer({ attachments, busy, running, cwd, project, stop, controls, sendLabel = '发送', stopLabel = '停止', ...input }: Omit<ComponentProps<typeof AgentComposerInput>, 'disabled'> & {
  attachments: ReturnType<typeof useChatAttachments>; busy: boolean; running: boolean; cwd: string
  project(): void; stop(): void; controls?: ReactNode; sendLabel?: string; stopLabel?: string
}) {
  const disabled = busy || running || attachments.sending
  const empty = !input.value.trim() && !attachments.files.length && !input.context.files?.length && !input.context.skills?.length
  const send = () => { if (!disabled && !empty) input.send() }
  return <form className="lumo-chat-composer" onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDrop={event => { if (disabled) event.preventDefault(); else attachments.drop(event) }} onPaste={event => { if (!disabled) attachments.paste(event) }}
    onSubmit={event => { event.preventDefault(); send() }}>
    <AttachmentCards draft={attachments} />
    <AgentComposerInput {...input} disabled={disabled} send={send} />
    <div className="lumo-chat-compose-actions"><AttachmentComposer draft={attachments} disabled={disabled} />{controls}
      <ChatButton type="button" variant="ghost" className="lumo-chat-project-chip" title={cwd} aria-label="选择项目文件夹" onClick={project}><FolderIcon size={14} />{cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd}</ChatButton>
      {running ? <ChatButton type="button" variant="ghost" className="lumo-chat-icon-button" aria-label={stopLabel} title={stopLabel} disabled={busy} onClick={stop}><StopIcon size={18} /></ChatButton>
        : <ChatButton type="submit" className="lumo-chat-send lumo-chat-icon-button" aria-label={sendLabel} title="发送 · Enter" disabled={disabled || empty}><SendIcon size={18} /></ChatButton>}
    </div>
  </form>
}
