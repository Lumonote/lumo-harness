import { ChatButton } from './chat-button.tsx'
import type { AskView } from './acp-session-state.ts'
import { ShieldIcon } from './chat-icons.tsx'
import './agent-permission-request.css'

function permissionPreview(detail?: string): { path?: string; command?: string } {
  if (!detail) return {}
  try {
    const value: unknown = JSON.parse(detail)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const input = value as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : undefined
    const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) && input.command.every(part => typeof part === 'string') ? JSON.stringify(input.command) : undefined
    return { ...(path ? { path } : {}), ...(command ? { command } : {}) }
  } catch { return {} }
}

function optionLabel(option: NonNullable<AskView['options']>[number]): string {
  // Translate only known native labels; never infer permission scope from an ID.
  if (option.permissionKind === 'allow_once' && option.label === 'Yes') return '允许一次'
  if (option.permissionKind === 'reject_once' && option.label === 'No') return '拒绝'
  if (option.permissionKind === 'allow_always' && option.label === 'Yes, allow all edits during this session') return '本会话允许编辑'
  return option.label
}

export function AgentPermissionRequest({ ask, member, disabled, answer }: {
  ask: AskView; member?: string | undefined; disabled: boolean; answer(id: string): void
}) {
  const marker = ask.title.indexOf(' 请求权限：')
  const source = member ?? (marker > 0 ? ask.title.slice(0, marker) : '')
  const title = marker > 0 ? ask.title.slice(marker + ' 请求权限：'.length) : ask.title
  const preview = permissionPreview(ask.detail)
  return <article className="lumo-permission-request" aria-label={ask.title}>
    <header><ShieldIcon size={16} /><strong>{title}</strong><span>等待授权</span></header>
    {source ? <small className="lumo-permission-source">{source}</small> : null}
    {preview.path ? <code className="lumo-permission-target">{preview.path}</code> : null}
    {preview.command ? <pre className="lumo-permission-command" aria-label="待执行命令">{preview.command}</pre> : null}
    {ask.detail ? <details className="lumo-permission-details"><summary>查看操作详情</summary><pre>{ask.detail}</pre></details> : null}
    <div className="lumo-permission-actions">{ask.options?.map(option => <ChatButton variant={option.permissionKind === 'allow_once' ? 'primary' : 'outline'} key={option.id} disabled={disabled} data-permission-kind={option.permissionKind} title={option.label} onClick={() => answer(option.id)}>{optionLabel(option)}</ChatButton>)}</div>
  </article>
}
