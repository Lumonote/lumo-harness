import { useEffect, useRef, useState } from 'react'
import type { RoomView } from '../../../acp-engines/src/role-room-model.ts'
import type { PromptContext } from '../../../acp-engines/src/prompt-context.ts'
import { PROJECT_CAPABILITIES, parseProjectChecks, parseProjectTasks, workflowActive, type ProjectCapability, type ProjectCheck, type ProjectTaskInput, type ProjectWorkflow } from '../../../acp-engines/src/project-workflow-model.ts'
import { ChatButton } from './chat-button.tsx'
import { AgentMarkdown } from './agent-chat-message.tsx'
import { CloseIcon } from './chat-icons.tsx'
import { readDraft, useConversationDraft, writeDraft } from './conversation-drafts.ts'
import './project-workflow-panel.css'

export const capabilityLabels: Record<ProjectCapability, string> = { planning: '规划', frontend: '前端', backend: '后端', testing: '测试', review: '评审', documentation: '文档', general: '通用开发' }
export const projectWorkflowStateLabels: Record<string, string> = { draft: '待确认计划', planning: '正在拆解', running: '开发中', validating: '验收中', reviewing: '独立评审中', ready: '可合并', merging: '合并中', merged: '已合并', failed: '失败', cancelled: '已停止', interrupted: '需核对结果', pending: '待执行', completed: '已完成', blocked: '依赖未完成', passed: '通过' }
const stateLabels = projectWorkflowStateLabels
export type WorkflowAction = (body: Record<string, unknown>) => Promise<boolean>

export function ProjectCapabilities({ value = [], onChange, label, disabled = false }: { value?: ProjectCapability[] | undefined; onChange(value: ProjectCapability[]): void; label: string; disabled?: boolean }) {
  return <fieldset className="lumo-project-capabilities" disabled={disabled}><legend>{label}</legend>{PROJECT_CAPABILITIES.map(capability => <label key={capability}><input type="checkbox" aria-label={`${label}：${capabilityLabels[capability]}`} checked={value.includes(capability)} onChange={event => onChange(event.target.checked ? [...value, capability] : value.filter(c => c !== capability))} />{capabilityLabels[capability]}</label>)}</fieldset>
}

/** Each line is an argv array. No shell parsing or interpolation is performed here or by the runner. */
export function workflowChecks(text: string, previous: ProjectCheck[] = []): ProjectCheck[] {
  return parseProjectChecks(text.split('\n').filter(line => line.trim()).map((line, index) => {
    let argv: unknown
    try { argv = JSON.parse(line) } catch { throw new Error(`验收命令第 ${index + 1} 行需要 JSON 参数数组，例如 ["npm", "test"]`) }
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error(`验收命令第 ${index + 1} 行需要非空字符串数组`)
    const old = previous[index]
    return { id: old?.id ?? `check-${index + 1}`, command: argv[0], args: argv.slice(1), ...(old?.timeoutMs ? { timeoutMs: old.timeoutMs } : {}) }
  }))
}
const taskInput = ({ id, title, instruction, dependsOn, capabilities, acceptanceCriteria, roleId, assignment }: ProjectTaskInput & { assignment?: 'auto' | 'manual' }): ProjectTaskInput => ({ id, title, instruction, dependsOn, capabilities, acceptanceCriteria, ...(roleId && assignment !== 'auto' ? { roleId } : {}) })
const commandText = (checks: ProjectCheck[]) => checks.map(check => JSON.stringify([check.command, ...check.args])).join('\n')

export function ProjectWorkflowPanel({ room, busy, action, stop, inspect, initialGoal = '', initialSelectedId = '', context = {} }: {
  room: RoomView; busy: boolean; action: WorkflowAction; stop(): Promise<boolean>; inspect(id: string): void; initialGoal?: string; initialSelectedId?: string; context?: PromptContext
}) {
  const runs = room.workflows ?? [], latest = runs.at(-1)
  const [selected, setSelected] = useState(initialSelectedId), [creating, setCreating] = useState(false), [copied, setCopied] = useState<ProjectWorkflow>()
  const run = creating ? undefined : runs.find(item => item.id === selected) ?? latest
  const readOnly = !!run && run.id !== latest?.id
  return <section className="lumo-project-workflow" aria-label="项目协作流程">
    {runs.length ? <div className="lumo-workflow-heading"><select aria-label="项目流程记录" value={creating ? 'new' : run?.id ?? ''} onChange={event => { setCreating(event.target.value === 'new'); setSelected(event.target.value); setCopied(undefined) }}>
      {[...runs].reverse().map(item => <option key={item.id} value={item.id}>{stateLabels[item.state]} · {item.goal.slice(0, 50)}</option>)}
      <option value="new" disabled={room.busy}>新建流程</option>
    </select></div> : null}
    <WorkflowEditor key={run?.id ?? `new:${copied?.id ?? ''}`} run={run} seed={copied} room={room} readOnly={readOnly} busy={busy} context={context} initialGoal={initialGoal} action={action} stop={stop} inspect={inspect}
      prepared={() => { setCreating(false); setSelected(''); setCopied(undefined) }}
      copy={() => { setCopied(run); setCreating(true) }} />
  </section>
}

function WorkflowEditor({ run, seed, room, readOnly, busy, context, initialGoal, action, stop, inspect, prepared, copy }: {
  run?: ProjectWorkflow | undefined; seed?: ProjectWorkflow | undefined; room: RoomView; readOnly: boolean; busy: boolean; context: PromptContext; initialGoal: string; action: WorkflowAction; stop(): Promise<boolean>; inspect(id: string): void; prepared(): void; copy(): void
}) {
  const source = run ?? seed
  const draftKey = JSON.stringify([room.realm, room.userId, room.projectId, room.id, 'workflow', run?.id ?? `new:${seed?.id ?? ''}`, source?.updatedAt ?? 'new', readOnly ? 'history' : run?.state ?? 'new'])
  const [goal, setGoal, draftError] = useConversationDraft(draftKey, 'goal', source?.goal ?? initialGoal), [tasks, setTasks] = useConversationDraft<ProjectTaskInput[]>(draftKey, 'tasks', source?.tasks.map(taskInput) ?? [])
  const [checks, setChecks] = useConversationDraft(draftKey, 'checks', commandText(source?.checks ?? [])), [reviewerId, setReviewer] = useConversationDraft(draftKey, 'reviewer', source?.reviewerId ?? ''), [maxParallel, setParallel] = useConversationDraft(draftKey, 'parallel', source?.maxParallel ?? 2)
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [terminating, setTerminating] = useState(false)
  const creatingRequest = useRef<{ signature: string; id: string } | undefined>(readDraft(draftKey, 'request', undefined)), writing = useRef(false)
  useEffect(() => setError(''), [run?.updatedAt])
  const disabled = busy || pending || room.busy, editable = !readOnly && (!run || run.state === 'draft') && !disabled
  const dirty = !!run && JSON.stringify([goal, tasks, checks, reviewerId, maxParallel]) !== JSON.stringify([run.goal, run.tasks.map(taskInput), commandText(run.checks), run.reviewerId, run.maxParallel])
  const send = async (body: Record<string, unknown>) => {
    if (writing.current) return false
    writing.current = true; setPending(true); setError('')
    try { return await action(body) } catch (error) { setError(error instanceof Error ? error.message : String(error)); return false }
    finally { writing.current = false; setPending(false) }
  }
  const save = async () => {
    try {
      if (!goal.trim()) throw new Error('请填写项目目标')
      const body = { goal: goal.trim(), ...(tasks.length ? { tasks: parseProjectTasks(tasks.map(task => ({ ...task, acceptanceCriteria: task.acceptanceCriteria.map(value => value.trim()).filter(Boolean) }))) } : {}), checks: workflowChecks(checks, source?.checks), ...(reviewerId ? { reviewerId } : {}), maxParallel,
        ...(!run ? { ...(seed?.skills ?? context.skills ? { skills: seed?.skills ?? context.skills } : {}), ...(seed?.files ?? context.files ? { files: seed?.files ?? context.files } : {}) } : {}) }
      if (run) return await send({ action: 'update', runId: run.id, ...body })
      const signature = JSON.stringify(body)
      if (creatingRequest.current?.signature !== signature) creatingRequest.current = { signature, id: crypto.randomUUID() }
      writeDraft(draftKey, 'request', creatingRequest.current)
      const ok = await send({ action: 'prepare', id: creatingRequest.current.id, ...body })
      if (ok) { for (const field of ['goal', 'tasks', 'checks', 'reviewer', 'parallel', 'request']) writeDraft(draftKey, field, undefined); prepared() }
      return ok
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); return false }
  }
  const editTask = (id: string, patch: Partial<ProjectTaskInput>) => setTasks(list => list.map(task => task.id === id ? { ...task, ...patch } : task))
  const assignRole = (id: string, roleId: string) => setTasks(list => list.map(task => { if (task.id !== id) return task; const { roleId: _, ...rest } = task; return { ...rest, ...(roleId ? { roleId } : {}) } }))
  return <>
    {run ? <div className="lumo-workflow-status" data-state={run.state}><strong>{stateLabels[run.state]}</strong><small>{run.tasks.filter(t => t.state === 'completed').length} / {run.tasks.length} 个任务</small></div> : <p className="lumo-workflow-hint">共享项目规范，让成员在独立工作区开发，再统一测试和评审。</p>}
    {readOnly ? <small className="lumo-workflow-hint">历史流程只读，证据和原始配置保留。</small> : null}
    <label className="lumo-workflow-field">项目目标<textarea aria-label="项目流程目标" rows={3} maxLength={6000} value={goal} disabled={!editable} onChange={event => setGoal(event.target.value)} /></label>
    {run ? <details className="lumo-workflow-section"><summary>项目规范 · {run.rules.files.length} 个文件</summary>
      <small className="lumo-workflow-hint">快照 {run.rules.digest.slice(0, 12)} · 基于 {run.repository.branch} / {run.repository.baseCommit.slice(0, 10)}</small>
      {run.rules.files.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}
      {!run.rules.files.length ? <p className="lumo-workflow-hint">项目根目录未发现 AGENTS.md、CLAUDE.md 或 .lumo/project.md。</p> : null}
      {run.rules.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
      {run.skills?.length || run.files?.length ? <p className="lumo-workflow-hint">Skill：{run.skills?.join('、') || '无'}<br />引用：{run.files?.join('、') || '无'}</p> : null}
    </details> : <small className="lumo-workflow-hint">创建计划时读取项目规范，并带入当前选中的文件和 Skill。</small>}
    {tasks.length ? <div className="lumo-workflow-tasks" aria-label="项目任务列表">{tasks.map((task, index) => {
      const evidence = run?.tasks.find(t => t.id === task.id), role = room.roles.find(r => r.id === (task.roleId ?? evidence?.roleId))
      return <details key={task.id} className="lumo-workflow-task" open={undefined}>
        <summary><span className="lumo-workflow-task-number">{index + 1}</span><span>{task.title || '未命名任务'}<small>{role?.name ?? '按能力分配'}{evidence ? ` · ${stateLabels[evidence.state]}` : ''}</small></span></summary>
        <label className="lumo-workflow-field">任务名称<input aria-label={`任务 ${index + 1} 名称`} value={task.title} disabled={!editable} maxLength={120} onChange={event => editTask(task.id, { title: event.target.value })} /></label>
        <label className="lumo-workflow-field">任务要求<textarea aria-label={`任务 ${index + 1} 要求`} rows={3} value={task.instruction} disabled={!editable} maxLength={4000} onChange={event => editTask(task.id, { instruction: event.target.value })} /></label>
        <label className="lumo-workflow-field">执行成员<select aria-label={`任务 ${index + 1} 成员`} value={task.roleId ?? ''} disabled={!editable} onChange={event => assignRole(task.id, event.target.value)}><option value="">按能力分配</option>{room.roles.map(role => <option key={role.id} value={role.id}>{role.name} · {role.engineId}</option>)}</select></label>
        {evidence?.routingReason ? <p className="lumo-workflow-hint">{evidence.routingReason}</p> : null}
        <ProjectCapabilities label={`任务 ${index + 1} 能力`} value={task.capabilities} disabled={!editable} onChange={capabilities => editTask(task.id, { capabilities })} />
        {tasks.length > 1 ? <fieldset className="lumo-workflow-dependencies" disabled={!editable}><legend>前置任务</legend>{tasks.filter(other => other.id !== task.id).map(other => <label key={other.id}><input type="checkbox" aria-label={`任务 ${index + 1} 依赖 ${other.title}`} checked={task.dependsOn.includes(other.id)} onChange={event => editTask(task.id, { dependsOn: event.target.checked ? [...task.dependsOn, other.id] : task.dependsOn.filter(id => id !== other.id) })} />{other.title || '未命名任务'}</label>)}</fieldset> : null}
        <label className="lumo-workflow-field">验收条件<textarea aria-label={`任务 ${index + 1} 验收条件`} rows={2} value={task.acceptanceCriteria.join('\n')} disabled={!editable} onChange={event => editTask(task.id, { acceptanceCriteria: event.target.value.split('\n') })} /></label>
        {evidence?.workspace ? <small className="lumo-workflow-path">{evidence.workspace.path}</small> : null}
        {evidence?.changes ? <details><summary>代码差异 · {evidence.changes.files.length} 个文件</summary><small>提交 {evidence.changes.commit?.slice(0, 12) ?? evidence.changes.head.slice(0, 12)}</small><pre>{evidence.changes.stat}</pre><pre>{evidence.changes.diff || '没有代码差异'}</pre>{evidence.changes.truncated ? <small>差异已截断，可在任务工作区查看完整内容。</small> : null}</details> : null}
        {evidence?.reply ? <details><summary>成员报告</summary><AgentMarkdown text={evidence.reply} /></details> : null}
        {evidence?.error ? <p role="alert">{evidence.error}</p> : null}
        <div className="lumo-workflow-actions">{evidence?.sessionId ? <ChatButton type="button" variant="ghost" onClick={() => inspect(evidence.sessionId!)}>执行详情</ChatButton> : null}{editable ? <ChatButton type="button" variant="ghost" aria-label={`移除任务 ${index + 1}`} title="移除任务" disabled={tasks.length <= 1} onClick={() => setTasks(list => list.filter(t => t.id !== task.id).map(t => ({ ...t, dependsOn: t.dependsOn.filter(id => id !== task.id) })))}><CloseIcon size={14} /></ChatButton> : null}</div>
      </details>
    })}</div> : null}
    {editable && tasks.length < 8 ? <ChatButton type="button" variant="ghost" onClick={() => setTasks(list => [...list, { id: crypto.randomUUID(), title: '', instruction: '', dependsOn: [], capabilities: ['general'], acceptanceCriteria: [''] }])}>添加任务</ChatButton> : null}
    <details className="lumo-workflow-section" open={!run || run.state === 'draft'}><summary>验收与分配</summary>
      <label className="lumo-workflow-field">验收命令<textarea className="lumo-workflow-code-input" aria-label="项目验收命令" rows={3} placeholder={'["npm", "test"]\n["npm", "run", "typecheck"]'} value={checks} disabled={!editable} onChange={event => setChecks(event.target.value)} /></label>
      <small className="lumo-workflow-hint">每行一个命令及参数的 JSON 数组。开始运行会在合并工作区执行这些命令，记录退出码与输出。</small>
      <label className="lumo-workflow-field">独立评审<select aria-label="项目独立评审成员" disabled={!editable} value={reviewerId} onChange={event => setReviewer(event.target.value)}><option value="">按能力选择</option>{room.roles.map(role => <option key={role.id} value={role.id}>{role.name} · {role.engineId}</option>)}</select></label>
      <label className="lumo-workflow-field">同时运行<select aria-label="项目最大并行任务" disabled={!editable} value={maxParallel} onChange={event => setParallel(Number(event.target.value))}>{[1, 2, 3].map(n => <option key={n} value={n}>{n} 个任务</option>)}</select></label>
    </details>
    {run?.results.length ? <div className="lumo-workflow-section"><h4>验收证据</h4>{run.results.map(result => <details key={result.id}><summary>{stateLabels[result.state]} · {result.command} {result.args.join(' ')}</summary><small>退出码 {result.exitCode ?? '无'} · 提交 {result.commit.slice(0, 12)}</small><pre>{result.output || '无输出'}</pre>{result.truncated ? <small>输出已截断</small> : null}</details>)}</div> : null}
    {run?.review ? <div className="lumo-workflow-section"><h4>{run.review.verdict === 'approved' ? '独立评审通过' : '需要修改'}</h4><small>{room.roles.find(role => role.id === run.review!.roleId)?.name ?? run.review.roleId} · {run.review.commit.slice(0, 12)}</small><AgentMarkdown text={run.review.summary} />{run.review.findings.length ? <ul>{run.review.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul> : null}</div> : null}
    {run?.reviewReply && !run.review ? <details className="lumo-workflow-section"><summary>评审原始回复</summary><AgentMarkdown text={run.reviewReply} /></details> : null}
    {run?.previousEvidence?.length ? <details className="lumo-workflow-section"><summary>此前验收记录 · {run.previousEvidence.length}</summary>{run.previousEvidence.map((evidence, index) => <details key={`${evidence.savedAt}:${index}`}><summary>{index + 1} · {new Date(evidence.savedAt).toLocaleString()} · {evidence.commit?.slice(0, 10) ?? '未生成提交'}</summary>{evidence.results.map(result => <details key={result.id}><summary>{stateLabels[result.state]} · {result.command} {result.args.join(' ')}</summary><small>退出码 {result.exitCode ?? '无'}</small><pre>{result.output || '无输出'}</pre></details>)}{evidence.review ? <><small>{evidence.review.verdict === 'approved' ? '评审通过' : '需要修改'}</small><AgentMarkdown text={evidence.review.summary} /></> : evidence.reviewReply ? <AgentMarkdown text={evidence.reviewReply} /> : null}{evidence.error ? <p>{evidence.error}</p> : null}</details>)}</details> : null}
    {run?.plannerSessionId || run?.reviewSessionId ? <div className="lumo-workflow-actions">{run.plannerSessionId ? <ChatButton type="button" variant="ghost" onClick={() => inspect(run.plannerSessionId!)}>规划记录</ChatButton> : null}{run.reviewSessionId ? <ChatButton type="button" variant="ghost" onClick={() => inspect(run.reviewSessionId!)}>评审记录</ChatButton> : null}</div> : null}
    {run?.conflicts?.length ? <div role="alert"><strong>合并冲突</strong><ul>{run.conflicts.map(path => <li key={path}>{path}</li>)}</ul><small className="lumo-workflow-path">{run.integration?.path}</small></div> : null}
    {run?.error ? <p role="alert">{run.error}</p> : null}{error || draftError ? <p role="alert">{error || draftError}</p> : null}
    {dirty ? <small role="status">计划有未保存的修改。</small> : null}
    <div className="lumo-workflow-actions">
      {editable ? <ChatButton type="button" variant="primary" disabled={!!run && !dirty} onClick={() => void save()}>{run ? '保存计划' : '创建计划'}</ChatButton> : null}
      {run?.state === 'draft' && !readOnly ? <><ChatButton type="button" disabled={disabled || dirty} onClick={() => void send({ action: 'suggest', runId: run.id })}>AI 拆解</ChatButton><ChatButton type="button" variant="primary" disabled={disabled || dirty || !run.checks.length} onClick={() => void send({ action: 'run', runId: run.id })}>开始运行</ChatButton></> : null}
      {run && workflowActive(run.state) && !readOnly ? <ChatButton type="button" disabled={busy || pending} onClick={() => void stop()}>停止流程</ChatButton> : null}
      {run?.state === 'ready' && !readOnly ? <ChatButton type="button" variant="primary" disabled={disabled} onClick={() => void send({ action: 'merge', runId: run.id })}>合并到 {run.repository.branch}</ChatButton> : null}
      {run && ['failed', 'interrupted', 'cancelled'].includes(run.state) && !readOnly && run.commit && run.review?.verdict === 'approved' ? <ChatButton type="button" disabled={disabled} onClick={() => void send({ action: 'reconcile', runId: run.id })}>核对合并状态</ChatButton> : null}
      {run && ['failed', 'interrupted', 'cancelled'].includes(run.state) && !readOnly && run.tasks.every(task => task.state === 'completed') ? <ChatButton type="button" disabled={disabled} onClick={() => void send({ action: 'validate', runId: run.id })}>重新验收</ChatButton> : null}
      {run && ['cancelled', 'interrupted'].includes(run.state) && !readOnly ? <ChatButton type="button" variant="ghost" disabled={busy || pending} aria-expanded={terminating} onClick={() => setTerminating(!terminating)}>强制结束成员进程</ChatButton> : null}
      {run && !workflowActive(run.state) ? <ChatButton type="button" variant="ghost" disabled={disabled} onClick={copy}>沿用配置新建</ChatButton> : null}
    </div>
    {terminating && run ? <div className="lumo-workflow-section"><p>仅在成员没有响应停止请求时使用。会结束此流程仍在运行的成员进程，已写入文件保留，需核对执行结果。</p><ChatButton type="button" disabled={busy || pending} onClick={() => void send({ action: 'terminate', runId: run.id }).then(ok => { if (ok) setTerminating(false) })}>确认结束进程</ChatButton></div> : null}
    {run?.state === 'draft' && !run.checks.length ? <small className="lumo-workflow-hint">添加至少一条验收命令后可开始运行。</small> : null}
    {run?.state === 'ready' ? <p className="lumo-workflow-hint">代码、测试和评审已完成。合并会快进当前项目分支；项目已有其他修改时会保留结果并拒绝合并。</p> : null}
    {run && ['failed', 'interrupted', 'cancelled'].includes(run.state) && run.tasks.every(task => task.state === 'completed') ? <p className="lumo-workflow-hint">在保留的合并工作区修复冲突或问题并提交后，可重新验收；只重跑测试和独立评审，保留已有开发结果。<span className="lumo-workflow-path">{run.integration?.path}</span></p> : null}
    {run?.state === 'merged' ? <p role="status">已合并到 {run.repository.branch} · {run.commit?.slice(0, 12)}</p> : null}
  </>
}
