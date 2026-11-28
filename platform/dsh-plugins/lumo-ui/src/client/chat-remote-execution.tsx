import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ApiError, api } from './api.ts'
import { AgentMarkdown } from './agent-chat-message.tsx'
import { RefreshIcon } from './chat-icons.tsx'
import { readDraft, useConversationDraft, writeDraft } from './conversation-drafts.ts'
import {
  artifactContentPath, executionID, executionKey, executionPayload, executionState, loadExecutionOptions, previewExecution,
  readExecution, remoteExecutionError, submitExecution, taskPath,
  type ExecutionCandidate, type ExecutionSnapshot, type PendingRemoteSubmission, type RemoteChatScope, type RemoteRequest, type RemoteTaskLink,
} from './chat-remote-api.ts'
import './chat-remote-execution.css'

export interface ChatRemoteExecutionProps {
  scope: RemoteChatScope
  /** Identifies the current chat for the host. Requests always use the existing same-origin governance BFF. */
  scopePath?: string
  initialTask?: string
  roles?: Array<{ id: string; name: string; instruction?: string }>
  selectedRoleId?: string
  disabled?: boolean
  request?: RemoteRequest
}

export function ChatRemoteExecution(props: ChatRemoteExecutionProps) {
  const key = JSON.stringify([props.scope.realm, props.scope.userId, props.scope.kind, props.scope.id])
  return <RemoteExecutionContext key={key} {...props} />
}

function RemoteExecutionContext({ roles = [], selectedRoleId = '', ...props }: ChatRemoteExecutionProps) {
  const [roleId, setRoleId] = useState(roles.some(r => r.id === selectedRoleId) ? selectedRoleId : '')
  useEffect(() => { if (selectedRoleId && roles.some(r => r.id === selectedRoleId)) setRoleId(selectedRoleId) }, [selectedRoleId])
  const role = roles.find(r => r.id === roleId)
  return <section className="lumo-chat-remote lumo-native-content" aria-label="远程执行">
    {roles.length ? <label>关联角色<select aria-label="远程任务关联角色" value={role?.id ?? ''} onChange={e => setRoleId(e.target.value)}><option value="">当前群组</option>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label> : null}
    <RemoteExecutionForm key={executionKey(props.scope, role?.id ?? '')} {...props} roleId={role?.id ?? ''} roleContext={role ? `角色：${role.name}${role.instruction ? `\n职责：${role.instruction}` : ''}` : ''} />
  </section>
}

function RemoteExecutionForm({ scope, initialTask = '', disabled = false, request = api, roleId, roleContext }: ChatRemoteExecutionProps & { roleId: string; roleContext: string }) {
  const key = executionKey(scope, roleId)
  // A role description alone is not a user task and must not become a default dispatch request.
  const initialIntent = initialTask.trim() ? [initialTask.trim(), roleContext].filter(Boolean).join('\n\n') : ''
  const [intent, setIntent, draftError] = useConversationDraft(key, 'intent', initialIntent)
  const [projectId, setProjectId] = useConversationDraft(key, 'project', scope.projectId ?? '')
  const [workerId, setWorkerId] = useConversationDraft(key, 'worker', '')
  const [clusterId, setClusterId] = useConversationDraft(key, 'cluster', '')
  const [links, setLinks] = useState<RemoteTaskLink[]>(() => {
    const saved = readDraft<unknown>(key, 'tasks', [])
    return Array.isArray(saved) ? saved.filter((r): r is RemoteTaskLink => Boolean(r && executionID(r.taskId) && typeof r.title === 'string')) : []
  })
  const [pending, setPending] = useState<PendingRemoteSubmission | null>(() => readDraft(key, 'submission', null))
  const [selectedTask, setSelectedTask] = useState(() => links[0]?.taskId ?? '')
  const [selectedRun, setSelectedRun] = useState('')
  const [options, setOptions] = useState<Awaited<ReturnType<typeof loadExecutionOptions>> | null>(null)
  const [optionsError, setOptionsError] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [candidates, setCandidates] = useState<ExecutionCandidate[]>([]), [previewSignature, setPreviewSignature] = useState('')
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null), [snapshotError, setSnapshotError] = useState('')
  const [reload, setReload] = useState(0)
  const mounted = useRef(true), actionPending = useRef(false), previewEpoch = useRef(0), previewAbort = useRef<AbortController | undefined>(undefined)
  const signature = JSON.stringify([intent.trim(), projectId])
  const locked = disabled || busy !== '' || pending !== null
  const candidate = previewSignature === signature ? candidates.find(c => c.worker_id === workerId && c.eligible) : undefined
  const validProject = options?.projects.some(p => p.id === projectId)
  const validCluster = !clusterId || options?.clusters.some(c => c.cluster_id === clusterId && c.state === 'healthy')

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewAbort.current?.abort() } }, [])
  useEffect(() => {
    const abort = new AbortController(); setOptionsError(''); setOptions(null)
    void loadExecutionOptions(request, scope, abort.signal).then(value => { if (!abort.signal.aborted) setOptions(value) }).catch(reason => { if (!abort.signal.aborted) setOptionsError(remoteExecutionError(reason)) })
    return () => abort.abort()
  }, [request, scope.realm, scope.userId, reload])
  useEffect(() => { ++previewEpoch.current; previewAbort.current?.abort(); setCandidates([]); setPreviewSignature('') }, [signature])

  const syncTask = useCallback(async (signal: AbortSignal) => {
    if (!selectedTask) return
    try {
      const value = await readExecution(request, selectedTask, selectedRun, signal)
      if (!signal.aborted && mounted.current) { setSnapshot(value); setSnapshotError('') }
    } catch (reason) { if (!signal.aborted && mounted.current) setSnapshotError(remoteExecutionError(reason)) }
  }, [request, selectedTask, selectedRun])
  useEffect(() => {
    setSnapshot(null); setSnapshotError('')
    if (!selectedTask) return
    const lifecycle = new AbortController(); let inflight = false
    const refresh = async () => { if (inflight || document.hidden || lifecycle.signal.aborted) return; inflight = true; try { await syncTask(lifecycle.signal) } finally { inflight = false } }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { lifecycle.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [syncTask, selectedTask, reload])

  const identify = async () => {
    if (actionPending.current || !validProject || !intent.trim()) return
    actionPending.current = true; setBusy('preview'); setError('')
    const generation = ++previewEpoch.current, abort = new AbortController(); previewAbort.current = abort
    try {
      const value = await previewExecution(request, intent, projectId, abort.signal)
      if (!mounted.current || generation !== previewEpoch.current) return
      setCandidates(value); setPreviewSignature(signature)
      if (!value.some(c => c.worker_id === workerId && c.eligible)) setWorkerId(value.find(c => c.eligible)?.worker_id ?? '')
    } catch (reason) { if (mounted.current && !abort.signal.aborted) setError(remoteExecutionError(reason)) }
    finally { actionPending.current = false; if (mounted.current) setBusy('') }
  }

  const submit = async () => {
    if (actionPending.current || disabled || !options) return
    if (!pending && (!candidate || !validProject || !validCluster)) return
    actionPending.current = true; setBusy('submit'); setError('')
    try {
      const receipt = pending ?? { key: crypto.randomUUID(), body: executionPayload(intent, projectId, workerId, clusterId) }
      if (!writeDraft(key, 'submission', receipt)) throw new Error('无法保存提交凭据，任务尚未提交。请恢复浏览器存储后重试。')
      setPending(receipt)
      const task = await submitExecution(request, receipt)
      const previous = readDraft<RemoteTaskLink[]>(key, 'tasks', links)
      const next = [{ taskId: task.id, title: task.title, createdAt: new Date().toISOString() }, ...(Array.isArray(previous) ? previous : []).filter(item => item.taskId !== task.id)].slice(0, 50)
      const saved = writeDraft(key, 'tasks', next)
      const cleared = saved && writeDraft(key, 'submission', undefined)
      if (!mounted.current) return
      setLinks(next); setSelectedTask(task.id); setSelectedRun(''); setPending(cleared ? null : receipt)
      if (!cleared) setError(`任务 ${task.id} 已提交，但本机记录未保存；请保留页面，重试将核对同一任务。`)
      else { setPreviewSignature(''); setCandidates([]); setIntent('') }
    } catch (reason) {
      // A definite rejection of the first request creates no task. An uncertain retry keeps its receipt.
      if (!pending && reason instanceof ApiError && [400, 401, 403, 404, 422].includes(reason.status) && writeDraft(key, 'submission', undefined) && mounted.current) setPending(null)
      if (mounted.current) setError(remoteExecutionError(reason))
    }
    finally { actionPending.current = false; if (mounted.current) setBusy('') }
  }

  const control = async (command: 'pause' | 'resume' | 'cancel') => {
    if (!snapshot || actionPending.current) return
    if (command !== 'cancel' && (!snapshot.run?.session_ref || !snapshot.control?.registered || !snapshot.control.available.some(c => c.command === command && c.available))) return
    actionPending.current = true; setBusy(command); setError('')
    try {
      const path = command === 'cancel' ? `${taskPath(snapshot.task.id)}/cancel` : `/lumo/api/sessions/${encodeURIComponent(snapshot.run!.session_ref!)}/control`
      await request(path, { method: 'POST', body: command === 'cancel' ? '{}' : JSON.stringify({ command, reason: '从对话远程执行面板发起' }) })
      if (mounted.current) setReload(value => value + 1)
    } catch (reason) { if (mounted.current) setError(remoteExecutionError(reason)) }
    finally { actionPending.current = false; if (mounted.current) setBusy('') }
  }

  const status = snapshot ? executionState(snapshot) : ''
  const actualRunning = !snapshotError && status === '执行中'
  return <>
    <div className="lumo-chat-remote-toolbar"><small>受管任务</small><Button size="sm" aria-label="刷新远程执行" title="刷新" disabled={busy !== ''} onClick={() => setReload(value => value + 1)}><RefreshIcon size={16} /></Button></div>
    {optionsError ? <p role="alert">{optionsError}</p> : !options ? <p role="status">正在读取远程执行环境…</p> : null}
    {error || draftError ? <p role="alert">{error || draftError}</p> : null}
    {pending ? <div className="lumo-chat-remote-pending" role="status"><p>上次提交尚待确认。重试会使用相同凭据核对同一任务。</p><details><summary>待核对任务</summary><p>{pending.body.intent}</p><small>{pending.body.project_id} · {pending.body.assignee_worker_id}</small></details><Button size="sm" disabled={busy !== '' || !options || disabled} onClick={() => void submit()}>核对上次提交</Button></div> : null}
    {options ? <form onSubmit={e => { e.preventDefault(); void identify() }}>
      <label>任务<textarea aria-label="远程任务内容" value={intent} rows={3} maxLength={12000} disabled={locked} onChange={e => setIntent(e.target.value)} placeholder="说明要执行的任务、约束与交付结果" /></label>
      <label>项目<select aria-label="远程执行项目" value={validProject ? projectId : ''} disabled={locked} onChange={e => setProjectId(e.target.value)}><option value="">选择受管项目</option>{options.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {scope.projectId && !options.projects.some(p => p.id === scope.projectId) ? <small>当前对话项目尚未映射到受管项目，请选择远端项目。</small> : null}
      <small>远端使用所选项目的受管资源；本机文件夹和附件不会自动传输。</small>
      <label>集群<select aria-label="远程执行集群" value={clusterId} disabled={locked} onChange={e => setClusterId(e.target.value)}><option value="">当前环境默认调度</option>{options.clusters.map(cluster => <option key={cluster.cluster_id} value={cluster.cluster_id} disabled={cluster.state !== 'healthy'}>{cluster.cluster_id}{cluster.state !== 'healthy' ? ` · ${cluster.state}` : ''}</option>)}</select></label>
      {options.clusterError ? <small>集群列表不可用，可使用当前环境默认调度。{options.clusterError}</small> : null}
      <Button size="sm" type="submit" disabled={locked || !validProject || !intent.trim()}>识别受管执行者</Button>
      {previewSignature === signature ? <>
        <label>执行者<select aria-label="远程受管执行者" value={workerId} disabled={locked} onChange={e => setWorkerId(e.target.value)}><option value="">选择执行者</option>{candidates.map(c => <option key={c.worker_id} value={c.worker_id} disabled={!c.eligible}>{c.display_name}{!c.eligible ? ' · 不可用' : ''}</option>)}</select></label>
        {candidate?.rationale.length ? <small>{candidate.rationale.join('；')}</small> : !candidates.some(c => c.eligible) ? <p role="status">当前没有符合项目、权限与运行条件的执行者。</p> : null}
        <Button size="sm" type="button" disabled={locked || !candidate || !validProject || !validCluster} onClick={() => void submit()}>提交远程任务</Button>
      </> : null}
    </form> : null}
    {links.length ? <div className="lumo-chat-remote-history"><label>本对话的远程任务<select aria-label="选择远程任务" value={selectedTask} onChange={e => { setSelectedTask(e.target.value); setSelectedRun('') }}>{links.map(link => <option key={link.taskId} value={link.taskId}>{link.title}</option>)}</select></label></div> : null}
    {snapshotError ? <p role="alert">状态读取失败：{snapshotError}</p> : null}
    {selectedTask && !snapshot && !snapshotError ? <p role="status">正在读取任务状态…</p> : null}
    {snapshot ? <section aria-label="远程任务状态" className="lumo-chat-remote-status">
      <header><StateDot state={actualRunning ? 'ongoing' : status === '已完成' ? 'done' : ['失败', '受阻'].includes(status) ? 'error' : 'idle'} size={8} /><b>{status}</b>{snapshotError ? <small>上次读取</small> : null}</header>
      <dl><dt>任务</dt><dd>{snapshot.task.id}</dd><dt>节点</dt><dd>{snapshot.run?.assigned_node_id || snapshot.task.assigned_node_id || '尚未分配'}</dd><dt>执行者</dt><dd>{snapshot.run?.worker_id || snapshot.task.assignee_worker_id || '尚未分配'}</dd></dl>
      {snapshot.runs.length ? <label>运行<select aria-label="选择远程运行" value={snapshot.run?.id ?? ''} onChange={e => setSelectedRun(e.target.value)}>{snapshot.runs.map(run => <option key={run.id} value={run.id}>尝试 {run.attempt} · {run.id}</option>)}</select></label> : <p>尚未创建运行记录。</p>}
      {snapshot.task.last_error || snapshot.run?.last_error ? <p role="alert">{snapshot.run?.last_error || snapshot.task.last_error}</p> : null}
      {snapshot.controlError ? <small role="status">会话控制不可用：{snapshot.controlError}</small> : snapshot.control?.registered === false ? <small>执行会话控制状态尚未登记。</small> : null}
      <div className="lumo-chat-remote-controls">{(['pause', 'resume'] as const).filter(command => snapshot.control?.registered && snapshot.control.available.some(item => item.command === command && item.available)).map(command => <Button key={command} size="sm" disabled={busy !== '' || Boolean(snapshotError)} onClick={() => void control(command)}>{command === 'pause' ? '暂停' : '恢复'}</Button>)}
        {['ASSIGNED', 'QUEUED', 'RUNNING'].includes(snapshot.task.state) ? <Button size="sm" disabled={busy !== '' || Boolean(snapshotError)} onClick={() => void control('cancel')}>取消任务</Button> : null}</div>
      {snapshot.resultError ? <p role="alert">结果读取失败：{snapshot.resultError}</p> : snapshot.result ? <div aria-label="远程任务结果"><AgentMarkdown text={snapshot.result.summary || '执行者已上报结果。'} />{snapshot.result.output !== undefined && snapshot.result.output !== null ? <details><summary>完整结果</summary>{typeof snapshot.result.output === 'string' ? <AgentMarkdown text={snapshot.result.output} /> : <pre>{JSON.stringify(snapshot.result.output, null, 2)}</pre>}</details> : null}{snapshot.result.files?.map((file, index) => <details key={`${index}:${file.name}`}><summary>{file.name}</summary><pre>{file.text}</pre></details>)}</div> : <small>执行者尚未上报结果。</small>}
      {snapshot.artifactError ? <p role="alert">产物读取失败：{snapshot.artifactError}</p> : snapshot.artifacts.length && snapshot.run ? <ul aria-label="远程任务产物">{snapshot.artifacts.map(artifact => <li key={artifact.id}><a href={artifactContentPath(snapshot.task.id, snapshot.run!.id, artifact.id)} download={artifact.name}>{artifact.name}</a></li>)}</ul> : null}
    </section> : null}
  </>
}
