import { Button, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { RemoteIcon, ActivityIcon, CloseIcon, FolderIcon, MembersIcon, SettingsIcon, SkillIcon } from './chat-icons.tsx'
import { AgentContextBrowser } from './agent-context-browser.tsx'
import { ConversationTools } from './conversation-tools.tsx'
import type { PromptContext } from '../../../acp-engines/src/prompt-context.ts'
import './agent-chat-dock.css'

export type ChatPanel = 'files' | 'skills' | 'tools' | 'members' | 'activity' | 'settings' | 'remote' | 'workflow' | null
export function AgentChatDock({ panel, onPanel, scopePath, cwd, context, setContext, disabled, members, activity, remote, workflow, settings, settingsLabel, pending = 0, running = false }: {
  panel: ChatPanel; onPanel(panel: ChatPanel): void; scopePath: string; cwd: string
  context: PromptContext; setContext(value: PromptContext): void; disabled: boolean
  members?: ReactNode; remote?: ReactNode; workflow?: ReactNode; activity: ReactNode; settings: ReactNode; settingsLabel: string; pending?: number; running?: boolean
}) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null), rail = useRef<HTMLElement>(null)
  const tabs = [
    { id: 'files' as const, label: '项目文件', Icon: FolderIcon, count: context.files?.length ?? 0 },
    { id: 'skills' as const, label: 'Skill', Icon: SkillIcon, count: context.skills?.length ?? 0 },
    { id: 'tools' as const, label: '共享工具', Icon: SharedToolsIcon, count: 0 },
    ...(members ? [{ id: 'members' as const, label: '群组成员', Icon: MembersIcon, count: 0 }] : []),
    ...(workflow ? [{ id: 'workflow' as const, label: '项目流程', Icon: WorkflowIcon, count: 0 }] : []),
    { id: 'activity' as const, label: '执行记录', Icon: ActivityIcon, count: pending },
    ...(remote ? [{id: 'remote' as const, label: '远程执行', Icon: RemoteIcon, count: 0}] : []),
    { id: 'settings' as const, label: settingsLabel, Icon: SettingsIcon, count: 0 },
  ]
  const current = tabs.find(tab => tab.id === panel)
  useEffect(() => { if (panel) heading.current?.focus() }, [panel])
  const close = () => {
    rail.current?.querySelector<HTMLButtonElement>(`[data-panel="${panel}"]`)?.focus()
    onPanel(null)
  }
  return <>
    {current ? <aside className="lumo-chat-dock-panel" id={`${id}-panel`} aria-label={current.label}
      onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close() } }}>
      <header className="lumo-native-content"><h3 ref={heading} tabIndex={-1}>{current.label}</h3><Button size="sm" type="button" className="lumo-dock-icon" aria-label="关闭侧栏" title="关闭 · Esc" onClick={close}><CloseIcon size={16} /></Button></header>
      <div className="lumo-chat-dock-content">
        {panel === 'files' || panel === 'skills' ? <AgentContextBrowser key={`${scopePath}:${panel}`} kind={panel} scopePath={scopePath} cwd={cwd} value={context} onChange={setContext} disabled={disabled} /> : panel === 'tools' ? <ConversationTools scopePath={scopePath} /> : panel === 'members' ? members : panel === 'activity' ? activity : panel === 'remote' ? remote : panel === 'workflow' ? workflow : settings}
      </div>
    </aside> : null}
    <nav className="lumo-chat-dock-rail lumo-native-content" ref={rail} aria-label="对话工具">
      {tabs.map(({ id: key, label, Icon, count }) => <Tooltip key={key} label={label} side="left" portal delayMs={350} focusDelayMs={350}><Button size="sm" type="button" data-panel={key} className="lumo-dock-icon"
        aria-label={label} aria-expanded={panel === key} aria-controls={panel === key ? `${id}-panel` : undefined}
        onClick={() => panel === key ? close() : onPanel(key)}>
        <Icon size={18} />{count ? <span className="lumo-dock-badge">{count}</span> : key === 'activity' && running ? <span className="lumo-dock-running" aria-label="执行中"><StateDot state="ongoing" size={10} /></span> : null}
      </Button></Tooltip>)}
    </nav>
  </>
}

function SharedToolsIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 3v4m6-4v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5M5 7h14" /></svg>
}

function WorkflowIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><path d="M6 8v8m0-4h12v4" /></svg>
}
