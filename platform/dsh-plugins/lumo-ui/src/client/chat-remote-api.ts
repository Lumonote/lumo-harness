import { ApiError, api } from './api.ts'
import type { TaskResultFacts, SessionControlFacts } from './cluster-panels.tsx'

export type RemoteRequest = typeof api
export interface RemoteChatScope { kind: 'session' | 'room'; id: string; realm: string; userId: string; projectId?: string }
export interface ExecutionProject { id: string; name: string; status: string; yourRole: string }
export interface ExecutionCluster { cluster_id: string; realm: string; state: string }
export interface ExecutionCandidate { worker_id: string; user_id?: string; worker_kind?: string; display_name: string; eligible: boolean; rationale: string[]; active_tasks?: number }
export interface ExecutionTask { id: string; title: string; intent: string; project_id?: string; state: string; assigned_node_id?: string; assignee_worker_id?: string; last_error?: string }
export interface ExecutionRun { id: string; task_id?: string; attempt: number; state: string; worker_id?: string; assigned_node_id?: string; session_ref?: string; last_error?: string }
export interface ExecutionArtifact { id: string; name: string; content_type?: string; size_bytes?: number }
export interface ExecutionSnapshot {
  task: ExecutionTask; runs: ExecutionRun[]; run?: ExecutionRun; result?: TaskResultFacts; artifacts: ExecutionArtifact[]
  control?: SessionControlFacts; resultError: string; artifactError: string; controlError: string
}
export interface RemoteTaskPayload {
  title: string; intent: string; project_id: string; required_tags: string[]; required_skills: string[]
  assignee_worker_id: string; auto_assign: false
  schedule: { cluster_id: string; requires: Array<{ key: string; value?: string }>; queue: string; weight: number; avoid_nodes: string[] }
}
export interface PendingRemoteSubmission { key: string; body: RemoteTaskPayload }
export interface RemoteTaskLink { taskId: string; title: string; createdAt: string }
export const executionKey = (scope: RemoteChatScope, roleId: string) => JSON.stringify([scope.realm, scope.userId, scope.kind, scope.id, 'remote-execution', roleId])
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
export const executionID = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(v)
const pathID = (v: string) => { if (!executionID(v)) throw new Error('远程任务标识无效'); return encodeURIComponent(v) }
export const taskPath = (id: string) => `/lumo/api/delegations/${pathID(id)}`
export const runPath = (taskId: string, runId: string) => `/lumo/api/tasks/${pathID(taskId)}/runs/${pathID(runId)}`
export const artifactContentPath = (taskId: string, runId: string, artifactId: string) => `${runPath(taskId, runId)}/artifacts/${pathID(artifactId)}/content`

export function remoteExecutionError(error: unknown): string {
  const status = error instanceof ApiError ? error.status : object(error) ? error.status : undefined
  if (status === 401 || status === 403) return '当前账号没有此远程执行权限，请检查项目成员与委派权限。'
  if (status === 501 || status === 502 || status === 503 || status === 504) return '远程执行服务未配置或暂不可用，请检查分布式环境连接。'
  return error instanceof Error ? error.message : String(error)
}

export async function loadExecutionOptions(request: RemoteRequest, scope: RemoteChatScope, signal: AbortSignal): Promise<{ projects: ExecutionProject[]; clusters: ExecutionCluster[]; clusterError: string }> {
  const capabilities = await request<{ clusterReady?: boolean }>('/lumo/api/capabilities', { signal })
  if (capabilities.clusterReady !== true) throw new Error('当前环境尚未连接就绪的分布式服务，远程执行不可用。')
  const [directory, clusters] = await Promise.allSettled([
    request<{ viewer?: { realm: string; userId: string }; projects: ExecutionProject[] }>('/lumo/api/projects/directory?status=active&limit=100&offset=0&sort=recent', { signal }),
    request<{ clusters: ExecutionCluster[] }>('/lumo/api/scheduler/clusters', { signal }),
  ])
  if (directory.status === 'rejected') throw directory.reason
  const page = directory.value
  if (page.viewer && (page.viewer.realm !== scope.realm || page.viewer.userId !== scope.userId)) throw new Error('当前登录身份已变化，请重新打开对话。')
  if (!Array.isArray(page.projects) || !page.projects.every(p => p && executionID(p.id) && typeof p.name === 'string')) throw new Error('项目目录响应无效')
  const rows = clusters.status === 'fulfilled' && Array.isArray(clusters.value.clusters) ? clusters.value.clusters.filter(c => c && executionID(c.cluster_id) && c.realm === scope.realm) : []
  return { projects: page.projects.filter(p => p.status === 'active'), clusters: rows, clusterError: clusters.status === 'rejected' ? remoteExecutionError(clusters.reason) : '' }
}

export async function previewExecution(request: RemoteRequest, intent: string, projectId: string, signal?: AbortSignal): Promise<ExecutionCandidate[]> {
  if (!intent.trim() || !executionID(projectId)) throw new Error('请填写任务并选择项目')
  const response = await request<{ candidates: ExecutionCandidate[] }>('/lumo/api/delegations/preview', { method: 'POST', body: JSON.stringify({ intent: intent.trim(), project_id: projectId, required_tags: [], required_skills: [] }), ...(signal ? { signal } : {}) })
  if (!Array.isArray(response.candidates) || !response.candidates.every(c => c && executionID(c.worker_id) && typeof c.display_name === 'string' && typeof c.eligible === 'boolean')) throw new Error('受管执行者响应无效')
  return response.candidates.map(c => ({ ...c, rationale: Array.isArray(c.rationale) ? c.rationale.filter(r => typeof r === 'string') : [] }))
}

export function executionPayload(intent: string, projectId: string, workerId: string, clusterId = ''): RemoteTaskPayload {
  if (!intent.trim() || !executionID(projectId) || !executionID(workerId) || (clusterId && !executionID(clusterId))) throw new Error('远程任务参数不完整')
  return { title: intent.trim().split('\n')[0]!.slice(0, 120), intent: intent.trim(), project_id: projectId, required_tags: [], required_skills: [], assignee_worker_id: workerId, auto_assign: false,
    schedule: { cluster_id: clusterId, requires: [{ key: 'subagent' }], queue: 'delegated', weight: 1, avoid_nodes: [] } }
}

function validTask(value: unknown): value is ExecutionTask { return object(value) && executionID(value.id) && typeof value.state === 'string' && typeof value.title === 'string' }
export async function submitExecution(request: RemoteRequest, pending: PendingRemoteSubmission): Promise<ExecutionTask> {
  if (!executionID(pending.key)) throw new Error('提交凭据无效，请检查已保存的任务草稿')
  const response = await request<unknown>('/lumo/api/delegations', { method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.body) })
  const task = object(response) && object(response.task) ? response.task : response
  if (!validTask(task)) throw new Error('提交结果缺少任务 ID，保留原提交凭据以供重试核对')
  return task
}

export async function readExecution(request: RemoteRequest, taskId: string, selectedRunId: string, signal: AbortSignal): Promise<ExecutionSnapshot> {
  const [task, history] = await Promise.all([
    request<ExecutionTask>(taskPath(taskId), { signal }), request<{ runs: ExecutionRun[] }>(`/lumo/api/tasks/${pathID(taskId)}/runs`, { signal }),
  ])
  if (!validTask(task) || task.id !== taskId || !Array.isArray(history.runs) || !history.runs.every(r => r && executionID(r.id) && typeof r.state === 'string' && Number.isInteger(r.attempt) && (!r.task_id || r.task_id === taskId))) throw new Error('远程任务或运行记录响应无效')
  const runs = [...history.runs].sort((a, b) => b.attempt - a.attempt)
  const run = runs.find(r => r.id === selectedRunId) ?? runs[0]
  const snapshot: ExecutionSnapshot = { task, runs, artifacts: [], resultError: '', artifactError: '', controlError: '', ...(run ? { run } : {}) }
  if (!run) return snapshot
  const root = runPath(taskId, run.id)
  const [result, artifacts, control] = await Promise.allSettled([
    request<TaskResultFacts>(`${root}/result`, { signal }), request<{ artifacts: ExecutionArtifact[] }>(`${root}/artifacts`, { signal }),
    run.session_ref ? request<SessionControlFacts>(`/lumo/api/sessions/${pathID(run.session_ref)}/control`, { signal }) : Promise.resolve(undefined),
  ])
  if (result.status === 'fulfilled') {
    if (!result.value || result.value.run_id !== run.id || (result.value.task_id && result.value.task_id !== taskId) || (result.value.summary !== undefined && typeof result.value.summary !== 'string') || (result.value.files !== undefined && (!Array.isArray(result.value.files) || !result.value.files.every(f => f && typeof f.name === 'string' && typeof f.text === 'string')))) snapshot.resultError = '结果与当前运行不匹配或内容无效'
    else snapshot.result = result.value
  } else if (!(result.reason instanceof ApiError && result.reason.status === 404)) snapshot.resultError = remoteExecutionError(result.reason)
  if (artifacts.status === 'fulfilled') {
    if (!Array.isArray(artifacts.value.artifacts) || !artifacts.value.artifacts.every(a => a && executionID(a.id) && typeof a.name === 'string')) snapshot.artifactError = '产物列表响应无效'
    else snapshot.artifacts = artifacts.value.artifacts
  } else snapshot.artifactError = remoteExecutionError(artifacts.reason)
  if (control.status === 'fulfilled' && control.value) {
    if (control.value.session_ref !== run.session_ref || typeof control.value.registered !== 'boolean' || !Array.isArray(control.value.available) || !control.value.available.every(c => c && typeof c.command === 'string' && typeof c.available === 'boolean')) snapshot.controlError = '执行会话控制状态不匹配'
    else snapshot.control = control.value
  } else if (control.status === 'rejected') snapshot.controlError = remoteExecutionError(control.reason)
  return snapshot
}

const states: Record<string, string> = { ASSIGNED: '已分派', QUEUED: '排队中', RUNNING: '执行中', CANCELLING: '等待停止确认', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', BLOCKED: '受阻', paused: '已暂停', 'awaiting-approval': '等待审批', stopped: '已停止', aborted: '已中止', running: '执行中' }
export function executionState(snapshot: ExecutionSnapshot): string {
  const state = snapshot.run?.state ?? snapshot.task.state
  if (state !== 'CANCELLING' && ['ASSIGNED', 'QUEUED', 'RUNNING'].includes(state) && snapshot.control?.registered && snapshot.control.state && snapshot.control.state !== 'running') return states[snapshot.control.state] ?? snapshot.control.state
  return states[state] ?? state
}
