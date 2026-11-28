import { ChatButton } from './chat-button.tsx'
import { AgentPermissionRequest } from './agent-permission-request.tsx'
import { ChatRemoteExecution } from './chat-remote-execution.tsx'
import { useConversationDraft } from './conversation-drafts.ts'
import { ConversationManagement, AttachmentStorage, ConversationSettingsSection } from './conversation-management.tsx'
import { AgentToolResult, AgentPlan } from './agent-execution-content.tsx'
import { AgentComposerInput, usePromptContext } from './agent-composer-input.tsx'
import { SendIcon, StopIcon, RefreshIcon, FolderIcon, DownIcon } from './chat-icons.tsx'
import { AgentChatDock, type ChatPanel } from './agent-chat-dock.tsx'
import { AgentChatActivity } from './agent-chat-activity.tsx'
import { AgentProjectPicker } from './agent-project-picker.tsx'
import { AttachmentCards, AttachmentComposer, useChatAttachments } from './chat-attachments.tsx'
/**
 * ACP 引擎会话面板（P1）：选择引擎（Claude Code / Codex / Gemini CLI …）→ 在工作区里开会话 → 流式显示回复与工具调用，
 * 权限请求就地按 P0-1 Ask 的选项作答。独立组件文件，index.tsx 只挂一行。
 *
 * 后端：/lumo/api/acp/*（dsh-plugins/acp-engines/src/routes.ts）。
 * 开关：localStorage `lumo.acpEngines = 'off'`（或 URL `?acp=off`）隐藏本面板；服务端 LUMO_ACP_ENGINES=off 时接口回 501，面板显示说明。
 */
import { createPortal } from 'react-dom'
import { AgentMarkdown, AgentThought, UserChatMessage, useChatScroll } from './agent-chat-message.tsx'
import { AgentModelSelect } from './agent-model-select.tsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Section } from './surface-shell.tsx'
import { useAcpSession } from './use-acp-session.ts'
import { acpCall, scopeKey } from './acp-session-state.ts'
import { openAgentRoom } from './agent-navigation.ts'
import { EngineLogo } from './engine-logo.tsx'
export { reduceTranscript, type TranscriptItem } from './acp-session-state.ts'

export const ACP_FLAG = 'lumo.acpEngines'
export const ACP_ENGINE_PREF = 'lumo.acpEngine'
const DESKTOP_PENDING = 'lumo.acpPending'
const DESKTOP_EVENT = 'lumo:acp-open'

export function acpPanelEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('acp') === 'off') return false
    if (typeof localStorage !== 'undefined' && localStorage.getItem(ACP_FLAG) === 'off') return false
  } catch { /* 读不到存储用默认 */ }
  return true
}

export interface EngineProbeView { id: string; label: string; protocol: string; available: boolean; reason?: string; authHint?: string; launchKind?: 'installed' | 'on-demand' }
export function AcpEngineSelect({ engines, value, onChange, disabled }: { engines: EngineProbeView[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return <label className="lumo-acp-engine-select">
    <span className="lumo-engine-heading"><EngineLogo engineId={value} small /><span>引擎</span></span>
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)} aria-label="选择 Agent 引擎">
      {engines.map(e => <option key={e.id} value={e.id} disabled={!e.available}>{e.label}{e.available ? '（已检测到入口）' : '（不可用）'}</option>)}
    </select>
  </label>
}

export function AcpSessionSection() {
  // key 来自 ACP BFF 解析的身份，与本地部署固定身份保持一致；复用面板现有列表刷新。
  const [identityKey, setIdentityKey] = useState('unresolved')
  return acpPanelEnabled() ? <Section title="引擎会话" meta="ACP 编码助手"><AcpSessionPanel key={identityKey} identityKey={identityKey} onIdentity={setIdentityKey} /></Section> : null
}

export function AcpSessionPanel({ defaultCwd = '', identityKey = 'local', onIdentity, initialEngineId, initialModelId, initialSessionId, readOnly = false, historyTarget, hideHistory = false, onSessions, onSelection }: { hideHistory?: boolean; onSessions?(sessions: import('./acp-session-state.ts').SessionView[]): void; onSelection?(id: string): void; historyTarget?: HTMLElement | null; defaultCwd?: string; identityKey?: string; onIdentity?: (key: string) => void; initialEngineId?: string | undefined; initialModelId?: string | undefined; initialSessionId?: string | undefined; readOnly?: boolean }) {
  const [engines, setEngines] = useState<EngineProbeView[]>([])
  const [engineId, setEngineId] = useState<string>(() => { try { return initialEngineId ?? localStorage.getItem(ACP_ENGINE_PREF) ?? 'claude-code' } catch { return 'claude-code' } })
  const [cwd, setCwd] = useState(defaultCwd)
  const [modelId, setModelId] = useState(initialModelId)
  const [unavailable, setUnavailable] = useState<string>()
  const { sessions, session, draftKey, draftError, hasMore, loadEarlier, metadata, continueSession, items, asks, text, setText, running, busy, ready, error, setError, connection, refresh, start: create, attach, clear, action, answer, setModel } = useAcpSession(identityKey, onIdentity)
  useEffect(() => { if (session) setCwd(session.cwd) }, [session?.id, session?.cwd])
  const [panel, setPanel] = useConversationDraft<ChatPanel>(draftKey, 'panel', null)
  const [continuing, setContinuing] = useState(false)
  const [handoffSummary, setHandoffSummary] = useConversationDraft(draftKey, 'summary', '')
  const [handoffEngine, setHandoffEngine] = useConversationDraft(draftKey, 'handoffEngine', session?.engineId ?? engineId)
  useEffect(() => { if (ready) onSessions?.(sessions) }, [sessions, ready, onSessions])
  useEffect(() => { onSelection?.(session?.id ?? '') }, [session?.id, onSelection])
  useEffect(() => {
    const controller = new AbortController()
    acpCall<{ engines: EngineProbeView[] }>('/lumo/api/acp/engines', { signal: controller.signal }).then(r => {
      if (!Array.isArray(r?.engines)) throw new Error('引擎列表响应无效')
      if (!controller.signal.aborted) { setEngines(r.engines); setUnavailable(undefined) }
    }).catch(e => { if (!controller.signal.aborted) setUnavailable(e instanceof Error ? e.message : String(e)) })
    return () => controller.abort()
  }, [identityKey])
  const attached = useRef('')
  useEffect(() => {
    if (!ready || !initialSessionId || attached.current === initialSessionId) return
    const entry = sessions.find(s => s.id === initialSessionId && s.state !== 'starting')
    if (entry) { attached.current = initialSessionId; void attach(entry) }
  }, [ready, initialSessionId, sessions, attach, readOnly])
  const choose = (id: string) => { clear(); setEngineId(id); setModelId(undefined); try { localStorage.setItem(ACP_ENGINE_PREF, id) } catch { /* 偏好可缺省 */ } }
  const start = useCallback((engine = engineId, dir = cwd) => create(engine, dir, engine === engineId ? modelId : undefined), [create, engineId, cwd, modelId])
  const startRef = useRef(start); startRef.current = start
  const sessionRef = useRef(session); sessionRef.current = session
  useEffect(() => {
    if (!ready || readOnly) return
    const take = (detail: unknown) => {
      const d = detail as { engineId?: unknown; cwd?: unknown; at?: unknown } | null
      if (!d || typeof d.engineId !== 'string' || typeof d.cwd !== 'string') return
      if (typeof d.at === 'number' && Date.now() - d.at > 5 * 60_000) return
      try { sessionStorage.removeItem(DESKTOP_PENDING) } catch { /* 可缺省 */ }
      if (sessionRef.current) { setError('已有连接的引擎会话，请先断开查看或结束会话'); return }
      const pending = startRef.current(d.engineId, d.cwd)
      if (pending) { setEngineId(d.engineId); setCwd(d.cwd); void pending }
    }
    try { const raw = sessionStorage.getItem(DESKTOP_PENDING); if (raw) take(JSON.parse(raw)) } catch { /* 可缺省 */ }
    const onOpen = (e: Event) => take((e as CustomEvent).detail)
    window.addEventListener(DESKTOP_EVENT, onOpen)
    return () => window.removeEventListener(DESKTOP_EVENT, onOpen)
  }, [ready, readOnly, setError])
  const context = usePromptContext(draftKey)
  const attachments = useChatAttachments(draftKey)
  const send = () => attachments.sendWith(async files => {
    const ok = await action('prompt', session, files, context.value)
    if (ok) context.clear(context.value)
    return ok
  })
  const switchProject = () => {
    if (!session || running || busy || !cwd.trim() || cwd === session.cwd) return
    const engine = session.engineId, model = session.modelId
    clear(); setEngineId(engine); setModelId(model); setPanel(null); void create(engine, cwd, model)
  }
  const cancel = () => action('cancel')
  const close = () => action('release')

  const scroll = useChatScroll(items, draftKey), permissions = useRef<HTMLDivElement>(null)
  const locate = (index: number) => {
    setPanel(null)
    const element = scroll.ref.current?.querySelector<HTMLElement>(`[data-activity-index="${index}"]`)
    element?.scrollIntoView?.({ block: 'start' }); element?.focus({ preventScroll: true })
  }
  if (unavailable) return <div className="lumo-workspace-note" role="status">ACP 引擎会话不可用：{unavailable}</div>
  const current = engines.find(e => e.id === engineId)
  const locked = readOnly || !!session?.room
  const history = <div className="lumo-acp-sessions" aria-label="已有引擎会话">
    <div className="lumo-chat-history-actions"><button type="button" className="lumo-chat-icon-button" aria-label="刷新会话" title="刷新会话" onClick={() => void refresh()}><RefreshIcon size={16} /></button>{session ? <button type="button" onClick={clear}>断开查看</button> : null}</div>
    {!sessions.length ? <p className="lumo-muted">暂无独立会话</p> : null}
    {sessions.map(entry => <div key={entry.id} className="lumo-chat-session-entry" aria-current={entry.id === session?.id ? 'page' : undefined}>
      <EngineLogo engineId={entry.engineId} small /><div><strong>{entry.title ?? entry.engineId}</strong><small>{entry.modelId ?? '工具默认模型'} · {entry.state === 'detached' ? '可恢复' : entry.state === 'running' ? '运行中' : entry.state === 'starting' ? '连接中' : '空闲'}</small>
      {entry.room ? <button type="button" onClick={() => openAgentRoom(entry.room!.id, scopeKey(entry))}>进入群组 · {entry.room.name}</button> : <button type="button" disabled={entry.id === session?.id || entry.state === 'starting'} onClick={() => { setPanel(null); void attach(entry) }}>{entry.state === 'detached' ? '恢复会话' : '连接会话'}</button>}
      {!entry.room ? <details><summary>管理会话</summary><small>{entry.cwd}</small>{entry.state === 'running' ? <button type="button" onClick={() => void action('cancel', entry)}>停止回合</button> : null}<button type="button" onClick={() => void action('release', entry)}>释放运行资源</button></details> : null}</div>
    </div>)}
  </div>
  const settings = <div className="lumo-dock-settings">
    {session ? <>
      <ConversationManagement scopePath={`/lumo/api/acp/sessions/${session.id}`} title={session.title ?? session.engineId} archived={session.archived} pinned={session.pinned} disabled={busy || running || locked} save={value => void metadata(value)} remove={() => void action('delete')} />
      <ConversationSettingsSection title="工具与模型">
        <div className="lumo-settings-engine"><EngineLogo engineId={session.engineId} small /><strong>{engines.find(e => e.id === session.engineId)?.label ?? session.engineId}</strong><small>{session.historyOnly ? '待恢复' : running ? '运行中' : '已连接'}</small></div>
        <AgentModelSelect models={session.models} disabled={locked || running || busy || session.historyOnly} label="会话模型" onChange={id => void setModel(id)} />
        {session.modes ? <label>运行模式<select aria-label="引擎运行模式" value={session.modes.currentModeId} disabled={locked || running || busy || session.historyOnly} onChange={e => { void acpCall(`/lumo/api/acp/sessions/${session.id}/mode`, { method: 'POST', body: JSON.stringify({ modeId: e.target.value }) }).catch(e => setError(String(e))) }}>{session.modes.availableModes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label> : null}
      </ConversationSettingsSection>
      <ConversationSettingsSection title="工作区">
        <AgentProjectPicker value={cwd} onChange={setCwd} recent={sessions.map(s => s.cwd)} disabled={locked || busy || running || attachments.sending} />
        {cwd !== session.cwd ? <ChatButton type="button" disabled={locked || busy || running || attachments.sending || !cwd.trim()} onClick={switchProject}>切换项目并新建会话</ChatButton> : null}
      </ConversationSettingsSection>
      {!locked ? <ConversationSettingsSection title="话题与运行">
        <div className="lumo-conversation-management"><ChatButton type="button" variant="ghost" className="lumo-settings-disclosure" aria-expanded={continuing} disabled={busy || running} onClick={() => setContinuing(!continuing)}><span>继续新话题</span><DownIcon size={14} /></ChatButton>{continuing ? <><label>新话题工具<select aria-label="新话题工具" value={handoffEngine} onChange={e => setHandoffEngine(e.target.value)}>{engines.map(engine => <option key={engine.id} value={engine.id} disabled={!engine.available}>{engine.label}</option>)}</select></label><label>承接摘要<textarea aria-label="新话题摘要" maxLength={32000} value={handoffSummary} onChange={e => setHandoffSummary(e.target.value)} placeholder="记录已完成事项、结论与待办，带入新话题" /></label><ChatButton type="button" disabled={busy || running || !handoffSummary.trim()} onClick={() => void continueSession(handoffSummary, handoffEngine)}>承接摘要并创建话题</ChatButton></> : null}</div>
        <div className="lumo-settings-actions">{session.historyOnly ? <ChatButton type="button" disabled={busy} onClick={() => void action('resume')}>恢复运行</ChatButton> : <ChatButton type="button" disabled={busy || running} onClick={() => void close()}>释放运行资源</ChatButton>}<ChatButton type="button" onClick={clear}>断开查看</ChatButton></div>
      </ConversationSettingsSection> : null}
      <AttachmentStorage />
    </> : <>
      <AcpEngineSelect engines={engines} value={engineId} onChange={choose} disabled={busy} />
      <AgentProjectPicker value={cwd} onChange={setCwd} recent={sessions.map(s => s.cwd)} disabled={busy || attachments.sending} />
      <ChatButton type="button" onClick={() => void start()} disabled={!ready || busy || !current?.available || cwd.trim() === ''}>{busy ? '正在连接…' : '开始会话'}</ChatButton>
      {modelId ? <small>初始模型：{modelId}</small> : null}
    </>}
  </div>
  return <div className="lumo-acp-panel lumo-acp-chat">
    {!readOnly ? <header className="lumo-chat-header"><EngineLogo engineId={session?.engineId ?? engineId} /><div><h2>{session?.title ?? engines.find(e => e.id === session?.engineId)?.label ?? '独立会话'}</h2><small>{session ? session.cwd : '选择工具，开始新的对话'}</small></div></header> : <p className="lumo-muted">成员执行详情 · 可在群组中发送消息、停止任务和调整模型。</p>}
    {!readOnly && !session ? <div className="lumo-acp-toolbar">{settings}</div> : null}
    {!readOnly && !hideHistory ? historyTarget ? createPortal(history, historyTarget) : <details className="lumo-acp-history-fallback"><summary>会话记录</summary>{history}</details> : null}
    {readOnly && !session && !busy && ready ? <button type="button" onClick={() => { attached.current = ''; void refresh() }}>重新连接成员详情</button> : null}
    {connection ? <div role="status">{connection}</div> : null}
    {current && !current.available ? <small role="note">{current.reason}{current.authHint ? ` · ${current.authHint}` : ''}</small> : null}
    {!session && current?.id === 'workbuddy' && current.available ? <small role="note">已找到 WorkBuddy 内置 CLI，尚未确认 ACP 连接。它与独立的 CodeBuddy Code 是不同的入口。</small> : null}
    {draftError || context.error || session?.storageError ? <div role="alert">{draftError || context.error || session?.storageError}</div> : null}
    {error ? <div role="alert" className="lumo-acp-error">{error}</div> : null}
    <div className="lumo-chat-body"><div className="lumo-chat-thread">
    <div className="lumo-acp-transcript" role="log" aria-live="polite" {...scroll}>
      {session?.handoff ? <details className="lumo-conversation-handoff" open><summary>承接的话题摘要</summary><AgentMarkdown text={session.handoff.summary} /></details> : null}
      {hasMore ? <button type="button" onClick={() => void loadEarlier()}>加载更早消息</button> : null}
      {!items.length ? <div className="lumo-chat-empty"><EngineLogo engineId={session?.engineId ?? engineId} /><h3>{session ? '开始对话' : '和 AI 一起完成工作'}</h3><p>{session ? '在下方输入消息。' : '连接已有会话，或选择工具和工作区开始。'}</p></div> : null}
      {items.map((item, i) => <div key={i} data-activity-index={i} tabIndex={-1} className="lumo-chat-jump-target">{item.kind === 'text'
        ? item.role === 'user' ? <UserChatMessage key={i} text={item.text} attachments={item.attachments} skills={item.skills} files={item.files} /> : item.role === 'thought' ? <AgentThought key={i} text={item.text} /> : <article key={i} className="lumo-role-reply"><header><EngineLogo engineId={session?.engineId ?? engineId} small /><strong>{session?.engineId ?? engineId}</strong></header><AgentMarkdown text={item.text} streaming={running && i === items.length - 1} /></article>
        : item.kind === 'tool' ? <AgentToolResult item={item} />
          : item.kind === 'plan' ? <AgentPlan entries={item.entries} /> : <div key={i} className="lumo-acp-notice">{item.text}</div>}</div>)}
    </div>
    {!locked && asks.length > 0 ? <div ref={permissions} tabIndex={-1} className="lumo-role-permissions" role="group" aria-label="待确认的权限请求">
      {asks.map(ask => <AgentPermissionRequest key={ask.id} ask={ask} disabled={busy} answer={id => void answer(ask, id)} />)}
    </div> : null}
    {session && !locked && !session.historyOnly ? <form className="lumo-chat-composer" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={attachments.drop} onPaste={attachments.paste} onSubmit={e => { e.preventDefault(); if (!running && !busy && !attachments.sending && (text.trim() || attachments.files.length || context.has)) void send() }}>
      <AttachmentCards draft={attachments} />
      <AgentComposerInput label="发送给引擎" value={text} onChange={setText} disabled={running || busy || attachments.sending} scopePath={`/lumo/api/acp/sessions/${session.id}`}
        context={context.value} setContext={context.set} engineCommands={session.commands} send={() => void send()} commands={[{ name: 'remote', label: '远程执行', run: () => setPanel('remote') }, { name: 'project', label: '选择项目', run: () => { setCwd(session.cwd); setPanel('settings') } }, { name: 'settings', label: '会话设置', run: () => setPanel('settings') }, { name: 'files', label: '项目文件', run: () => setPanel('files') }, { name: 'skills', label: '加载 Skill', run: () => setPanel('skills') }, { name: 'activity', label: '执行记录', run: () => setPanel('activity') }]} />
      <div className="lumo-chat-compose-actions"><AttachmentComposer draft={attachments} disabled={busy || running} /><small>{session.modelId ?? '工具默认模型'}</small><button type="button" className="lumo-chat-project-chip" title={session.cwd} onClick={() => { setCwd(session.cwd); setPanel('settings') }} aria-label="选择项目文件夹"><FolderIcon size={14} />{session.cwd.split(/[\\/]/u).filter(Boolean).at(-1) || session.cwd}</button>{running ? <button type="button" className="lumo-chat-icon-button" aria-label="停止" title="停止" onClick={() => void cancel()}><StopIcon size={18} /></button> : <button className="lumo-chat-send lumo-chat-icon-button" aria-label="发送" title="发送 · Enter" type="submit" disabled={busy || attachments.sending || (!text.trim() && !attachments.files.length && !context.has)}><SendIcon size={18} /></button>}</div>

    </form> : null}
    </div>
    {!readOnly && session ? <AgentChatDock key={`${identityKey}:${session.id}`} panel={panel} onPanel={value => { if (value === 'settings') setCwd(session.cwd); setPanel(value) }}
      scopePath={`/lumo/api/acp/sessions/${session.id}`} cwd={session.cwd} context={context.value} setContext={context.set}
      disabled={locked || running || busy || attachments.sending} pending={asks.length} running={running} settingsLabel="会话设置" settings={settings}
      remote={<ChatRemoteExecution scope={{kind: 'session', id: session.id, realm: session.realm, userId: session.userId, ...(session.projectId ? {projectId: session.projectId} : {})}} scopePath={`/lumo/api/acp/sessions/${session.id}`} initialTask={text || [...items].reverse().flatMap(item => item.kind === 'text' && item.role === 'user' ? [item.text] : [])[0] || ''} disabled={locked || busy} />}
      activity={<AgentChatActivity running={running} pending={asks.length} onPermissions={() => { setPanel(null); permissions.current?.focus(); permissions.current?.scrollIntoView?.({ block: 'nearest' }) }}
        entries={items.flatMap((item, index) => item.kind === 'plan' || item.kind === 'text' && item.role !== 'user' ? [] : [{
          id: String(index), title: item.kind === 'tool' ? item.title : item.kind === 'notice' ? '会话事件' : '用户消息',
          detail: item.kind === 'tool' ? '工具调用' : item.text || '附件 / 上下文消息',
          state: item.kind === 'tool' ? item.status : item.kind === 'notice' ? '事件' : '已发送', jump: () => locate(index),
        }]).reverse()} />} /> : null}
    </div>
  </div>
}
