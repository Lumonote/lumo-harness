import { ChatComposer, chatCommands } from './chat-composer.tsx'
import { ChatButton } from './chat-button.tsx'
import { AgentPermissionRequest } from './agent-permission-request.tsx'
import { ChatRemoteExecution } from './chat-remote-execution.tsx'
import { removeConversationDraft, readDraft, useConversationDraft, writeDraft } from './conversation-drafts.ts'
import { ConversationManagement, AttachmentStorage, ConversationSettingsSection } from './conversation-management.tsx'
import { usePromptContext } from './agent-composer-input.tsx'
import { CloseIcon, DownIcon } from './chat-icons.tsx'
import { AgentProjectPicker } from './agent-project-picker.tsx'
import { useChatAttachments } from './chat-attachments.tsx'
import { AgentModelSelect } from './agent-model-select.tsx'
import { AcpSessionPanel } from './acp-session-panel.tsx'
import { EngineLogo } from './engine-logo.tsx'
import { AgentMarkdown, UserChatMessage, useChatScroll } from './agent-chat-message.tsx'
import { RoomLogo, RoomAppearanceFields, DEFAULT_APPEARANCE } from './room-appearance.tsx'
import { useEffect, useRef, useState } from 'react'
import type { RoomAppearance, RoomMode, RoomView, TurnInput } from '../../../acp-engines/src/role-room-model.ts'
import { AgentChatDock, type ChatPanel } from './agent-chat-dock.tsx'
import { AgentChatActivity } from './agent-chat-activity.tsx'
import type { AskView } from './acp-session-state.ts'

const stateLabel: Record<string, string> = { pending: '等待发言', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '结果需核对', new: '尚未启动', idle: '可对话', detached: '待恢复', missing: '会话不可用', starting: '连接中' }
export const RoleRoomConversation = ({ room, asks, busy, send, action, answer, connectRole, setModel, setAppearance, switchProject, metadata, continueTopic, recentProjects = [] }: {
  switchProject?(cwd: string): Promise<boolean>; recentProjects?: string[];
  room: RoomView; asks: AskView[]; busy: boolean; send(input: TurnInput): Promise<boolean>
  connectRole?(roleId: string): Promise<boolean>; setModel?(roleId: string, modelId: string): Promise<boolean>
  setAppearance?(value: RoomAppearance): Promise<boolean>
  metadata?(value: {name?: string; archived?: boolean; pinned?: boolean}): Promise<boolean>
  continueTopic?(value: {id: string; summary: string; name?: string}): Promise<boolean>
  action(name: 'stop' | 'resume' | 'release' | 'delete'): Promise<boolean>; answer(id: string, value: string): Promise<boolean>
}) => {
  const draftKey = JSON.stringify([room.realm, room.userId, room.projectId, 'room', room.id])
  const [text, setText, draftError] = useConversationDraft(draftKey, 'text', ''), [mode, setMode] = useConversationDraft<RoomMode>(draftKey, 'mode', 'direct'), [target, setTarget] = useConversationDraft(draftKey, 'target', room.coordinatorId)
  const [inspecting, setInspecting] = useState(''), [panel, setPanel] = useConversationDraft<ChatPanel>(draftKey, 'panel', null)
  const [continuing, setContinuing] = useState(false), [summary, setSummary] = useConversationDraft(draftKey, 'summary', '')
  const [appearance, changeAppearance] = useState(room.appearance ?? DEFAULT_APPEARANCE)
  const [appearanceSaved, markAppearanceSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [project, setProject] = useState(room.cwd)
  const context = usePromptContext(draftKey)
  const attachments = useChatAttachments(draftKey)
  const request = useRef<{ signature: string; id: string } | null>(readDraft(draftKey, 'request', null)), sending = useRef(false), input = useRef<HTMLTextAreaElement>(null)
  const scroll = useChatScroll(room.turns, draftKey), permissions = useRef<HTMLElement>(null)
  useEffect(() => { setInspecting(''); setProject(room.cwd); changeAppearance(room.appearance ?? DEFAULT_APPEARANCE); markAppearanceSaved(false); setDeleting(false) }, [room.id])
  const locate = (id: string) => {
    setPanel(null)
    const element = [...(scroll.ref.current?.querySelectorAll<HTMLElement>('[data-activity-id]') ?? [])].find(el => el.dataset.activityId === id)
    element?.scrollIntoView?.({ block: 'start' }); element?.focus({ preventScroll: true })
  }
  const submit = async () => {
    if ((!text.trim() && !attachments.files.length && !context.has) || busy || room.busy || sending.current) return
    sending.current = true
    const draft = text, signature = JSON.stringify([draftKey, text, mode, target, attachments.files.map(f => f.key), context.value])
    request.current = readDraft(draftKey, 'request', request.current)
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() }
    writeDraft(draftKey, 'request', request.current)
    try {
      const id = request.current.id
      await attachments.sendWith(async files => {
        const sent = await send({ id, text, mode, ...context.value, ...(files.length ? { attachments: files } : {}), ...(mode === 'direct' ? { targetRoleId: target } : {}) })
        if (sent) { context.clear(context.value); setText(current => current === draft ? '' : current); request.current = null; writeDraft(draftKey, 'request', undefined) }
        return sent
      })
    } finally { sending.current = false }
  }
  const deleteRoom = async () => { if (await action('delete')) await removeConversationDraft(draftKey) }
  const mention = (id: string) => { setMode('direct'); setTarget(id); input.current?.focus() }
  const changeText = (value: string) => {
    const role = room.roles.find(r => value.startsWith(`@${r.name} `) || value.startsWith(`@${r.name}\n`))
    if (role) { mention(role.id); setText(value.slice(role.name.length + 2)) } else setText(value)
  }
  return <section className="lumo-role-conversation" aria-label="角色协同对话">
    <header className="lumo-chat-header"><RoomLogo appearance={room.appearance} engines={room.roles.map(r => r.engineId)} /><div><h2>{room.name}</h2><small>{room.roles.length} 位成员 · {new Set(room.roles.map(r => r.engineId)).size} 个工具{room.busy ? ' · 正在回复' : ''}</small></div></header>
    {draftError || context.error ? <p role="alert">{draftError || context.error}</p> : null}
    {room.turns.length >= 20 && continueTopic ? <div className="lumo-conversation-handoff" role="status">此话题已有 {room.turns.length} / 24 轮，整理摘要后可继续新话题。<button type="button" disabled={busy || room.busy} onClick={() => { setContinuing(true); setPanel('settings') }}>继续新话题</button></div> : null}
    {room.error ? <p role="alert">{room.error}</p> : null}
    <div className="lumo-chat-body">
    <div className="lumo-chat-thread">
    <div className="lumo-role-log" role="log" aria-label="协作消息" aria-live="polite" {...scroll}>
      {room.handoff ? <details className="lumo-conversation-handoff" open><summary>承接的话题摘要</summary><AgentMarkdown text={room.handoff.summary} /></details> : null}
      {!room.turns.length ? <div className="lumo-chat-empty"><RoomLogo appearance={room.appearance} engines={room.roles.map(r => r.engineId)} /><h3>和你的团队开始对话</h3><p>直接发送给协调助理，或 @ 一位成员接着聊。</p><p>选择讨论或接力，可以让不同工具的角色共同完成任务。</p></div> : null}
      {room.turns.map(turn => <section key={turn.id} className="lumo-role-round"><UserChatMessage text={turn.text} attachments={turn.attachments} skills={turn.skills} files={turn.files} /><small className="lumo-chat-turn-meta">{turn.mode === 'direct' ? `发送给 ${room.roles.find(r => r.id === turn.targetRoleId)?.name ?? '成员'}` : turn.mode === 'relay' ? '角色接力' : '团队讨论'}{turn.state !== 'completed' ? ` · ${stateLabel[turn.state]}` : ''}</small>
        {turn.steps.map(step => { const role = room.roles.find(r => r.id === step.roleId)!; return <article key={step.roleId} className={`lumo-role-reply lumo-chat-jump-target ${step.state}`} data-activity-id={`${turn.id}:${step.roleId}`} tabIndex={-1}><header><strong className="lumo-engine-heading"><EngineLogo engineId={role.engineId} small /><span>{role.name}{step.purpose === 'summary' ? ' · 汇总' : ''}</span></strong><small>{role.engineId} · {stateLabel[step.state]}</small></header>{step.text ? <AgentMarkdown text={step.text} streaming={step.state === 'running'} /> : <p className="lumo-muted">{stateLabel[step.state]}{step.state === 'running' ? '…' : ''}</p>}{step.truncated ? <small>此回复已截断；完整内容请查看对应引擎会话。</small> : null}</article> })}
        {turn.error ? <p role="status">{turn.error}</p> : null}
      </section>)}
    </div>
    {asks.length ? <section ref={permissions} tabIndex={-1} aria-label="角色权限请求" className="lumo-role-permissions">{asks.map(ask => <AgentPermissionRequest key={ask.id} ask={ask} member={room.roles.find(r => r.sessionId === ask.source.session_ref)?.name} disabled={busy} answer={id => void answer(ask.id, id)} />)}</section> : null}
    <ChatComposer attachments={attachments} busy={busy} running={room.busy} cwd={room.cwd} project={() => setPanel('settings')} stop={() => void action('stop')}
      sendLabel="发送协作消息" stopLabel="停止协作" inputRef={input} label="协作消息输入" value={text} onChange={changeText} maxLength={6000}
      scopePath={`/lumo/api/acp/rooms/${room.id}`} context={context.value} setContext={context.set} members={room.roles} mention={mention} send={() => void submit()}
      commands={[...chatCommands(setPanel), { name: 'members', label: '群组成员', run: () => setPanel('members') }, { name: 'direct', label: '单人回复', run: () => setMode('direct') }, { name: 'discuss', label: '团队讨论', run: () => setMode('discuss') }, { name: 'relay', label: '角色接力', run: () => setMode('relay') }]}
      controls={<><select aria-label="对话方式" value={mode} disabled={busy || room.busy} onChange={event => setMode(event.target.value as RoomMode)}><option value="direct">单人回复</option><option value="discuss">团队讨论</option><option value="relay">角色接力</option></select>
        {mode === 'direct' ? <select aria-label="发送给角色" value={target} disabled={busy || room.busy} onChange={event => setTarget(event.target.value)}>{room.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select> : null}</>} />
    </div>
    <AgentChatDock panel={panel} onPanel={setPanel} scopePath={`/lumo/api/acp/rooms/${room.id}`} cwd={room.cwd}
      context={context.value} setContext={context.set} disabled={busy || room.busy || attachments.sending} pending={asks.length} running={room.busy}
      settingsLabel="群组设置" settings={<div className="lumo-dock-settings">
      {metadata ? <ConversationManagement scopePath={`/lumo/api/acp/rooms/${room.id}`} title={room.name} nameField="name" archived={room.archived} pinned={room.pinned} disabled={busy || room.busy} save={value => void metadata(value)} remove={() => void deleteRoom()} /> : null}
      <ConversationSettingsSection title="群组外观">
        <RoomAppearanceFields value={appearance} onChange={value => { changeAppearance(value); markAppearanceSaved(false) }} engines={room.roles.map(r => r.engineId)} disabled={busy || room.busy} />
        {setAppearance ? <div className="lumo-settings-actions"><ChatButton type="button" disabled={busy || room.busy} onClick={() => { markAppearanceSaved(false); void setAppearance(appearance).then(markAppearanceSaved) }}>保存群组外观</ChatButton>{appearanceSaved ? <small role="status">已保存</small> : null}</div> : null}
      </ConversationSettingsSection>
      <ConversationSettingsSection title="工作区">
        <AgentProjectPicker value={project} onChange={setProject} recent={recentProjects} disabled={busy || room.busy} />
        {switchProject && project !== room.cwd ? <ChatButton type="button" disabled={busy || room.busy || !project.trim()} onClick={() => void switchProject(project)}>切换项目并新建群组对话</ChatButton> : null}
      </ConversationSettingsSection>
      <ConversationSettingsSection title="话题与运行">
      {continueTopic ? <div className="lumo-conversation-management"><ChatButton type="button" variant="ghost" className="lumo-settings-disclosure" aria-expanded={continuing} disabled={busy || room.busy} onClick={() => setContinuing(!continuing)}><span>继续新话题</span><DownIcon size={14} /></ChatButton>{continuing ? <><label>承接摘要<textarea aria-label="新话题摘要" maxLength={12000} value={summary} onChange={e => setSummary(e.target.value)} placeholder="记录已完成事项、结论与待办，带入新话题" /></label><ChatButton type="button" disabled={busy || !summary.trim()} onClick={() => { const existing = readDraft<{id: string; summary: string} | null>(draftKey, 'continuation', null); const next = existing?.summary === summary ? existing : {id: crypto.randomUUID(), summary}; writeDraft(draftKey, 'continuation', next); void continueTopic(next) }}>承接摘要并创建话题</ChatButton></> : null}</div> : null}
      {!room.busy ? <div className="lumo-settings-actions">{Object.values(room.sessionStates).includes('detached') ? <ChatButton type="button" disabled={busy} onClick={() => void action('resume')}>恢复角色会话</ChatButton> : null}{Object.values(room.sessionStates).some(state => state === 'idle' || state === 'starting') ? <ChatButton type="button" disabled={busy} onClick={() => void action('release')}>释放角色运行资源</ChatButton> : null}{!metadata ? <ChatButton type="button" disabled={busy} onClick={() => setDeleting(!deleting)}>删除房间</ChatButton> : null}{deleting && !metadata ? <ChatButton type="button" disabled={busy} onClick={() => void deleteRoom()}>确认删除房间和对话记录</ChatButton> : null}</div> : null}
      </ConversationSettingsSection>
      <AttachmentStorage />
      </div>} members={<div className="lumo-role-roster">{room.roles.map(role => <article key={role.id}><strong className="lumo-engine-heading"><EngineLogo engineId={role.engineId} small /><span>{role.name}{role.id === room.coordinatorId ? ' · 协调助理' : ''}</span></strong><span>{role.engineId} · {stateLabel[room.sessionStates[role.id]!] ?? '未知'}</span><small>{role.instruction}</small>
        <AgentModelSelect models={room.sessionModels?.[role.id]} value={room.sessionModels?.[role.id]?.currentModelId ?? role.modelId} disabled={busy || room.busy || !setModel} label={`${role.name} 模型`} onChange={id => void setModel?.(role.id, id)} />
        <div className="lumo-dock-member-actions"><button type="button" className="lumo-chat-icon-button" aria-label={`提及 ${role.name}`} title={`@ ${role.name}`} disabled={busy || room.busy || attachments.sending} onClick={() => { setPanel(null); mention(role.id) }}>@</button>{role.sessionId && room.sessionStates[role.id] !== 'missing' ? <button type="button" onClick={() => setInspecting(role.sessionId!)}>查看成员会话</button> : connectRole ? <button type="button" disabled={busy || room.busy} onClick={() => void connectRole(role.id)}>连接工具与模型</button> : null}</div>
      </article>)}</div>}
      remote={<ChatRemoteExecution scope={{kind: 'room', id: room.id, realm: room.realm, userId: room.userId, ...(room.projectId ? {projectId: room.projectId} : {})}} scopePath={`/lumo/api/acp/rooms/${room.id}`} initialTask={text || room.turns.at(-1)?.text || ''} roles={room.roles} selectedRoleId={target} disabled={busy} />}
      activity={<AgentChatActivity running={room.busy} pending={asks.length} onPermissions={() => { setPanel(null); permissions.current?.focus(); permissions.current?.scrollIntoView?.({ block: 'nearest' }) }}
        entries={[...room.turns].reverse().flatMap(turn => turn.steps.map(step => ({
          id: `${turn.id}:${step.roleId}`, title: room.roles.find(role => role.id === step.roleId)?.name ?? step.roleId,
          detail: `${turn.text || '附件 / 上下文消息'}${step.purpose === 'summary' ? ' · 汇总' : ''}${step.error ? ` · ${step.error}` : ''}`,
          state: step.state, icon: <EngineLogo engineId={room.roles.find(role => role.id === step.roleId)?.engineId ?? ''} small />,
          jump: () => locate(`${turn.id}:${step.roleId}`),
        })))} />} />
    </div>
    {inspecting ? <aside className="lumo-member-session" aria-label="成员执行详情" onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); setInspecting('') } }}><button type="button" className="lumo-chat-icon-button" aria-label="关闭成员详情" title="关闭成员详情" onClick={() => setInspecting('')}><CloseIcon size={16} /></button><AcpSessionPanel key={inspecting} initialSessionId={inspecting} readOnly /></aside> : null}
  </section>
}
