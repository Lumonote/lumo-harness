/** Host half: keep DSH's native Web shell and add a same-origin Lumo control API. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionLogQuerySeam } from '../../../shared/seam-contracts/session-query.ts'

import { assertIdentityConfiguration, IdentityAssertionError, resolveRequestIdentity, type RequestIdentity } from './identity.ts'
import { lumoBootThemeInjection } from './boot-theme.ts'

/** Read-only browser projection of the platform KnowledgeSeam. */
interface KnowledgeQueryService {
  query(request: { realm: string; roles: string[]; text: string; topK: number; scope: 'published' | 'draft' }): Promise<Array<{ docId: string; sourceVersion: number; score: number; text: string }>>
}

/** Human-safe projection of the DSH SkillRegistry; bodies and paths stay host-side. */
interface SkillRegistryService {
  snapshot(): Promise<{
    complete: boolean
    skills: Array<{
      name: string; description: string; whenToUse?: string
      invocation: { modelInvocable: boolean; userInvocable: boolean }
      source: string; provider: string
    }>
  }>
}

export const name = 'lumo-platform-ui'
// Local Desktop only needs the native DSH Web server. Knowledge/governance/
// connector consumers are server-shape capabilities and are intentionally
// optional here so the local shell never pulls a control-plane dependency.
export const inject = ['webServer']

export interface Config {
  schedulerUrl: string
  projectsUrl: string
  flowsUrl: string
  connectorUrl: string
  governanceUrl: string
  realm: string
  userId: string
  roles: string[]
  projectId: string
  deptId: string
  controlPlaneToken: string
  identityAssertionSecret: string
  timeoutMs: number
  deploymentMode: 'local' | 'standalone' | 'cluster'
  storageBackend: 'sqlite' | 'postgres'
  middleware: string[]
  clusterStatus: string
  plugins: PluginSummary[]
}

export const Config: z<Config> = z.object({
  schedulerUrl: z.string(), projectsUrl: z.string(), flowsUrl: z.string(), connectorUrl: z.string(), governanceUrl: z.string(),
  realm: z.string(), userId: z.string(), roles: z.array(z.string()), projectId: z.string(), deptId: z.string(), controlPlaneToken: z.string(), identityAssertionSecret: z.string().default(''),
  timeoutMs: z.number().default(5000),
  deploymentMode: z.union(['local', 'standalone', 'cluster'] as const).default('standalone'),
  storageBackend: z.union(['sqlite', 'postgres'] as const).default('postgres'),
  middleware: z.array(z.string()).default([]),
  clusterStatus: z.string().default('not_ready'),
  plugins: z.array(z.object({
    id: z.string(), label: z.string(), description: z.string(),
    surface: z.union(['knowledge', 'skills', 'connectors', 'operations', 'account', 'market'] as const),
    kind: z.union(['runtime', 'governance'] as const),
  })).default([]),
})

type ServiceName = 'scheduler' | 'projects' | 'flows' | 'connector' | 'governance'
interface UpstreamResult { ok: boolean; status: number; data: unknown; error?: string }

interface PluginSummary {
  id: string
  label: string
  description: string
  surface: 'knowledge' | 'skills' | 'connectors' | 'operations' | 'account' | 'market'
  kind: 'runtime' | 'governance'
}

function base(config: Config, service: ServiceName): string {
  return { scheduler: config.schedulerUrl, projects: config.projectsUrl, flows: config.flowsUrl, connector: config.connectorUrl, governance: config.governanceUrl }[service].replace(/\/+$/u, '')
}

function identityHeaders(config: Config, identity: RequestIdentity): Record<string, string> {
  return {
    Authorization: `Bearer ${config.controlPlaneToken}`,
    'X-Lumo-User': identity.userId,
    'X-Lumo-Realm': identity.realm,
    'X-Lumo-Roles': identity.roles.join(','),
    ...(identity.projectId === undefined ? {} : { 'X-Lumo-Project': identity.projectId }),
    ...(identity.deptId === undefined ? {} : { 'X-Lumo-Dept': identity.deptId }),
  }
}

async function upstream(config: Config, identity: RequestIdentity, service: ServiceName, path: string, req: IncomingMessage, method = 'GET', body?: Buffer): Promise<UpstreamResult> {
  const headers: Record<string, string> = {
    ...identityHeaders(config, identity),
    ...(body === undefined ? {} : { 'content-type': req.headers['content-type']?.toString() || 'application/json' }),
  }
  try {
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(config.timeoutMs) }
    // The browser-facing routes accept JSON only. Converting the bounded Buffer
    // to text avoids coupling Node's Buffer type to the DOM fetch BodyInit.
    if (body !== undefined) init.body = body.toString('utf8')
    const response = await fetch(`${base(config, service)}${path}`, init)
    const text = await response.text()
    let data: unknown = null
    try { data = text === '' ? null : JSON.parse(text) } catch { data = text }
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error instanceof Error ? error.message : String(error) }
  }
}

async function overview(config: Config, identity: RequestIdentity, req: IncomingMessage): Promise<Record<string, unknown>> {
  if (config.deploymentMode === 'local') {
    return {
      generatedAt: new Date().toISOString(),
      deployment: {
        mode: 'local', label: '本地单机', storage: 'sqlite', middleware: [],
        distributed: false, desktop: true, clusterReady: false, clusterOnly: false,
      },
      services: {},
      cluster: { nodes: [] },
      projects: [],
      flows: [],
      connectors: [],
      plugins: config.plugins,
    }
  }
  const results = await Promise.all([
    upstream(config, identity, 'scheduler', '/healthz', req), upstream(config, identity, 'scheduler', '/v1/leader', req), upstream(config, identity, 'scheduler', '/v1/nodes', req),
    upstream(config, identity, 'projects', '/healthz', req), upstream(config, identity, 'projects', '/v1/projects', req),
    upstream(config, identity, 'flows', '/healthz', req), upstream(config, identity, 'flows', '/v1/flows', req),
    upstream(config, identity, 'connector', '/healthz', req), upstream(config, identity, 'connector', '/connectors', req),
    upstream(config, identity, 'governance', '/healthz', req),
  ])
  const [schedulerHealth, leader, nodes, projectsHealth, projects, flowsHealth, flows, connectorHealth, connectors, governanceHealth] = results
  return {
    generatedAt: new Date().toISOString(),
    deployment: {
      mode: config.deploymentMode,
      label: config.deploymentMode === 'cluster' ? '服务器集群' : '服务器单例',
      storage: config.storageBackend,
      middleware: config.middleware,
      distributed: config.deploymentMode === 'cluster',
      desktop: false,
      clusterReady: config.deploymentMode === 'cluster' && config.clusterStatus.toLowerCase() === 'ready',
      clusterOnly: config.deploymentMode === 'cluster',
    },
    services: { scheduler: schedulerHealth, projects: projectsHealth, flows: flowsHealth, connector: connectorHealth, governance: governanceHealth },
    cluster: { leader: leader.data, nodes: (nodes.data as { nodes?: unknown[] } | null)?.nodes ?? [] },
    projects: (projects.data as { projects?: unknown[] } | null)?.projects ?? [],
    flows: (flows.data as { flows?: unknown[] } | null)?.flows ?? [],
    connectors: (connectors.data as { connectors?: unknown[] } | null)?.connectors ?? [],
    // The launcher passes its effective patch rows here. This is configuration
    // state, not a health assertion: service reachability stays in `services`.
    plugins: config.plugins,
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += chunk.length
    if (bytes > 1<<20) throw new RangeError('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req)
  try {
    const value: unknown = JSON.parse(body.toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('JSON object required')
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof RangeError) throw error
    throw new SyntaxError('invalid JSON body')
  }
}

function safeID(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) return undefined
  return value
}

function writeUpstream(res: ServerResponse, result: UpstreamResult): void {
  if (result.ok) { writeJson(res, result.status, result.data); return }
  const upstreamError = typeof result.data === 'object' && result.data !== null ? result.data : undefined
  writeJson(res, result.status || 502, upstreamError ?? { error: result.error || 'upstream unavailable' })
}

function upstreamErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const value = (body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback
}

function reportSessionRefs(body: Record<string, unknown>): string[] {
  const refs = new Set<string>()
  if (!Array.isArray(body['sections'])) return []
  for (const section of body['sections']) {
    if (typeof section !== 'object' || section === null || !Array.isArray((section as Record<string, unknown>)['evidence'])) continue
    for (const evidence of (section as Record<string, unknown>)['evidence'] as unknown[]) {
      if (typeof evidence !== 'object' || evidence === null) continue
      const ref = (evidence as Record<string, unknown>)['session_ref']
      if (typeof ref === 'string' && ref.trim() !== '') refs.add(ref.trim())
    }
  }
  return [...refs]
}

async function ensureFreshReportEvidence(query: SessionLogQuerySeam | undefined, body: Record<string, unknown>, req: IncomingMessage): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const refs = reportSessionRefs(body)
  if (refs.length === 0) return { ok: true }
  if (query === undefined) return { ok: false, status: 503, body: { stale: true, reason: 'replication-lag', message: 'sessionLogQuery 未装配，拒绝写入无新鲜度证明的报告' } }
  const url = new URL(req.url ?? '/', 'http://lumo.local')
  const rawLiveHead = url.searchParams.get('live_head')
  const liveHead = rawLiveHead === null ? undefined : Number(rawLiveHead)
  if (liveHead !== undefined && (!Number.isSafeInteger(liveHead) || liveHead < 0)) return { ok: false, status: 400, body: { error: 'live_head must be a non-negative integer' } }
  for (const sessionRef of refs) {
    try {
      const envelope = await query.queryWithStaleness(sessionRef, { liveHead, maxLag: 8 })
      if (envelope.kind === 'stale') return { ok: false, status: 503, body: { stale: true, reason: envelope.reason, replica_head: envelope.replicaHead, live_head: envelope.liveHead, lag: envelope.lag, message: 'session log replication is stale; report was not persisted' } }
    } catch (error) {
      return { ok: false, status: 503, body: { stale: true, reason: 'replication-lag', message: error instanceof Error ? error.message : 'session log query failed' } }
    }
  }
  return { ok: true }
}

async function api(config: Config, knowledge: KnowledgeQueryService | undefined, skills: SkillRegistryService | undefined, sessionLogQuery: SessionLogQuerySeam | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://lumo.local').pathname
  let identity: RequestIdentity
  try {
    identity = resolveRequestIdentity(req, config)
  } catch (error) {
    if (!(error instanceof IdentityAssertionError)) throw error
    writeJson(res, 401, { error: 'unauthorized' })
    return
  }
  if (req.method === 'GET' && pathname === '/lumo/api/overview') { writeJson(res, 200, await overview(config, identity, req)); return }

  const placement = pathname.match(/^\/lumo\/api\/scheduler\/placements(?:\/([^/]+))?$/u)
  if (placement !== null) {
    const taskID = placement[1] === undefined ? undefined : safeID(placement[1])
    if (placement[1] !== undefined && taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    if (req.method === 'GET' && taskID !== undefined) {
      writeUpstream(res, await upstream(config, identity, 'scheduler', `/v1/placements/${encodeURIComponent(taskID)}`, req)); return
    }
    if (req.method === 'POST' && taskID === undefined) {
      try { writeUpstream(res, await upstream(config, identity, 'scheduler', '/v1/placements', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
  }

  if (req.method === 'POST' && pathname === '/lumo/api/scheduler/reconcile') {
    try { writeUpstream(res, await upstream(config, identity, 'scheduler', '/v1/reconcile', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/knowledge/query') {
    if (knowledge === undefined) {
      writeJson(res, 501, { error: '本地单机不提供语义知识库；请连接服务器单例或服务器集群。' })
      return
    }
    try {
      const body = await readJson(req)
      const text = typeof body['text'] === 'string' ? body['text'].trim() : ''
      if (text.length === 0 || text.length > 2_000) { writeJson(res, 400, { error: '检索问题长度应为 1–2000 字符' }); return }
      const requestedTopK = typeof body['topK'] === 'number' && Number.isInteger(body['topK']) ? body['topK'] : 8
      const hits = await knowledge.query({ realm: identity.realm, roles: identity.roles, text, topK: Math.min(Math.max(requestedTopK, 1), 20), scope: 'published' })
      writeJson(res, 200, { query: text, scope: 'published', hits })
    } catch (error) {
      const status = error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 502
      writeJson(res, status, { error: error instanceof Error ? error.message : 'knowledge query failed' })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/skills') {
    if (skills === undefined) {
      writeJson(res, 503, { error: '本地技能 registry 尚未装配。' })
      return
    }
    try {
      const snapshot = await skills.snapshot()
      writeJson(res, 200, {
        complete: snapshot.complete,
        skills: snapshot.skills.map(skill => ({
          name: skill.name, description: skill.description, whenToUse: skill.whenToUse,
          invocation: skill.invocation, source: skill.source, provider: skill.provider,
        })),
      })
    } catch (error) {
      writeJson(res, 502, { error: error instanceof Error ? error.message : 'skill registry unavailable' })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/governance') {
    if (config.deploymentMode === 'local') {
      const unavailable = (capability: string): UpstreamResult => ({ ok: false, status: 501, data: { error: `本地单机不提供${capability}；请连接服务器形态。` }, error: 'local_capability_unavailable' })
      writeJson(res, 200, {
        features: unavailable('治理策略'), departments: unavailable('组织目录'), roles: unavailable('角色目录'),
        catalog: unavailable('治理技能目录'), effective: unavailable('跨用户技能分发'),
      })
      return
    }
    const effectivePath = `/v1/users/${encodeURIComponent(identity.userId)}/effective-skills?project_id=${encodeURIComponent(identity.projectId ?? config.projectId)}`
    const [features, departments, roles, catalog, effective] = await Promise.all([
      upstream(config, identity, 'governance', '/v1/features', req),
      upstream(config, identity, 'governance', '/v1/departments/tree', req),
      upstream(config, identity, 'governance', '/v1/roles', req),
      upstream(config, identity, 'governance', '/v1/skills', req),
      upstream(config, identity, 'governance', effectivePath, req),
    ])
    writeJson(res, 200, { features, departments, roles, catalog, effective })
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/governance/skills') {
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/skills', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/users') {
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users?q=${encodeURIComponent(new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('q') ?? '')}`, req)); return
  }

  const userTags = pathname.match(/^\/lumo\/api\/users\/([^/]+)\/tags$/u)
  if (userTags !== null && (req.method === 'GET' || req.method === 'PUT')) {
    const userID = safeID(userTags[1])
    if (userID === undefined) { writeJson(res, 400, { error: 'invalid user id' }); return }
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users/${encodeURIComponent(userID)}/tags`, req)); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users/${encodeURIComponent(userID)}/tags`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/delegations/preview') {
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/delegations/preview', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const taskReport = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/report$/u)
  if (taskReport !== null && (req.method === 'GET' || req.method === 'POST')) {
    const taskID = safeID(taskReport[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    if (!new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('project_id')) { writeJson(res, 400, { error: 'project_id is required for report authorization' }); return }
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/tasks/${encodeURIComponent(taskID)}/report${query}`, req)); return }
    try {
      const body = await readBody(req)
      const parsed = JSON.parse(body.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SyntaxError('invalid report body')
      const fresh = await ensureFreshReportEvidence(sessionLogQuery, parsed as Record<string, unknown>, req)
      if (!fresh.ok) { writeJson(res, fresh.status, fresh.body); return }
      writeUpstream(res, await upstream(config, identity, 'projects', `/v1/tasks/${encodeURIComponent(taskID)}/report${query}`, req, 'POST', body))
    } catch (error) { writeJson(res, error instanceof RangeError ? 413 : 400, { error: error instanceof Error ? error.message : 'invalid report body' }) }
    return
  }

  const taskReportConfirm = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/report\/confirm$/u)
  if (req.method === 'POST' && taskReportConfirm !== null) {
    const taskID = safeID(taskReportConfirm[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    if (!new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('project_id')) { writeJson(res, 400, { error: 'project_id is required for report authorization' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/tasks/${encodeURIComponent(taskID)}/report/confirm${query}`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const reportConfirm = pathname.match(/^\/lumo\/api\/reports\/([^/]+)\/confirm$/u)
  if (req.method === 'POST' && reportConfirm !== null) {
    const reportID = safeID(reportConfirm[1])
    if (reportID === undefined) { writeJson(res, 400, { error: 'invalid report id' }); return }
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    if (!new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('project_id')) { writeJson(res, 400, { error: 'project_id is required for report authorization' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/reports/${encodeURIComponent(reportID)}/confirm${query}`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const delegationStatus = pathname.match(/^\/lumo\/api\/delegations\/([^/]+)\/status$/u)
  if (req.method === 'POST' && delegationStatus !== null) {
    const taskID = safeID(delegationStatus[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/delegations/${encodeURIComponent(taskID)}/status`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const delegation = pathname.match(/^\/lumo\/api\/delegations(?:\/([^/]+))?$/u)
  if (delegation !== null && (req.method === 'GET' || req.method === 'POST')) {
    const taskID = delegation[1] === undefined ? undefined : safeID(delegation[1])
    if (delegation[1] !== undefined && taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    if (req.method === 'GET') {
      const query = new URL(req.url ?? '/', 'http://lumo.local').search
      writeUpstream(res, await upstream(config, identity, 'governance', `/v1/delegations${taskID === undefined ? query : `/${encodeURIComponent(taskID)}`}`, req)); return
    }
    try {
      const body = await readBody(req)
      const created = await upstream(config, identity, 'governance', '/v1/delegations', req, 'POST', body)
      if (!created.ok) { writeUpstream(res, created); return }
      const payload = (() => { try { const value: unknown = JSON.parse(body.toString('utf8')); return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {} } catch { return {} } })()
      const createdData = typeof created.data === 'object' && created.data !== null ? created.data as Record<string, unknown> : {}
      const task = typeof createdData.task === 'object' && createdData.task !== null ? createdData.task as { id?: unknown } : createdData as { id?: unknown }
      const taskIDValue = typeof task.id === 'string' ? safeID(task.id) : undefined
      const schedule = typeof payload.schedule === 'object' && payload.schedule !== null ? payload.schedule as Record<string, unknown> : undefined
      // New governance owns placement and returns {task, run}. Keep the old
      // proxy-side placement only for older governance nodes, otherwise a UI
      // request would create two scheduler placements for one business task.
      const governanceCreatedRun = typeof createdData.run === 'object' && createdData.run !== null
      if (!governanceCreatedRun && taskIDValue !== undefined && schedule !== undefined) {
        const scheduledBody = Buffer.from(JSON.stringify({
          task_id: taskIDValue,
          cluster_id: typeof schedule.cluster_id === 'string' ? schedule.cluster_id : '',
          requires: Array.isArray(schedule.requires) ? schedule.requires : [],
          priority: typeof schedule.priority === 'number' ? schedule.priority : 0,
          residency: typeof schedule.residency === 'string' ? schedule.residency : '',
          deadline_ms: typeof schedule.deadline_ms === 'number' ? schedule.deadline_ms : 0,
          queue: typeof schedule.queue === 'string' ? schedule.queue : 'delegated',
          weight: typeof schedule.weight === 'number' ? schedule.weight : 1,
          avoid_nodes: Array.isArray(schedule.avoid_nodes) ? schedule.avoid_nodes : [],
        }))
        const scheduled = await upstream(config, identity, 'scheduler', '/v1/placements', req, 'POST', scheduledBody)
        const scheduledData = typeof scheduled.data === 'object' && scheduled.data !== null ? scheduled.data as { node_id?: unknown } : {}
        const statusBody = Buffer.from(JSON.stringify(scheduled.ok
          ? { state: scheduled.status === 202 ? 'QUEUED' : 'QUEUED', scheduler_task_id: taskIDValue, assigned_node_id: typeof scheduledData.node_id === 'string' ? scheduledData.node_id : '' }
          : { state: 'BLOCKED', last_error: upstreamErrorMessage(scheduled.data, scheduled.error ?? 'scheduler unavailable') }))
        const status = await upstream(config, identity, 'governance', `/v1/delegations/${encodeURIComponent(taskIDValue)}/status`, req, 'POST', statusBody)
        if (status.ok) { writeUpstream(res, { ...created, data: status.data }); return }
      }
      writeUpstream(res, created)
    } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const dashboard = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/dashboard$/u)
  if (req.method === 'GET' && dashboard !== null) {
    const projectID = safeID(dashboard[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/dashboard`, req)); return
  }

  const flow = pathname.match(/^\/lumo\/api\/flows\/([^/]+)(?:\/(submit|run|review|target|deprecate|rollback|definition))?$/u)
  if (flow !== null) {
    const flowID = safeID(flow[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    if (req.method === 'GET' && flow[2] === undefined) { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}`, req)); return }
    if (req.method === 'PUT' && flow[2] === 'definition') {
      try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/definition`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    if (req.method === 'POST' && flow[2] !== undefined) {
      try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/${flow[2]}`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
  }

  const projectFlow = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/flows$/u)
  if (req.method === 'POST' && projectFlow !== null) {
    const projectID = safeID(projectFlow[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/projects/${encodeURIComponent(projectID)}/flows`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const projectLifecycle = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/(archive|unarchive)$/u)
  if (req.method === 'POST' && projectLifecycle !== null) {
    const projectID = safeID(projectLifecycle[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/${projectLifecycle[2]}`, req, 'POST')); return
  }

  const projectResource = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/(members|artifacts|spaces|automations|usage)$/u)
  if (projectResource !== null) {
    const projectID = safeID(projectResource[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    const resource = projectResource[2]
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/${resource}`, req)); return }
    if (req.method === 'POST' && resource === 'spaces') {
      try { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/spaces`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
  }

  const automation = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/automations\/([^/]+)$/u)
  if (req.method === 'PUT' && automation !== null) {
    const projectID = safeID(automation[1]); const automationID = safeID(automation[2])
    if (projectID === undefined || automationID === undefined) { writeJson(res, 400, { error: 'invalid project or automation id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/automations/${encodeURIComponent(automationID)}`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const connectorInvoke = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)\/invoke$/u)
  if (req.method === 'POST' && connectorInvoke !== null) {
    const connectorID = safeID(connectorInvoke[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}/invoke`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const connector = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)$/u)
  if (req.method === 'DELETE' && connector !== null) {
    const connectorID = safeID(connector[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}`, req, 'DELETE')); return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/projects') {
    try { writeUpstream(res, await upstream(config, identity, 'projects', '/v1/projects', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/web/fetch') {
    try { writeUpstream(res, await upstream(config, identity, 'connector', '/web/fetch', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  res.setHeader('allow', 'GET, POST, PUT, DELETE')
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return }
  writeJson(res, 404, { error: 'unknown_lumo_endpoint' })
}

function ops(_req: IncomingMessage, res: ServerResponse): void { res.writeHead(302, { location: '/?lumo=operations' }); res.end() }

export function apply(ctx: Context, config: Config): void {
  assertIdentityConfiguration(config)
  // 预插件区间的深色引导。放在 registerRoutes 之外、inject 门之前：主题与
  // knowledge/skills 是否装配无关，任何形态下白底闪一帧都不可接受。
  ctx.on('webserver/index-inject', (table) => { table.push(lumoBootThemeInjection()) })
  const registerRoutes = (runtimeCtx: Context): void => {
    const knowledge = runtimeCtx.get('knowledge') as KnowledgeQueryService | undefined
    const skills = runtimeCtx.get('skills') as SkillRegistryService | undefined
    const sessionLogQuery = runtimeCtx.get('sessionLogQuery') as SessionLogQuerySeam | undefined
    if (config.deploymentMode !== 'local' && knowledge === undefined) throw new Error('lumo-platform-ui: ctx.knowledge is unavailable')
    runtimeCtx.effect(() => {
      const disposeApi = runtimeCtx.webServer.register({ kind: 'prefix', path: '/lumo/api', handler: (req, res) => api(config, knowledge, skills, sessionLogQuery, req, res) })
      const disposeOps = runtimeCtx.webServer.register({ kind: 'exact', path: '/lumo/ops', handler: ops })
      return () => { disposeApi(); disposeOps() }
    }, 'lumo-platform-ui: same-origin API')
  }
  if (config.deploymentMode === 'local') registerRoutes(ctx)
  else ctx.inject(['knowledge', 'skills', 'sessionLogQuery'], registerRoutes)
}

export default apply
