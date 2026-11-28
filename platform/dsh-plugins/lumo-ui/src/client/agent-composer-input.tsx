import { MenuSurface, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useConversationDraft } from './conversation-drafts.ts'
import { acpCall } from './acp-session-state.ts'
import { CloseIcon, FileTypeIcon, FolderIcon, SkillIcon } from './chat-icons.tsx'
import { EngineLogo } from './engine-logo.tsx'
import type { AgentSkill, PromptContext } from '../../../acp-engines/src/prompt-context.ts'

export function usePromptContext(key: string) {
  const [value, set, error] = useConversationDraft<PromptContext>(key, 'context', {})
  const clear = (snapshot: PromptContext) => set(current => ({
    skills: current.skills?.filter(s => !snapshot.skills?.includes(s)) ?? [],
    files: current.files?.filter(f => !snapshot.files?.includes(f)) ?? [],
  }))
  return { value, set, clear, error, has: !!(value.skills?.length || value.files?.length) }
}
export function PromptContextChips({ value, remove }: { value: PromptContext; remove?(kind: 'skills' | 'files', name: string): void }) {
  return <div className="lumo-chat-context-chips">{(['skills', 'files'] as const).flatMap(kind => (value[kind] ?? []).map(name => <span className="lumo-chat-context-chip" key={`${kind}:${name}`} title={name}>
    {kind === 'skills' ? <SkillIcon size={14} /> : <FileTypeIcon path={name} size={14} />}<span>{name}</span>
    {remove ? <button type="button" className="lumo-chat-icon-button" aria-label={`移除${kind === 'skills' ? ' Skill' : '文件引用'} ${name}`} title="移除" onClick={() => remove(kind, name)}><CloseIcon size={12} /></button> : null}
  </span>))}</div>
}
interface Member { id: string; name: string; engineId: string }
interface Command { name: string; label: string; run(): void }
interface ProjectFile { path: string; name: string; directory: boolean }
interface Candidate { id: string; label: string; description: string; kind: 'command' | 'skill' | 'member' | 'file' | 'folder'; member?: Member; pick(): void }
export function AgentComposerInput({ value, onChange, label, inputRef, maxLength, disabled, scopePath, context, setContext, members = [], mention, commands, engineCommands = [], send }: {
  value: string; onChange(value: string): void; label: string; inputRef?: RefObject<HTMLTextAreaElement>; maxLength?: number; disabled: boolean
  scopePath: string; context: PromptContext; setContext(value: PromptContext): void; members?: Member[]; mention?(id: string): void; commands: Command[]; engineCommands?: Array<{ name: string; description: string; input?: { hint: string } }> | undefined; send(): void
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null), textarea = inputRef ?? ownRef, menu = useRef<HTMLDivElement>(null), id = useId()
  const pendingSelection = useRef<{ value: string; position: number; scopePath: string }>()
  const [caret, setCaret] = useState(value.length), [index, setIndex] = useState(0), [dismissed, dismiss] = useState('')
  const [skills, setSkills] = useState<AgentSkill[]>([]), [files, setFiles] = useState<ProjectFile[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const before = value.slice(0, caret), match = /(?:^|\s)([/@])([^\s]*)$/u.exec(before)
  const trigger = match?.[1], query = match?.[2] ?? '', start = match ? caret - query.length - 1 : caret
  const signature = `${scopePath}:${value}:${caret}`, open = !!trigger && !disabled && signature !== dismissed
  const maxHeight = useAnchoredMaxHeight(menu, 300, `${signature}:${loading}`, 84)
  useLayoutEffect(() => {
    const field = textarea.current, selection = pendingSelection.current
    pendingSelection.current = undefined
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 144)}px`
    if (selection?.value === value && selection.scopePath === scopePath) {
      field.focus(); field.setSelectionRange(selection.position, selection.position); setCaret(selection.position)
    }
  }, [value, scopePath, textarea])
  useEffect(() => {
    setIndex(0); setError(''); setFiles([]); setSkills([])
    if (!open) return
    const controller = new AbortController(); setLoading(true)
    const path = trigger === '/' ? `${scopePath}/skills` : `${scopePath}/files?query=${encodeURIComponent(query)}`
    acpCall<{ skills?: AgentSkill[]; files?: ProjectFile[]; complete?: boolean }>(path, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      if (trigger === '/') { setSkills(result.skills ?? []); if (result.complete === false) setError('Skill 目录仍在加载，可刷新重试') }
      else setFiles(result.files ?? [])
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '目录加载失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, trigger, trigger === '@' ? query : '', scopePath, retry])
  const replace = (text: string) => {
    const next = value.slice(0, start) + text + value.slice(caret), position = start + text.length
    pendingSelection.current = { value: next, position, scopePath }
    onChange(next); setCaret(position)
  }
  const add = (kind: 'skills' | 'files', name: string) => {
    const selected = context[kind] ?? [], max = kind === 'skills' ? 4 : 8
    if (!selected.includes(name) && selected.length >= max) { setError(`最多选择 ${max} 个${kind === 'skills' ? ' Skill' : '文件'}`); return }
    setContext({ ...context, [kind]: [...new Set([...selected, name])] }); replace(''); dismiss(signature)
  }
  const needle = query.toLowerCase()
  const options: Candidate[] = trigger === '/' ? [
    ...commands.filter(c => `${c.name} ${c.label}`.toLowerCase().includes(needle)).map(c => ({ id: `command:${c.name}`, label: `/${c.name}`, description: c.label, kind: 'command' as const, pick: () => { replace(''); c.run() } })),
    ...engineCommands.filter(c => `${c.name} ${c.description}`.toLowerCase().includes(needle)).map(c => ({ id: `engine:${c.name}`, label: `/${c.name}`, description: `${c.description}${c.input?.hint ? ` · ${c.input.hint}` : ''}`, kind: 'command' as const, pick: () => { replace(`/${c.name} `); dismiss(signature) } })),
    ...skills.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(needle)).slice(0, 30).map(s => ({ id: `skill:${s.name}`, label: `/${s.name}`, description: s.description, kind: 'skill' as const, pick: () => add('skills', s.name) })),
  ] : [
    ...members.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(needle)).map(m => ({ id: `member:${m.id}`, label: `@${m.name}`, description: m.engineId, member: m, kind: 'member' as const, pick: () => { mention?.(m.id); replace('') } })),
    ...files.map(f => ({ id: `file:${f.path}`, label: f.name, description: f.directory ? `${f.path}/` : f.path, kind: f.directory ? 'folder' as const : 'file' as const, pick: () => f.directory ? replace(`@${f.path}/`) : add('files', f.path) })),
  ]
  const active = Math.min(index, Math.max(0, options.length - 1))
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' }) }, [active, id, open])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !menu.current?.contains(e.target) && !textarea.current?.contains(e.target)) dismiss(signature) }
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside)
  }, [open, signature, textarea])
  return <div className="lumo-agent-composer-input">
    <PromptContextChips value={context} remove={(kind, name) => setContext({ ...context, [kind]: context[kind]?.filter(v => v !== name) ?? [] })} />
    {open ? <div className="lumo-native-content lumo-agent-trigger-menu"><MenuSurface ref={menu} style={{ maxHeight }}>
      <div role="listbox" id={`${id}-menu`} aria-label={trigger === '/' ? '命令与 Skill' : '成员与项目文件'}>
        {options.map((option, i) => <button type="button" role="option" key={option.id} id={`${id}-${i}`} aria-selected={active === i} className="lumo-agent-trigger-option"
          onMouseMove={() => setIndex(i)} onMouseDown={e => e.preventDefault()} onClick={option.pick}>
          {option.member ? <EngineLogo engineId={option.member.engineId} small /> : option.kind === 'skill' ? <SkillIcon size={16} /> : option.kind === 'folder' ? <FolderIcon size={16} /> : option.kind === 'file' ? <FileTypeIcon path={option.label} size={16} /> : <span aria-hidden="true">/</span>}
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </button>)}
        {loading ? <div role="status">正在加载…</div> : !options.length && !error ? <div role="status">没有匹配项</div> : null}
      </div>
      {error ? <div className="lumo-agent-trigger-error" role="alert">{error}<button type="button" onClick={() => setRetry(n => n + 1)}>重试</button></div> : null}
    </MenuSurface></div> : null}
    <textarea ref={textarea} value={value} rows={1} maxLength={maxLength} aria-label={label} placeholder="发送消息，/ 选择 Skill，@ 引用文件或成员"
      aria-controls={open ? `${id}-menu` : undefined} aria-activedescendant={open && options.length ? `${id}-${active}` : undefined} aria-autocomplete="list"
      onChange={e => { onChange(e.target.value); setCaret(e.target.selectionStart) }} onSelect={e => setCaret(e.currentTarget.selectionStart)}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (open && e.key === 'Escape') { e.preventDefault(); dismiss(signature); return }
        if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % (options.length || 1)); return }
        if (open && options.length > 0 && !e.shiftKey && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); options[active]?.pick(); return }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!disabled) send() }
      }} />
  </div>
}
