import { validateFlowDefinition } from '../../../shared/seam-contracts/flows.ts'
import type { ProjectRulesSnapshot } from './project-practice-rules.ts'
import type { ProjectRepository, ProjectWorktree, ProjectChanges } from './project-worktrees.ts'

export const PROJECT_CAPABILITIES = ['planning', 'frontend', 'backend', 'testing', 'review', 'documentation', 'general'] as const
export const PROJECT_WORKFLOW_LIMITS = { jsonBytes: 2_000_000, reserveBytes: 64 * 1024, checkConfigBytes: 32 * 1024, sessionHistory: 128, previousEvidence: 8 } as const
export type ProjectCapability = typeof PROJECT_CAPABILITIES[number]
export interface ProjectTaskInput {
  id: string; title: string; instruction: string; dependsOn: string[]; capabilities: ProjectCapability[]
  acceptanceCriteria: string[]; roleId?: string
}
export interface ProjectCheck { id: string; command: string; args: string[]; timeoutMs?: number }
export interface ProjectCheckResult extends ProjectCheck { state: 'passed' | 'failed' | 'cancelled'; exitCode: number | null; output: string; truncated: boolean; commit: string; startedAt: string; finishedAt: string }
export interface ProjectTask extends ProjectTaskInput {
  roleId: string; routingReason: string; assignment?: 'auto' | 'manual'; state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted'
  sessionId?: string; workspace?: ProjectWorktree; changes?: ProjectChanges; reply?: string; error?: string
}
export type ProjectWorkflowState = 'draft' | 'planning' | 'running' | 'validating' | 'reviewing' | 'ready' | 'merging' | 'merged' | 'failed' | 'cancelled' | 'interrupted'
export interface ProjectWorkflow {
  id: string; goal: string; state: ProjectWorkflowState; createdAt: string; updatedAt: string; requestDigest?: string
  repository: ProjectRepository; rules: ProjectRulesSnapshot; tasks: ProjectTask[]; checks: ProjectCheck[]; results: ProjectCheckResult[]
  reviewerId: string; maxParallel: number; skills?: string[]; files?: string[]; contextDigest?: string; sessionHistory?: string[]
  plannerSessionId?: string; plannerWorkspace?: ProjectWorktree; plannerReply?: string
  reviewSessionId?: string; reviewWorkspace?: ProjectWorktree; reviewReply?: string
  review?: { verdict: 'approved' | 'changes_requested'; summary: string; findings: string[]; commit: string; roleId: string }
  integration?: ProjectWorktree; commit?: string; conflicts?: string[]; error?: string; mergedAt?: string
  previousEvidence?: Array<Pick<ProjectWorkflow, 'commit' | 'results' | 'review' | 'reviewReply' | 'error'> & { savedAt: string }>
}
export interface ProjectWorkflowInput {
  id: string; goal: string; tasks?: ProjectTaskInput[]; checks?: ProjectCheck[]; reviewerId?: string; maxParallel?: number; skills?: string[]; files?: string[]
}
export const WORKFLOW_ACTIVE = ['planning', 'running', 'validating', 'reviewing', 'merging'] as const
export const workflowActive = (state: ProjectWorkflowState): boolean => (WORKFLOW_ACTIVE as readonly string[]).includes(state)
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= limit
export const workflowIdentifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(v)
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('项目流程需要对象'); return v as Record<string, unknown> }
export function capabilityList(value: unknown): ProjectCapability[] {
  if (!Array.isArray(value) || value.length > PROJECT_CAPABILITIES.length || value.some(v => !PROJECT_CAPABILITIES.includes(v)) || new Set(value).size !== value.length) throw new Error('项目能力标签无效')
  return [...value] as ProjectCapability[]
}
export function parseProjectTasks(value: unknown): ProjectTaskInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error('项目流程需要 1–8 个任务')
  const tasks = value.map(v => {
    const t = object(v)
    if (!workflowIdentifier(t.id) || t.id.length > 48 || !text(t.title, 120) || !text(t.instruction, 4000) || !Array.isArray(t.dependsOn) || t.dependsOn.length > 7 || t.dependsOn.some(d => !workflowIdentifier(d))
      || new Set(t.dependsOn).size !== t.dependsOn.length || !Array.isArray(t.acceptanceCriteria) || !t.acceptanceCriteria.length || t.acceptanceCriteria.length > 8 || t.acceptanceCriteria.some(c => !text(c, 800))
      || (t.roleId !== undefined && !workflowIdentifier(t.roleId))) throw new Error('任务名称、依赖、职责或验收条件无效')
    return { id: t.id, title: t.title.trim(), instruction: t.instruction.trim(), dependsOn: [...t.dependsOn] as string[], capabilities: capabilityList(t.capabilities), acceptanceCriteria: [...t.acceptanceCriteria] as string[], ...(t.roleId ? { roleId: t.roleId } : {}) }
  })
  validateFlowDefinition({ nodes: tasks.map(t => ({ id: t.id, operator: 'project.implement' })), edges: tasks.flatMap(t => t.dependsOn.map(from => ({ from, to: t.id }))) })
  return tasks
}
export function parseProjectChecks(value: unknown): ProjectCheck[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('最多配置 8 条验收命令')
  const checks = value.map(v => {
    const c = object(v)
    if (!workflowIdentifier(c.id) || !text(c.command, 4096) || /[\0\r\n]/u.test(c.command) || !Array.isArray(c.args) || c.args.length > 64
      || c.args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))
      || (c.timeoutMs !== undefined && (typeof c.timeoutMs !== 'number' || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 30 * 60_000))) throw new Error('验收命令或超时配置无效')
    return { id: c.id, command: c.command, args: [...c.args] as string[], ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs as number } : {}) }
  })
  if (new Set(checks.map(c => c.id)).size !== checks.length) throw new Error('验收命令标识重复')
  if (bytes(JSON.stringify(checks)) > PROJECT_WORKFLOW_LIMITS.checkConfigBytes) throw new Error('验收命令配置总量不能超过 32 KiB，请将长脚本保存为项目文件')
  return checks
}
export function workflowSessions(run: ProjectWorkflow): string[] { return [...new Set([...(run.sessionHistory ?? []), run.plannerSessionId, run.reviewSessionId, ...run.tasks.map(t => t.sessionId)].filter((s): s is string => !!s))] }
/** Reserve diagnostic space before adding evidence; never discard older receipts. */
export function assertProjectWorkflowBudget(value: unknown): void {
  if (bytes(JSON.stringify(value)) > PROJECT_WORKFLOW_LIMITS.jsonBytes - PROJECT_WORKFLOW_LIMITS.reserveBytes) throw new Error('项目流程证据已达容量上限；已保留先前证据和工作区，请继续新话题')
}

// This module is also imported by the client. Keep persistence validation pure
// and portable; filesystem ownership and content hashes are checked by the runner.
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const commit = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(v)
const session = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v)
const date = (v: unknown): v is string => text(v, 64) && /^\d{4}-\d\d-\d\dT/u.test(v) && Number.isFinite(Date.parse(v))
const bytes = (v: string) => new TextEncoder().encode(v).byteLength
const normalized = (v: string) => v.replaceAll('\\', '/').replace(/\/$/u, '')
const absolute = (v: unknown): v is string => text(v, 4096) && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u.test(v)
  && !/[\x00-\x1f]/u.test(v) && !v.split(/[\\/]/u).some(p => p === '.' || p === '..')
const gitFile = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0') && !v.startsWith('/')
  && !v.split('/').some(p => !p || p === '.' || p === '..')
function contextFile(value: string): boolean {
  if (!value || value.startsWith('/') || /[\x00-\x1f\\]/u.test(value) || /^[A-Za-z]:/u.test(value)) return false
  let depth = 0
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (--depth < 0) return false }
    else depth++
  }
  return depth > 0
}
const branch = (v: unknown): v is string => text(v, 1024) && !/[\x00-\x20\x7f~^:?*\[\\]/u.test(v)
  && !v.startsWith('-') && !v.includes('..') && !v.includes('@{') && !v.endsWith('.') && v !== '@'
  && !v.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))
function schema(v: Record<string, unknown>, fields: string[], label: string): void {
  if (Object.keys(v).some(key => !fields.includes(key))) throw new Error(`${label}包含未知字段`)
}
function stringList(v: unknown, count: number, max: number, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(v) || v.length > count || v.some(s => !(allowEmpty ? bounded(s, max) : text(s, max)))) throw new Error(`${label}无效或过大`)
  return [...v] as string[]
}
function fileList(v: unknown, count: number, label: string, context = false): string[] {
  const files = stringList(v, count, 4096, label, true)
  if (files.some(file => !(context ? contextFile(file) : gitFile(file))) || new Set(files).size !== files.length) throw new Error(`${label}路径无效或重复`)
  return files
}
function repositorySnapshot(value: unknown): ProjectRepository {
  const v = object(value); schema(v, ['root', 'commonDir', 'branch', 'baseCommit'], '项目仓库快照')
  if (!absolute(v.root) || !absolute(v.commonDir) || !branch(v.branch) || !commit(v.baseCommit)) throw new Error('项目仓库快照无效')
  return { root: v.root, commonDir: v.commonDir, branch: v.branch, baseCommit: v.baseCommit }
}
function rulesSnapshot(value: unknown): ProjectRulesSnapshot {
  const v = object(value); schema(v, ['digest', 'files', 'warnings'], '项目规范快照')
  if (!digest(v.digest) || !Array.isArray(v.files) || v.files.length > 3) throw new Error('项目规范快照无效')
  const sources = ['AGENTS.md', 'CLAUDE.md', '.lumo/project.md']; let previous = -1, total = 0
  const files = v.files.map(value => {
    const f = object(value); schema(f, ['path', 'content', 'digest'], '项目规范文件')
    if (typeof f.path !== 'string' || !bounded(f.content, 64 * 1024) || f.content.includes('\0') || !digest(f.digest)) throw new Error('项目规范文件无效')
    const index = sources.indexOf(f.path), size = bytes(f.content)
    if (index <= previous || size > 64 * 1024 || (total += size) > 128 * 1024) throw new Error('项目规范来源、顺序或大小无效')
    previous = index
    return { path: f.path, content: f.content, digest: f.digest }
  })
  return { digest: v.digest, files, warnings: stringList(v.warnings, 16, 2000, '项目规范提示') }
}
function workspaceSnapshot(value: unknown, repo: ProjectRepository, expectedTask?: string): ProjectWorktree {
  const v = object(value); schema(v, ['runId', 'taskId', 'path', 'branch', 'baseCommit'], '项目工作区')
  if (!workflowIdentifier(v.runId) || !/^[a-zA-Z0-9]/u.test(v.runId) || !workflowIdentifier(v.taskId) || !/^[a-zA-Z0-9]/u.test(v.taskId)
    || !absolute(v.path) || !branch(v.branch) || !commit(v.baseCommit)
    || (expectedTask !== undefined && v.taskId !== expectedTask)
    || normalized(v.path) !== `${normalized(repo.commonDir)}/lumo-workflows/${v.runId}/${v.taskId}`
    || v.branch !== `codex/lumo-${v.runId}-${v.taskId}`) throw new Error('项目工作区路径、分支或归属无效')
  return { runId: v.runId, taskId: v.taskId, path: v.path, branch: v.branch, baseCommit: v.baseCommit }
}
function changesSnapshot(value: unknown): ProjectChanges {
  const v = object(value); schema(v, ['head', 'status', 'stat', 'diff', 'files', 'commit', 'truncated'], '任务改动证据')
  if (!commit(v.head) || !bounded(v.status, 64 * 1024) || !bounded(v.stat, 64 * 1024) || !bounded(v.diff, 64 * 1024)
    || typeof v.truncated !== 'boolean' || (v.commit !== undefined && (!commit(v.commit) || v.commit !== v.head))) throw new Error('任务改动证据无效或过大')
  return { head: v.head, status: v.status, stat: v.stat, diff: v.diff, files: fileList(v.files, 10000, '任务改动文件'), truncated: v.truncated, ...(v.commit ? { commit: v.commit as string } : {}) }
}
function checkResult(value: unknown, checks: ProjectCheck[], currentCommit: unknown): ProjectCheckResult {
  const v = object(value)
  schema(v, ['id', 'command', 'args', 'timeoutMs', 'state', 'exitCode', 'output', 'truncated', 'commit', 'startedAt', 'finishedAt'], '验收结果')
  const parsed = parseProjectChecks([v])[0]!, configured = checks.find(check => check.id === parsed.id)
  if (!configured || configured.command !== parsed.command || JSON.stringify(configured.args) !== JSON.stringify(parsed.args) || configured.timeoutMs !== parsed.timeoutMs
    || !['passed', 'failed', 'cancelled'].includes(v.state as string) || (v.exitCode !== null && (!Number.isInteger(v.exitCode) || (v.exitCode as number) < -2147483648 || (v.exitCode as number) > 4294967295))
    || (v.state === 'passed' && v.exitCode !== 0) || !bounded(v.output, 16 * 1024) || bytes(v.output) > 16 * 1024 || typeof v.truncated !== 'boolean'
    || !commit(v.commit) || v.commit !== currentCommit || !date(v.startedAt) || !date(v.finishedAt) || Date.parse(v.finishedAt) < Date.parse(v.startedAt)) throw new Error('验收结果与配置或提交不一致')
  return { ...parsed, state: v.state as ProjectCheckResult['state'], exitCode: v.exitCode as number | null, output: v.output, truncated: v.truncated,
    commit: v.commit, startedAt: v.startedAt, finishedAt: v.finishedAt }
}
/** Persisted state is read as data. Runtime capabilities and Git ownership are rechecked before execution. */
export function decodeProjectWorkflow(value: unknown): ProjectWorkflow {
  const v = object(value)
  schema(v, ['id', 'goal', 'state', 'createdAt', 'updatedAt', 'requestDigest', 'repository', 'rules', 'tasks', 'checks', 'results', 'reviewerId', 'maxParallel',
    'skills', 'files', 'contextDigest', 'sessionHistory', 'plannerSessionId', 'plannerWorkspace', 'plannerReply', 'reviewSessionId', 'reviewWorkspace', 'reviewReply', 'review', 'integration', 'commit', 'conflicts', 'error', 'mergedAt', 'previousEvidence'], '项目流程记录')
  if (!workflowIdentifier(v.id) || !text(v.goal, 6000) || !['draft', ...WORKFLOW_ACTIVE, 'ready', 'merged', 'failed', 'cancelled', 'interrupted'].includes(v.state as string)
    || !date(v.createdAt) || !date(v.updatedAt)
    || !workflowIdentifier(v.reviewerId) || !Number.isInteger(v.maxParallel) || (v.maxParallel as number) < 1 || (v.maxParallel as number) > 3) throw new Error('项目流程记录无效')
  const parsed = parseProjectTasks(v.tasks), checks = parseProjectChecks(v.checks)
  for (const check of v.checks as unknown[]) schema(object(check), ['id', 'command', 'args', 'timeoutMs'], '验收命令')
  if (!Array.isArray(v.results) || v.results.length > checks.length || bytes(JSON.stringify(v)) > PROJECT_WORKFLOW_LIMITS.jsonBytes) throw new Error('项目流程证据无效或过大')
  const repository = repositorySnapshot(v.repository), rules = rulesSnapshot(v.rules)
  for (const name of ['requestDigest', 'contextDigest']) if (v[name] !== undefined && !digest(v[name])) throw new Error('项目流程摘要无效')
  for (const name of ['plannerSessionId', 'reviewSessionId']) if (v[name] !== undefined && !session(v[name])) throw new Error('项目流程会话标识无效')
  for (const name of ['plannerReply', 'reviewReply']) if (v[name] !== undefined && !bounded(v[name], 8192)) throw new Error('项目流程回复无效或过大')
  if (v.sessionHistory !== undefined && (!Array.isArray(v.sessionHistory) || v.sessionHistory.length > PROJECT_WORKFLOW_LIMITS.sessionHistory || v.sessionHistory.some(id => !session(id)) || new Set(v.sessionHistory).size !== v.sessionHistory.length)) throw new Error('项目历史会话标识无效')
  if ((v.error !== undefined && !bounded(v.error, 2000)) || (v.commit !== undefined && !commit(v.commit)) || (v.mergedAt !== undefined && !date(v.mergedAt))) throw new Error('项目流程执行信息无效')
  if (v.skills !== undefined && (!Array.isArray(v.skills) || v.skills.length > 4 || v.skills.some(s => typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(s)) || new Set(v.skills).size !== v.skills.length)) throw new Error('项目 Skill 列表无效')
  const files = v.files !== undefined ? fileList(v.files, 8, '项目参考文件', true) : undefined
  const conflicts = v.conflicts !== undefined ? fileList(v.conflicts, 10000, '项目冲突文件') : undefined
  const tasks = (v.tasks as unknown[]).map((value, i): ProjectTask => {
    const t = object(value); schema(t, ['id', 'title', 'instruction', 'dependsOn', 'capabilities', 'acceptanceCriteria', 'roleId', 'routingReason', 'assignment', 'state', 'sessionId', 'workspace', 'changes', 'reply', 'error'], '项目任务')
    if (!workflowIdentifier(t.roleId) || !text(t.routingReason, 2000) || !['pending', 'running', 'completed', 'failed', 'blocked', 'interrupted'].includes(t.state as string)
      || (t.assignment !== undefined && t.assignment !== 'auto' && t.assignment !== 'manual')
      || (t.sessionId !== undefined && !session(t.sessionId)) || (t.reply !== undefined && !bounded(t.reply, 8192)) || (t.error !== undefined && !bounded(t.error, 2000))) throw new Error('任务执行记录无效')
    const workspace = t.workspace !== undefined ? workspaceSnapshot(t.workspace, repository) : undefined
    const changes = t.changes !== undefined ? changesSnapshot(t.changes) : undefined
    if (workspace && workspace.taskId !== `task-${parsed[i]!.id}` && !(workspace.taskId === `deps-${parsed[i]!.id}` && t.state !== 'completed')) throw new Error('任务工作区归属无效')
    if ((t.sessionId !== undefined && !workspace) || (changes && !workspace) || (t.state === 'completed' && (!changes || !workspace || changes.status.trim()))) throw new Error('任务缺少完整的工作区或改动证据')
    return { ...parsed[i]!, roleId: t.roleId, routingReason: t.routingReason, state: t.state as ProjectTask['state'],
      ...(t.assignment !== undefined ? { assignment: t.assignment as 'auto' | 'manual' } : {}),
      ...(t.sessionId !== undefined ? { sessionId: t.sessionId as string } : {}), ...(workspace ? { workspace } : {}), ...(changes ? { changes } : {}),
      ...(t.reply !== undefined ? { reply: t.reply as string } : {}), ...(t.error !== undefined ? { error: t.error as string } : {}) }
  })
  const plannerWorkspace = v.plannerWorkspace !== undefined ? workspaceSnapshot(v.plannerWorkspace, repository) : undefined
  const reviewWorkspace = v.reviewWorkspace !== undefined ? workspaceSnapshot(v.reviewWorkspace, repository) : undefined
  const integration = v.integration !== undefined ? workspaceSnapshot(v.integration, repository, 'integration') : undefined
  if ((plannerWorkspace && !/^plan-[a-zA-Z0-9_-]+$/u.test(plannerWorkspace.taskId)) || (reviewWorkspace && !/^review(?:-[a-zA-Z0-9_-]+)?$/u.test(reviewWorkspace.taskId)) || (v.plannerSessionId !== undefined && !plannerWorkspace)
    || (v.reviewSessionId !== undefined && !reviewWorkspace) || (v.review !== undefined && reviewWorkspace && reviewWorkspace.baseCommit !== v.commit)) throw new Error('规划或评审工作区证据无效')
  const workspaces = [plannerWorkspace, reviewWorkspace, integration, ...tasks.map(task => task.workspace)].filter((w): w is ProjectWorktree => !!w)
  if (new Set(workspaces.map(w => w.runId)).size > 1 || new Set(workspaces.map(w => normalized(w.path))).size !== workspaces.length) throw new Error('工作区归属不同流程或重复')
  const results = v.results.map(result => checkResult(result, checks, v.commit))
  if (new Set(results.map(r => r.id)).size !== results.length) throw new Error('验收结果标识重复')
  let review: ProjectWorkflow['review']
  if (v.review !== undefined) {
    const r = object(v.review); schema(r, ['verdict', 'summary', 'findings', 'commit', 'roleId'], '独立评审')
    if (!['approved', 'changes_requested'].includes(r.verdict as string) || !text(r.summary, 4000) || !commit(r.commit) || r.commit !== v.commit
      || !workflowIdentifier(r.roleId) || r.roleId !== v.reviewerId || !reviewWorkspace || !v.reviewSessionId) throw new Error('独立评审证据无效')
    review = { verdict: r.verdict as 'approved' | 'changes_requested', summary: r.summary, findings: stringList(r.findings, 20, 1000, '独立评审问题'), commit: r.commit, roleId: r.roleId }
  }
  const sessions = [v.plannerSessionId, v.reviewSessionId, ...tasks.map(t => t.sessionId)].filter(s => s !== undefined)
  if (new Set(sessions).size !== sessions.length) throw new Error('项目流程会话标识重复')
  if (v.previousEvidence !== undefined) {
    if (!Array.isArray(v.previousEvidence) || v.previousEvidence.length > PROJECT_WORKFLOW_LIMITS.previousEvidence) throw new Error('项目历史证据过多')
    for (const value of v.previousEvidence) {
      const old = object(value); schema(old, ['commit', 'results', 'review', 'reviewReply', 'error', 'savedAt'], '项目历史证据')
      if ((old.commit !== undefined && !commit(old.commit)) || !date(old.savedAt) || !Array.isArray(old.results) || old.results.length > checks.length
        || (old.reviewReply !== undefined && !bounded(old.reviewReply, 8192)) || (old.error !== undefined && !bounded(old.error, 2000))) throw new Error('项目历史证据无效')
      const priorResults = old.results.map(result => checkResult(result, checks, old.commit))
      if (new Set(priorResults.map(r => r.id)).size !== priorResults.length) throw new Error('项目历史验收结果重复')
      if (old.review !== undefined) {
        const r = object(old.review); schema(r, ['verdict', 'summary', 'findings', 'commit', 'roleId'], '历史独立评审')
        if (!['approved', 'changes_requested'].includes(r.verdict as string) || !text(r.summary, 4000) || !commit(r.commit) || r.commit !== old.commit || !workflowIdentifier(r.roleId)) throw new Error('历史独立评审无效')
        stringList(r.findings, 20, 1000, '历史独立评审问题')
      }
    }
  }
  if (['ready', 'merging', 'merged'].includes(v.state as string) && (!integration || !commit(v.commit) || !checks.length || results.length !== checks.length
    || results.some(r => r.state !== 'passed' || r.exitCode !== 0) || !review || review.verdict !== 'approved' || review.findings.length
    || tasks.some(t => t.state !== 'completed' || t.roleId === v.reviewerId) || conflicts?.length || v.error)) throw new Error('项目通过状态缺少一致的测试和独立评审证据')
  if ((v.state === 'merged' && !v.mergedAt) || (v.mergedAt !== undefined && v.state !== 'merged')) throw new Error('项目合并时间与状态不一致')
  return structuredClone({ ...v, repository, rules, tasks, checks, results, ...(files ? { files } : {}), ...(conflicts ? { conflicts } : {}),
    ...(plannerWorkspace ? { plannerWorkspace } : {}), ...(reviewWorkspace ? { reviewWorkspace } : {}), ...(integration ? { integration } : {}), ...(review ? { review } : {}) }) as unknown as ProjectWorkflow
}
