/** Host half: keep DSH's native Web shell and add a same-origin Lumo control API. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { assertIdentityConfiguration, IdentityAssertionError, resolveRequestIdentity, type RequestIdentity } from './identity.ts'
import { lumoBootThemeInjection } from './boot-theme.ts'
import { registerDesktopHandoff } from './desktop-handoff.ts'
import { discoverSkillDemos, resolveSkillDemoAsset, type SkillDemo } from './skill-demos.ts'
import { allowedAssetUrl, createUpstreamDemoService, type GallerySkill, type UpstreamDemoService } from './upstream-demos.ts'
import { buildCatalog, installItem, refreshCatalog, searchCatalog, type SkillHubConfig, type SkillHubKind } from './skillhub.ts'

/** Read-only structural projection of the session-query seam. Keeping the
 * host plugin's build boundary local avoids pulling the platform contract
 * implementation (and its transitive runtime modules) into this UI package. */
interface SessionLogQuerySeam {
  queryWithStaleness(sessionRef: string, options?: { readonly liveHead?: number; readonly maxLag?: number }): Promise<
    | { readonly kind: 'fresh'; readonly records: readonly unknown[] }
    | { readonly kind: 'stale'; readonly reason: string; readonly replicaHead: number; readonly liveHead: number; readonly lag: number }
  >
}

/** Read-only browser projection of the platform KnowledgeSeam. */
interface KnowledgeQueryService {
  query(request: { realm: string; roles: string[]; text: string; topK: number; scope: 'published' | 'draft' }): Promise<Array<{ docId: string; sourceVersion: number; score: number; text: string }>>
}

/** 单机版 vault 知识源的运行态面（Local Desktop；未装配时面板走「未配置」引导）。 */
interface VaultService {
  status(): { vaultPath: string; mode: string; docCount: number; chunkCount: number; lastSyncAt: number | null; error: string | null }
  sync(): Promise<{ docs: number }>
}

/** 管理面需要的最小来源能力。它保持为运行时检测的可选扩展：Milvus
 * 只保存向量投影，不能被 UI 误当成源内容的权威存储。 */
interface KnowledgeSourceManagerService {
  listSources(realm: string): Promise<Array<{
    docId: string; realm: string; space: string; title: string; sourceVersion: number
    embeddingModel: string; chunkCount: number; updatedAt: string
  }>>
  getSource(docId: string, realm: string): Promise<{
    doc: { docId: string; realm: string; space: string; title: string; sourceVersion: number; embeddingModel: string }
    chunks: Array<{ text: string; metadata: Record<string, unknown> }>
  } | undefined>
  upsertSource(entry: {
    docId: string; realm: string; space: string; title: string
    chunks: Array<{ text: string; metadata: Record<string, unknown> }>
    expectedSourceVersion?: number
  }): Promise<{
    docId: string; realm: string; space: string; title: string; sourceVersion: number
    embeddingModel: string; chunkCount: number; updatedAt: string
  }>
  removeSource(docId: string, realm: string, expectedSourceVersion: number): Promise<void>
  rebuild(realm: string): Promise<void>
}

/** Human-safe projection of the DSH SkillRegistry; bodies and paths stay host-side. */
interface SkillRegistryService {
  snapshot(): Promise<{
    complete: boolean
    skills: Array<{
      name: string; description: string; whenToUse?: string
      invocation: { modelInvocable: boolean; userInvocable: boolean }
      source: string; provider: string
      /** 目录型 resourceBase 才有原生示例可扫；路径只在宿主侧使用，永不下发。 */
      resourceBase?: { kind: 'directory'; path: string } | { kind: 'url'; url: string } | { kind: 'opaque'; description: string }
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
  registryUrl: string
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
  /** 桌面壳指定的握手文件：装配完成后写入带 token 的 Web 入口；空串表示不是桌面形态。 */
  desktopHandoffFile: string
  /** SkillHub 目录索引文件（可空，缺失时回退到内置 seed）。 */
  skillhubCatalogFile: string
  /** SkillHub 已安装记录文件（工作区拥有的本地状态）。 */
  skillhubInstallFile: string
  /** SkillHub 技能安装根目录（仅在有 CLI 时使用）。 */
  skillhubRoot: string
  /** `skillhub` CLI 可执行名/路径；空串禁用 CLI 委派。 */
  skillhubCommand: string
  /** SkillHub API base URL. */
  skillhubApiBase: string
  /** skill-local snapshot file path. */
  skillhubSnapshotFile: string
}

export const Config: z<Config> = z.object({
  schedulerUrl: z.string(), projectsUrl: z.string(), flowsUrl: z.string(), connectorUrl: z.string(), governanceUrl: z.string(), registryUrl: z.string().default(''),
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
  desktopHandoffFile: z.string().default(''),
  skillhubCatalogFile: z.string().default('.lumo/skillhub-catalog.json'),
  skillhubInstallFile: z.string().default('.lumo/skillhub-installs.json'),
  skillhubRoot: z.string().default('.lumo/skills'),
  skillhubCommand: z.string().default('skillhub'),
  skillhubApiBase: z.string().default('https://api.skillhub.cn'),
  skillhubSnapshotFile: z.string().default('.lumo/skill-snapshot.json'),
})

type ServiceName = 'scheduler' | 'projects' | 'flows' | 'connector' | 'governance' | 'registry'
interface UpstreamResult { ok: boolean; status: number; data: unknown; error?: string }

interface PluginSummary {
  id: string
  label: string
  description: string
  surface: 'knowledge' | 'skills' | 'connectors' | 'operations' | 'account' | 'market'
  kind: 'runtime' | 'governance'
}

function base(config: Config, service: ServiceName): string {
  return {
    scheduler: config.schedulerUrl,
    projects: config.projectsUrl,
    flows: config.flowsUrl,
    connector: config.connectorUrl,
    governance: config.governanceUrl,
    registry: config.registryUrl,
  }[service].replace(/\/+$/u, '')
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
    const serviceBase = base(config, service)
    if (serviceBase === '') return { ok: false, status: 503, data: { error: `${service} 服务未配置` }, error: 'upstream_not_configured' }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(config.timeoutMs) }
    // The browser-facing routes accept JSON only. Converting the bounded Buffer
    // to text avoids coupling Node's Buffer type to the DOM fetch BodyInit.
    if (body !== undefined) init.body = body.toString('utf8')
    const response = await fetch(`${serviceBase}${path}`, init)
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

function isRealmAdmin(identity: RequestIdentity): boolean {
  return identity.roles.some(role => role === 'platform_admin' || role === 'realm_admin' || role === 'admin')
}

function sourceManager(knowledge: KnowledgeQueryService | undefined): KnowledgeSourceManagerService | undefined {
  if (knowledge === undefined || typeof knowledge !== 'object') return undefined
  const candidate = knowledge as Partial<KnowledgeSourceManagerService>
  return typeof candidate.listSources === 'function'
    && typeof candidate.getSource === 'function'
    && typeof candidate.upsertSource === 'function'
    && typeof candidate.removeSource === 'function'
    && typeof candidate.rebuild === 'function'
    ? candidate as KnowledgeSourceManagerService
    : undefined
}

function requireKnowledgeAdmin(res: ServerResponse, identity: RequestIdentity, knowledge: KnowledgeQueryService | undefined, singleMachine = false): KnowledgeSourceManagerService | undefined {
  // 单机版（Local Desktop）是单用户、无租户的 fallback 身份（realm 固定、无断言签名），
  // 角色门不适用：vault provider 本身只读（upsertSource 显式拒绝，编辑归 Obsidian 插件）。
  if (!singleMachine && !isRealmAdmin(identity)) {
    writeJson(res, 403, { error: 'knowledge source management requires realm_admin, platform_admin, or admin' })
    return undefined
  }
  const manager = sourceManager(knowledge)
  if (manager === undefined) {
    writeJson(res, 501, { error: 'knowledge source management is unavailable for the configured vector provider' })
    return undefined
  }
  return manager
}

function requiredText(body: Record<string, unknown>, field: string, maxBytes: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`${field} must be a non-empty string up to ${maxBytes} bytes`)
  }
  return value.trim()
}

function sourceChunks(body: Record<string, unknown>): Array<{ text: string; metadata: Record<string, unknown> }> {
  const value = body['chunks']
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new TypeError('chunks must contain 1 to 500 entries')
  return value.map((chunk, index) => {
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) throw new TypeError(`chunks[${index}] must be an object`)
    const record = chunk as Record<string, unknown>
    const text = requiredText(record, 'text', 64 * 1024)
    const metadata = record['metadata']
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new TypeError(`chunks[${index}].metadata must be an object`)
    return { text, metadata: metadata as Record<string, unknown> }
  })
}

function expectedSourceVersion(value: unknown, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('expectedSourceVersion must be a positive integer')
  return value as number
}

function sourceWrite(body: Record<string, unknown>, realm: string, docId?: string, requireExpectedVersion = false): {
  docId: string; realm: string; space: string; title: string
  chunks: Array<{ text: string; metadata: Record<string, unknown> }>
  expectedSourceVersion?: number
} {
  const resolvedDocID = docId ?? safeID(typeof body['docId'] === 'string' ? body['docId'] : undefined)
  if (resolvedDocID === undefined) throw new TypeError('docId is invalid')
  const space = safeID(typeof body['space'] === 'string' ? body['space'] : undefined)
  if (space === undefined) throw new TypeError('space is invalid')
  const expected = expectedSourceVersion(body['expectedSourceVersion'], requireExpectedVersion)
  return {
    docId: resolvedDocID,
    realm,
    space,
    title: requiredText(body, 'title', 512),
    chunks: sourceChunks(body),
    ...(expected === undefined ? {} : { expectedSourceVersion: expected }),
  }
}

function knowledgeManagementStatus(error: unknown): number {
  if (error instanceof RangeError) return 413
  if (error instanceof SyntaxError || error instanceof TypeError) return 400
  if (error instanceof Error && error.name === 'KnowledgeSourceConflictError') return 409
  return 502
}

function writeUpstream(res: ServerResponse, result: UpstreamResult): void {
  if (result.ok) {
    // 204 No Content 必须无 body；其余用 JSON 承载，避免 DELETE 写回 "null"。
    if (result.status === 204) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return }
    writeJson(res, result.status, result.data); return
  }
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
      const envelope = await query.queryWithStaleness(sessionRef, { ...(liveHead === undefined ? {} : { liveHead }), maxLag: 8 })
      if (envelope.kind === 'stale') return { ok: false, status: 503, body: { stale: true, reason: envelope.reason, replica_head: envelope.replicaHead, live_head: envelope.liveHead, lag: envelope.lag, message: 'session log replication is stale; report was not persisted' } }
    } catch (error) {
      return { ok: false, status: 503, body: { stale: true, reason: 'replication-lag', message: error instanceof Error ? error.message : 'session log query failed' } }
    }
  }
  return { ok: true }
}

let upstreamDemoService: UpstreamDemoService | undefined
function upstreamDemos(): UpstreamDemoService {
  return upstreamDemoService ??= createUpstreamDemoService()
}

export async function api(config: Config, knowledge: KnowledgeQueryService | undefined, skills: SkillRegistryService | undefined, sessionLogQuery: SessionLogQuerySeam | undefined, vault: VaultService | undefined, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://lumo.local').pathname
  // 单机版（Local Desktop）：vault 知识源 + fallback 身份,知识管理路由不套 realm 管理员角色门。
  const singleMachine = config.deploymentMode === 'local'
  let identity: RequestIdentity
  try {
    identity = resolveRequestIdentity(req, config)
  } catch (error) {
    if (!(error instanceof IdentityAssertionError)) throw error
    writeJson(res, 401, { error: 'unauthorized' })
    return
  }
  if (req.method === 'GET' && pathname === '/lumo/api/overview') { writeJson(res, 200, await overview(config, identity, req)); return }

  if (req.method === 'GET' && pathname === '/lumo/api/registry/artifacts') {
    if (config.deploymentMode === 'local') {
      writeJson(res, 501, { error: '本地单机没有已连接的制品注册表；只能显示运行时配置，不能声明可发现制品。' })
      return
    }
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    writeUpstream(res, await upstream(config, identity, 'registry', `/v1/artifacts${query}`, req))
    return
  }
  const registryArtifact = pathname.match(/^\/lumo\/api\/registry\/artifacts\/([^/]+)$/u)
  if (req.method === 'GET' && registryArtifact !== null) {
    if (config.deploymentMode === 'local') {
      writeJson(res, 501, { error: '本地单机没有已连接的制品注册表，无法读取历史已发布版本。' })
      return
    }
    const artifactName = safeID(registryArtifact[1])
    if (artifactName === undefined) { writeJson(res, 400, { error: 'invalid artifact id' }); return }
    writeUpstream(res, await upstream(config, identity, 'registry', `/v1/artifacts/${encodeURIComponent(artifactName)}`, req))
    return
  }
  if (req.method === 'GET' && pathname === '/lumo/api/registry/installations') {
    if (config.deploymentMode === 'local') {
      writeJson(res, 501, { error: '本地单机没有 Provisioner 节点回报；不能声明制品已经部署。' })
      return
    }
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    writeUpstream(res, await upstream(config, identity, 'registry', `/v1/installations${query}`, req))
    return
  }
  const rollout = pathname.match(/^\/lumo\/api\/registry\/rollouts(?:\/([^/]+))?$/u)
  if (rollout !== null) {
    if (config.deploymentMode === 'local') {
      writeJson(res, 501, { error: '本地单机没有已连接的制品注册表，无法读取或更新部署期望状态。' })
      return
    }
    if (req.method === 'GET' && rollout[1] === undefined) {
      writeUpstream(res, await upstream(config, identity, 'registry', '/v1/rollouts/stable', req))
      return
    }
    const artifactName = rollout[1] === undefined ? undefined : safeID(rollout[1])
    if (req.method === 'GET' && artifactName !== undefined) {
      const nodeID = new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('node_id')
      if (nodeID !== null && safeID(nodeID) === undefined) { writeJson(res, 400, { error: 'invalid node id' }); return }
      const query = nodeID === null ? '' : `?node_id=${encodeURIComponent(nodeID)}`
      writeUpstream(res, await upstream(config, identity, 'registry', `/v1/rollouts/stable/${encodeURIComponent(artifactName)}${query}`, req))
      return
    }
    if (req.method === 'PUT' && artifactName !== undefined) {
      try {
        writeUpstream(res, await upstream(config, identity, 'registry', `/v1/rollouts/stable/${encodeURIComponent(artifactName)}`, req, 'PUT', await readBody(req)))
      } catch (error) {
        writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' })
      }
      return
    }
    writeJson(res, artifactName === undefined ? 400 : 405, { error: artifactName === undefined ? 'invalid artifact id' : 'method not allowed' })
    return
  }
  if (req.method === 'POST' && pathname === '/lumo/api/registry/plan') {
    if (config.deploymentMode === 'local') {
      writeJson(res, 501, { error: '本地单机没有已连接的制品注册表，无法生成签名安装计划。' })
      return
    }
    try {
      writeUpstream(res, await upstream(config, identity, 'registry', '/v1/plan', req, 'POST', await readBody(req)))
    } catch (error) {
      writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' })
    }
    return
  }

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

  // 来源内容是源真相，读取和写入都只给 realm 管理员。不能把 query 的
  // `allowedRoles` 当成来源编辑授权：检索角色与资料治理角色是不同边界。
  if (req.method === 'GET' && pathname === '/lumo/api/knowledge/sources') {
    const manager = requireKnowledgeAdmin(res, identity, knowledge, singleMachine)
    if (manager === undefined) return
    try {
      const sources = await manager.listSources(identity.realm)
      writeJson(res, 200, { realm: identity.realm, state: 'synchronized', sources })
    } catch (error) {
      writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge sources unavailable' })
    }
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/knowledge/rebuild') {
    const manager = requireKnowledgeAdmin(res, identity, knowledge, singleMachine)
    if (manager === undefined) return
    try {
      await manager.rebuild(identity.realm)
      writeJson(res, 200, { realm: identity.realm, state: 'synchronized' })
    } catch (error) {
      writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge rebuild failed' })
    }
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/knowledge/sources') {
    const manager = requireKnowledgeAdmin(res, identity, knowledge, singleMachine)
    if (manager === undefined) return
    try {
      const summary = await manager.upsertSource(sourceWrite(await readJson(req), identity.realm))
      writeJson(res, 201, { source: summary, state: 'synchronized' })
    } catch (error) {
      writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge source was not saved' })
    }
    return
  }

  const knowledgeSource = pathname.match(/^\/lumo\/api\/knowledge\/sources\/([^/]+)$/u)
  if (knowledgeSource !== null) {
    const docID = safeID(knowledgeSource[1])
    if (docID === undefined) { writeJson(res, 400, { error: 'invalid knowledge source id' }); return }
    const manager = requireKnowledgeAdmin(res, identity, knowledge, singleMachine)
    if (manager === undefined) return
    if (req.method === 'GET') {
      try {
        const source = await manager.getSource(docID, identity.realm)
        if (source === undefined) { writeJson(res, 404, { error: 'knowledge source not found' }); return }
        writeJson(res, 200, { source, state: 'synchronized' })
      } catch (error) {
        writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge source unavailable' })
      }
      return
    }
    if (req.method === 'PUT') {
      try {
        const summary = await manager.upsertSource(sourceWrite(await readJson(req), identity.realm, docID, true))
        writeJson(res, 200, { source: summary, state: 'synchronized' })
      } catch (error) {
        writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge source was not saved' })
      }
      return
    }
    if (req.method === 'DELETE') {
      try {
        const body = await readJson(req)
        await manager.removeSource(docID, identity.realm, expectedSourceVersion(body['expectedSourceVersion'], true)!)
        writeJson(res, 200, { docId: docID, state: 'removed' })
      } catch (error) {
        writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge source was not removed' })
      }
      return
    }
  }

  if (req.method === 'GET' && pathname === '/lumo/api/skills/demos/upstream') {
    const skill = new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('skill')
    if (skill !== 'ppt-master' && skill !== 'open-design') {
      writeJson(res, 400, { error: 'skill must be ppt-master or open-design' })
      return
    }
    writeJson(res, 200, await upstreamDemos().gallery(skill satisfies GallerySkill))
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/skills/demos/upstream/asset') {
    const upstream = allowedAssetUrl(new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('url') ?? '')
    const asset = upstream === undefined ? undefined : await upstreamDemos().asset(upstream)
    if (asset === undefined) {
      writeJson(res, upstream === undefined ? 403 : 404, { error: upstream === undefined ? 'upstream host is not allowed' : 'upstream demo asset unavailable' })
      return
    }
    // 第三方仓库的 SVG 也可能带脚本：与本地示例一样沙箱化输出。
    res.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': asset.body.byteLength,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:",
    })
    res.end(asset.body)
    return
  }

  if (req.method === 'GET' && (pathname === '/lumo/api/skills/demos' || pathname === '/lumo/api/skills/demos/asset')) {
    if (skills === undefined) {
      writeJson(res, 503, { error: '本地技能 registry 尚未装配。' })
      return
    }
    let snapshot: Awaited<ReturnType<SkillRegistryService['snapshot']>>
    try { snapshot = await skills.snapshot() } catch (error) {
      writeJson(res, 502, { error: error instanceof Error ? error.message : 'skill registry unavailable' })
      return
    }
    const directories = new Map<string, string>()
    for (const skill of snapshot.skills) {
      if (skill.invocation.userInvocable && skill.resourceBase?.kind === 'directory') directories.set(skill.name, skill.resourceBase.path)
    }
    if (pathname === '/lumo/api/skills/demos') {
      const demos: Array<SkillDemo & { url: string }> = []
      for (const [skill, directory] of directories) {
        for (const demo of discoverSkillDemos(skill, directory)) {
          demos.push({ ...demo, url: `/lumo/api/skills/demos/asset?skill=${encodeURIComponent(skill)}&path=${encodeURIComponent(demo.path)}` })
        }
      }
      writeJson(res, 200, { complete: snapshot.complete, demos })
      return
    }
    const params = new URL(req.url ?? '/', 'http://lumo.local').searchParams
    const directory = directories.get(params.get('skill') ?? '')
    const asset = directory === undefined ? undefined : resolveSkillDemoAsset(directory, params.get('path') ?? '')
    if (asset === undefined) {
      writeJson(res, 404, { error: 'skill demo asset not found' })
      return
    }
    let body: Buffer
    try { body = readFileSync(asset.file) } catch {
      writeJson(res, 404, { error: 'skill demo asset not found' })
      return
    }
    // 示例来自第三方仓库：SVG/HTML 一律沙箱化，不允许它们在 Lumo 同源下执行脚本或发请求。
    res.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': body.length,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; font-src data:",
    })
    res.end(body)
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
        catalog: unavailable('治理技能目录'), effective: unavailable('跨用户技能分发'), permissions: unavailable('权限判定'),
      })
      return
    }
    const effectivePath = `/v1/users/${encodeURIComponent(identity.userId)}/effective-skills?project_id=${encodeURIComponent(identity.projectId ?? config.projectId)}`
    const projectID = identity.projectId ?? config.projectId
    const [features, departments, roles, catalog, effective, permissions] = await Promise.all([
      upstream(config, identity, 'governance', '/v1/features', req),
      upstream(config, identity, 'governance', '/v1/departments/tree', req),
      upstream(config, identity, 'governance', '/v1/roles', req),
      upstream(config, identity, 'governance', '/v1/skills', req),
      upstream(config, identity, 'governance', effectivePath, req),
      upstream(config, identity, 'governance', `/v1/effective-permissions?project_id=${encodeURIComponent(projectID)}`, req),
    ])
    writeJson(res, 200, { features, departments, roles, catalog, effective, permissions })
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/governance/skills') {
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/skills', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const governedSkillPublish = pathname.match(/^\/lumo\/api\/governance\/skills\/([^/]+)\/versions\/([^/]+)\/publish$/u)
  if (governedSkillPublish !== null) {
    const skillID = safeID(governedSkillPublish[1]); const version = safeID(governedSkillPublish[2])
    if (skillID === undefined || version === undefined) { writeJson(res, 400, { error: 'invalid skill id or version' }); return }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/skills/${encodeURIComponent(skillID)}/versions/${encodeURIComponent(version)}/publish`, req, 'POST'))
    return
  }

  const governedSkillVersions = pathname.match(/^\/lumo\/api\/governance\/skills\/([^/]+)\/versions(?:\/([^/]+))?$/u)
  if (governedSkillVersions !== null) {
    const skillID = safeID(governedSkillVersions[1]); const version = safeID(governedSkillVersions[2])
    if (skillID === undefined || (governedSkillVersions[2] !== undefined && version === undefined)) { writeJson(res, 400, { error: 'invalid skill id or version' }); return }
    const upstreamPath = `/v1/skills/${encodeURIComponent(skillID)}/versions${version === undefined ? '' : `/${encodeURIComponent(version)}`}`
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', upstreamPath, req)); return }
    if (req.method === 'POST' && version === undefined) {
      try { writeUpstream(res, await upstream(config, identity, 'governance', upstreamPath, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
  }

  if (pathname === '/lumo/api/agent-presets' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/agent-presets', req)); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/agent-presets', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const agentPreset = pathname.match(/^\/lumo\/api\/agent-presets\/([^/]+)$/u)
  if (agentPreset !== null && (req.method === 'GET' || req.method === 'PATCH')) {
    const presetID = safeID(agentPreset[1])
    if (presetID === undefined) { writeJson(res, 400, { error: 'invalid agent preset id' }); return }
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/agent-presets/${encodeURIComponent(presetID)}`, req)); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/agent-presets/${encodeURIComponent(presetID)}`, req, 'PATCH', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/workers') {
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/workers${query}`, req))
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/users') {
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users?q=${encodeURIComponent(new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('q') ?? '')}`, req)); return
  }

  const userResource = pathname.match(/^\/lumo\/api\/users\/([^/]+)$/u)
  if (req.method === 'PUT' && userResource !== null) {
    const userID = safeID(userResource[1])
    if (userID === undefined) { writeJson(res, 400, { error: 'invalid user id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users/${encodeURIComponent(userID)}`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (pathname === '/lumo/api/roles' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/roles', req)); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/roles', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (pathname === '/lumo/api/departments' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/departments/tree', req)); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/departments', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const userRole = pathname.match(/^\/lumo\/api\/users\/([^/]+)\/roles\/([^/]+)$/u)
  if (req.method === 'PUT' && userRole !== null) {
    const userID = safeID(userRole[1]); const roleID = safeID(userRole[2])
    if (userID === undefined || roleID === undefined) { writeJson(res, 400, { error: 'invalid user or role id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users/${encodeURIComponent(userID)}/roles/${encodeURIComponent(roleID)}`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
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

  const delegationCancel = pathname.match(/^\/lumo\/api\/delegations\/([^/]+)\/cancel$/u)
  if (req.method === 'POST' && delegationCancel !== null) {
    const taskID = safeID(delegationCancel[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/delegations/${encodeURIComponent(taskID)}/cancel`, req, 'POST'))
    return
  }

  const delegationRetry = pathname.match(/^\/lumo\/api\/delegations\/([^/]+)\/retry$/u)
  if (req.method === 'POST' && delegationRetry !== null) {
    const taskID = safeID(delegationRetry[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/delegations/${encodeURIComponent(taskID)}/retry`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const delegationReassign = pathname.match(/^\/lumo\/api\/delegations\/([^/]+)\/reassign$/u)
  if (req.method === 'POST' && delegationReassign !== null) {
    const taskID = safeID(delegationReassign[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/delegations/${encodeURIComponent(taskID)}/reassign`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const taskRuns = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/runs$/u)
  if (req.method === 'GET' && taskRuns !== null) {
    const taskID = safeID(taskRuns[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/tasks/${encodeURIComponent(taskID)}/runs`, req))
    return
  }

  const taskAudit = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/audit$/u)
  if (req.method === 'GET' && taskAudit !== null) {
    const taskID = safeID(taskAudit[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/tasks/${encodeURIComponent(taskID)}/audit`, req))
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

  const flowVersion = pathname.match(/^\/lumo\/api\/flows\/([^/]+)\/versions\/([1-9]\d*)$/u)
  if (req.method === 'GET' && flowVersion !== null) {
    const flowID = safeID(flowVersion[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/versions/${flowVersion[2]}`, req)); return
  }

  const flowRunReplay = pathname.match(/^\/lumo\/api\/flows\/([^/]+)\/runs\/([1-9]\d*)\/replay$/u)
  if (req.method === 'POST' && flowRunReplay !== null) {
    const flowID = safeID(flowRunReplay[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/runs/${flowRunReplay[2]}/replay`, req, 'POST')); return
  }

  const flow = pathname.match(/^\/lumo\/api\/flows\/([^/]+)(?:\/(submit|run|runs|review|target|deprecate|rollback|definition))?$/u)
  if (flow !== null) {
    const flowID = safeID(flow[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    if (req.method === 'GET' && flow[2] === undefined) { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}`, req)); return }
    if (req.method === 'PUT' && flow[2] === 'definition') {
      try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/definition`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    if (req.method === 'GET' && flow[2] === 'runs') { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/runs`, req)); return }
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
  if (automation !== null) {
    const projectID = safeID(automation[1]); const automationID = safeID(automation[2])
    if (projectID === undefined || automationID === undefined) { writeJson(res, 400, { error: 'invalid project or automation id' }); return }
    if (req.method === 'PUT') {
      try { writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/automations/${encodeURIComponent(automationID)}`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    if (req.method === 'DELETE') {
      writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/automations/${encodeURIComponent(automationID)}`, req, 'DELETE'))
      return
    }
  }

  const connectorInvoke = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)\/invoke$/u)
  if (req.method === 'POST' && connectorInvoke !== null) {
    const connectorID = safeID(connectorInvoke[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}/invoke`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  // 单机版 vault 知识源：构建状态与手动同步（仅 Local Desktop 装配该服务）。
  if (req.method === 'GET' && pathname === '/lumo/api/knowledge/vault/status') {
    if (vault === undefined) { writeJson(res, 501, { error: 'vault 知识源未装配（集群版不适用）' }); return }
    writeJson(res, 200, vault.status()); return
  }
  if (req.method === 'POST' && pathname === '/lumo/api/knowledge/vault/sync') {
    if (vault === undefined) { writeJson(res, 501, { error: 'vault 知识源未装配（集群版不适用）' }); return }
    try { writeJson(res, 200, await vault.sync()) } catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'vault sync failed' }) }
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/connectors') {
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    writeUpstream(res, await upstream(config, identity, 'connector', `/connectors${query}`, req)); return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/connector-approvals') {
    writeUpstream(res, await upstream(config, identity, 'connector', '/approvals', req)); return
  }
  const connectorApprovalDecision = pathname.match(/^\/lumo\/api\/connector-approvals\/([^/]+)\/(approve|reject)$/u)
  if (req.method === 'POST' && connectorApprovalDecision !== null) {
    const approvalID = safeID(connectorApprovalDecision[1])
    if (approvalID === undefined) { writeJson(res, 400, { error: 'invalid approval id' }); return }
    writeUpstream(res, await upstream(config, identity, 'connector', `/approvals/${encodeURIComponent(approvalID)}/${connectorApprovalDecision[2]}`, req, 'POST')); return
  }

  const connector = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)$/u)
  if (req.method === 'DELETE' && connector !== null) {
    const connectorID = safeID(connector[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}`, req, 'DELETE')); return
  }
  const connectorEnable = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)\/enable$/u)
  if (req.method === 'POST' && connectorEnable !== null) {
    const connectorID = safeID(connectorEnable[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}/enable`, req, 'POST')); return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/projects') {
    try { writeUpstream(res, await upstream(config, identity, 'projects', '/v1/projects', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'POST' && pathname === '/lumo/api/web/fetch') {
    try { writeUpstream(res, await upstream(config, identity, 'connector', '/web/fetch', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }
  // SkillHub market: catalog + install. The adapter never executes `skillhub
  // install` from an untrusted body; it only records installs (and delegates to
  // the configured CLI when present, or performs native download). Materialization
  // for the runtime goes through the snapshot bridge, not a Web request.
  const skillhubUrl = new URL(req.url ?? '/', 'http://lumo.local')
  const skillhubConfig = (): SkillHubConfig => ({
    catalogFile: resolve(config.skillhubCatalogFile ?? '.lumo/skillhub-catalog.json'),
    installFile: resolve(config.skillhubInstallFile ?? '.lumo/skillhub-installs.json'),
    root: resolve(config.skillhubRoot ?? '.lumo/skills'),
    snapshotFile: resolve(config.skillhubSnapshotFile ?? '.lumo/skill-snapshot.json'),
    apiBase: config.skillhubApiBase ?? 'https://api.skillhub.cn',
    command: config.skillhubCommand ?? 'skillhub',
    preinstalledRepositories: ['liustack/modlens', 'omdsh-dev/dsh-better-sidebar', 'NanmiCoder/dsh-agent-teams'],
  })
  // `catalog` queries SkillHub live (falling back to the on-disk cache, then the
  // seed); `catalog?cached=1` reads only local state; `refresh` is an alias that
  // always goes to the network.
  if (req.method === 'GET' && (pathname === '/lumo/api/skillhub/catalog' || pathname === '/lumo/api/skillhub/refresh')) {
    const cachedOnly = pathname === '/lumo/api/skillhub/catalog' && skillhubUrl.searchParams.get('cached') === '1'
    try { writeJson(res, 200, cachedOnly ? buildCatalog(skillhubConfig()) : await refreshCatalog(skillhubConfig())) } catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : 'skillhub catalog unavailable' }) }
    return
  }
  // Live search against SkillHub: `?kind=skill|pack|plugin&q=...&category=...&page=n` (only plugins page server-side).
  if (req.method === 'GET' && pathname === '/lumo/api/skillhub/search') {
    const kind = skillhubUrl.searchParams.get('kind') ?? 'skill'
    if (kind !== 'skill' && kind !== 'pack' && kind !== 'plugin') { writeJson(res, 400, { error: 'invalid kind' }); return }
    const q = (skillhubUrl.searchParams.get('q') ?? '').slice(0, 120)
    const category = (skillhubUrl.searchParams.get('category') ?? '').slice(0, 40)
    const limit = Number.parseInt(skillhubUrl.searchParams.get('limit') ?? '60', 10)
    const page = Number.parseInt(skillhubUrl.searchParams.get('page') ?? '1', 10)
    try { writeJson(res, 200, await searchCatalog(skillhubConfig(), { kind: kind as SkillHubKind, q, category, limit: Number.isFinite(limit) ? limit : 60, page: Number.isFinite(page) && page > 0 ? page : 1 })) } catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : 'skillhub search failed' }) }
    return
  }
  if (req.method === 'POST' && pathname === '/lumo/api/skillhub/install') {
    let body: Record<string, unknown>
    try { body = await readJson(req) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }); return }
    const kind = body['kind']; const id = body['id']
    if (kind !== 'skill' && kind !== 'pack' && kind !== 'plugin') { writeJson(res, 400, { error: 'invalid kind' }); return }
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) { writeJson(res, 400, { error: 'invalid id' }); return }
    try { writeJson(res, 200, await installItem(skillhubConfig(), kind, id)) } catch (error) { writeJson(res, error instanceof TypeError ? 400 : 502, { error: error instanceof Error ? error.message : 'install failed' }) }
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
  if (config.desktopHandoffFile !== '') registerDesktopHandoff(ctx, config.desktopHandoffFile)
  const registerRoutes = (runtimeCtx: Context): void => {
    const knowledge = runtimeCtx.get('knowledge') as KnowledgeQueryService | undefined
    const skills = runtimeCtx.get('skills') as SkillRegistryService | undefined
    const sessionLogQuery = runtimeCtx.get('sessionLogQuery') as SessionLogQuerySeam | undefined
    const vault = runtimeCtx.get('knowledgeVault') as VaultService | undefined
    if (config.deploymentMode !== 'local' && knowledge === undefined) throw new Error('lumo-platform-ui: ctx.knowledge is unavailable')
    runtimeCtx.effect(() => {
      const disposeApi = runtimeCtx.webServer.register({ kind: 'prefix', path: '/lumo/api', handler: (req, res) => api(config, knowledge, skills, sessionLogQuery, vault, req, res) })
      const disposeOps = runtimeCtx.webServer.register({ kind: 'exact', path: '/lumo/ops', handler: ops })
      return () => { disposeApi(); disposeOps() }
    }, 'lumo-platform-ui: same-origin API')
  }
  if (config.deploymentMode === 'local') registerRoutes(ctx)
  else ctx.inject(['knowledge', 'skills', 'sessionLogQuery'], registerRoutes)
}

export default apply
