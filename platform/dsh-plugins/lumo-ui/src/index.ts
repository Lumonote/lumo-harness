/** Host half: keep DSH's native Web shell and add a same-origin Lumo control API. */
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { assertIdentityConfiguration, IdentityAssertionError, resolveRequestIdentity, type RequestIdentity } from './identity.ts'
import { lumoBootThemeInjection } from './boot-theme.ts'
import { registerDesktopHandoff } from './desktop-handoff.ts'
import { discoverSkillDemos, resolveSkillDemoAsset, type SkillDemo } from './skill-demos.ts'
import { allowedAssetUrl, createUpstreamDemoService, type GallerySkill, type UpstreamDemoService } from './upstream-demos.ts'
import { loadCatalog, installItem, searchCatalog, type SkillHubConfig, type SkillHubKind } from './skillhub.ts'
import { registerSkillHubRuntime, type SkillHubRuntime } from './skillhub-runtime.ts'
import { LocalAssetError, LocalAssetStore } from './local-assets.ts'

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
  query(request: { realm: string; roles: string[]; userId?: string; libraryAdmin?: boolean; text: string; topK: number; scope: 'published' | 'draft' }): Promise<Array<{ docId: string; sourceVersion: number; score: number; text: string }>>
}

interface KnowledgeLibraryManagerService {
  listLibraryFolders(realm: string, userId: string, roles: string[], isAdmin: boolean): Promise<Array<{ folderId: string; realm: string; parentId: string | null; name: string; ownerUserId: string; createdAt: string }>>
  canAccessLibraryFolder(input: { realm: string; folderId: string; userId: string; roles: string[]; isAdmin: boolean; access?: 'viewer' | 'editor' }): Promise<boolean>
  createLibraryFolder(input: { realm: string; parentId: string | null; name: string; ownerUserId: string; roles: string[]; isAdmin: boolean }): Promise<{ folderId: string; realm: string; parentId: string | null; name: string; ownerUserId: string; createdAt: string }>
  deleteLibraryFolder(input: { realm: string; folderId: string; actorUserId: string; roles: string[]; isAdmin: boolean }): Promise<void>
  listLibraryFiles(realm: string, userId: string, roles: string[], isAdmin: boolean): Promise<LibraryFileInfo[]>
  getLibraryFile(docId: string, realm: string): Promise<LibraryFileInfo | undefined>
  createLibraryFile(file: LibraryFileInfo): Promise<void>
  removeLibraryFile(docId: string, realm: string): Promise<void>
  canAccessLibraryFile(input: { docId: string; realm: string; userId: string; roles: string[]; isAdmin: boolean; access?: 'viewer' | 'editor' }): Promise<boolean>
  setLibraryGrants(input: { realm: string; resourceType: 'folder' | 'file'; resourceId: string; actorUserId: string; roles: string[]; isAdmin: boolean; grants: Array<{ type: 'user' | 'role'; id: string; access: 'viewer' | 'editor' }> }): Promise<void>
  listLibraryGrants(realm: string, resourceType: 'folder' | 'file', resourceId: string): Promise<Array<{ type: 'user' | 'role'; id: string; access: 'viewer' | 'editor' }>>
  getSource(docId: string, realm: string): Promise<{ chunks: Array<{ text: string; metadata: Record<string, unknown> }> } | undefined>
  upsertSource(entry: { docId: string; realm: string; space: string; title: string; chunks: Array<{ text: string; metadata: Record<string, unknown> }> }): Promise<unknown>
}

interface LibraryFileInfo {
  docId: string; realm: string; folderId: string | null; filename: string; mimeType: string
  objectKey: string; byteSize: number; sha256: string; ownerUserId: string
  extractionState: 'pending' | 'ready' | 'failed' | 'unsupported'
  ocrState: 'not_needed' | 'pending' | 'ready' | 'failed' | 'unavailable'; createdAt: string
}

interface ObjectStoreService {
  putContent(realm: string, body: Buffer | string, contentType?: string): Promise<string>
  get(realm: string, key: string): Promise<{ body: Buffer; contentType?: string } | undefined>
}

interface OfficeToPdfService {
  convert(request: {
    extension: 'docx' | 'pptx'
    priority: 'foreground'
    source: {
      key: string
      version: string
      bytes: number
      read(signal: AbortSignal, maxBytes: number): Promise<{ bytes: Uint8Array; version: string }>
    }
  }, signal?: AbortSignal): Promise<{ pdf: Uint8Array; missingFonts: string[] }>
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
  llmGatewayUrl?: string
  usageLedgerUrl?: string
  edgeGatewayUrl?: string
  terminalGatewayUrl?: string
  /** 会话控制面（§8.4.3 的 Session Console 后端）。空串 = 本部署没接线，控制台面返回 503。 */
  sessionControlUrl: string
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
  llmGatewayUrl: z.string().default(''), usageLedgerUrl: z.string().default(''),
  edgeGatewayUrl: z.string().default(''), terminalGatewayUrl: z.string().default(''),
  // 有缺省（空串）**不是**给 localhost 兜底：空串是「本部署没有这个服务」的显式标记，
  // 路由据此回 503。若这里放一个 http://127.0.0.1:8092 之类的值，一个没接线的部署会去
  // 连本机端口，症状变成「控制面连不上」——排查方向指向网络，而真实原因是这个部署没接线。
  // 同一条规矩见 `dsh-plugins/control` 的 LUMO_SESSION_CONTROL_URL。
  sessionControlUrl: z.string().default(''),
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

type ServiceName = 'scheduler' | 'projects' | 'flows' | 'connector' | 'governance' | 'registry' | 'session-control' | 'llm-gateway' | 'usage-ledger' | 'edge-gateway' | 'terminal-gateway'
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
    'session-control': config.sessionControlUrl,
    'llm-gateway': config.llmGatewayUrl ?? '',
    'usage-ledger': config.usageLedgerUrl ?? '',
    'edge-gateway': config.edgeGatewayUrl ?? '',
    'terminal-gateway': config.terminalGatewayUrl ?? '',
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

async function upstream(config: Config, identity: RequestIdentity, service: ServiceName, path: string, req: IncomingMessage, method = 'GET', body?: Buffer, contentType?: string): Promise<UpstreamResult> {
  const headers: Record<string, string> = {
    ...identityHeaders(config, identity),
    ...(body === undefined ? {} : { 'content-type': contentType ?? req.headers['content-type']?.toString() ?? 'application/json' }),
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

const TASK_ARTIFACT_GIT_LIMIT = 512 * 1024
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u
const GIT_REPOSITORY = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,8}$/u

async function invokeGitConnector(
  config: Config, identity: RequestIdentity, req: IncomingMessage, connectorID: 'github' | 'gitlab',
  operation: string, pathParams: Record<string, string>, query?: Record<string, string>, body?: Record<string, unknown>,
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify({ operation, pathParams, ...(query ? { query } : {}), ...(body ? { body } : {}), correlationId: `task-artifact-${Date.now()}` }), 'utf8')
  const result = await upstream(config, identity, 'connector', `/connectors/${connectorID}/invoke`, req, 'POST', payload, 'application/json')
  if (!result.ok) {
    const detail = typeof result.data === 'object' && result.data !== null && typeof (result.data as { error?: unknown }).error === 'string'
      ? (result.data as { error: string }).error : result.error ?? 'connector gateway rejected the request'
    throw new Error(`${connectorID} 连接器调用失败 (${result.status || 502})：${detail}`)
  }
  const response = result.data as { status?: unknown; body?: unknown } | null
  if (response === null || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) {
    const code = typeof response?.status === 'number' ? response.status : 502
    const detail = typeof response?.body === 'string' ? response.body : JSON.stringify(response?.body ?? {})
    throw new Error(`${connectorID} API 返回 ${code}：${detail.slice(0, 600)}`)
  }
  return response.body
}

function gitObjectString(value: unknown, path: string): string {
  let current: unknown = value
  for (const key of path.split('.')) current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined
  if (typeof current !== 'string' || current === '') throw new Error(`Git 服务没有返回 ${path}`)
  return current
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
    upstream(config, identity, 'registry', '/healthz', req),
    upstream(config, identity, 'session-control', '/healthz', req),
    upstream(config, identity, 'llm-gateway', '/healthz', req),
    upstream(config, identity, 'usage-ledger', '/healthz', req),
    upstream(config, identity, 'edge-gateway', '/healthz', req),
    upstream(config, identity, 'terminal-gateway', '/healthz', req),
  ])
  const [schedulerHealth, leader, nodes, projectsHealth, projects, flowsHealth, flows, connectorHealth, connectors, governanceHealth,
    registryHealth, sessionControlHealth, llmGatewayHealth, usageLedgerHealth, edgeGatewayHealth, terminalGatewayHealth] = results
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
    services: {
      scheduler: schedulerHealth, projects: projectsHealth, flows: flowsHealth, connector: connectorHealth,
      governance: governanceHealth, registry: registryHealth, 'session-control': sessionControlHealth,
      'llm-gateway': llmGatewayHealth, 'usage-ledger': usageLedgerHealth,
      'edge-gateway': edgeGatewayHealth, 'terminal-gateway': terminalGatewayHealth,
    },
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

async function readBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += chunk.length
    if (bytes > maxBytes) throw new RangeError('request body too large')
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

function isPlatformAdmin(identity: RequestIdentity): boolean {
  return identity.roles.includes('platform_admin')
}

// 控制面认的角色是**闭集**，写在 `platform/deploy/policies/session-control.rego` 的
// `commands` 表里：platform_admin / realm_admin / admin / approver / operator。
//
// 按权限从高到低取第一个被认出的角色，而不是 `identity.roles[0]`：只主张一个角色，
// 取到的若是治理侧的 `owner`，控制面会回「角色未被授予该指令」，而这个人其实还持有
// `realm_admin`——一个本可放行的指令被角色**顺序**挡掉，症状是「同一个人有时能按有时不能」。
// admin 同时包含 operator 与 approver 的全部指令，所以它排在两者之前。
const CONTROL_ROLES = ['platform_admin', 'realm_admin', 'admin', 'approver', 'operator'] as const
function controlRole(identity: RequestIdentity): string | undefined {
  return CONTROL_ROLES.find(role => identity.roles.includes(role))
}

function requireClusterReady(config: Config, res: ServerResponse): boolean {
  if (config.deploymentMode === 'cluster' && config.clusterStatus.toLowerCase() === 'ready') return true
  writeJson(res, 403, { error: 'CLUSTER_ONLY', message: '该功能仅在就绪的集群模式可用' })
  return false
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

function knowledgeLibrary(knowledge: KnowledgeQueryService | undefined): KnowledgeLibraryManagerService | undefined {
  if (knowledge === undefined || typeof knowledge !== 'object') return undefined
  const candidate = knowledge as Partial<KnowledgeLibraryManagerService>
  const methods: Array<keyof KnowledgeLibraryManagerService> = [
    'listLibraryFolders', 'canAccessLibraryFolder', 'createLibraryFolder', 'deleteLibraryFolder',
    'listLibraryFiles', 'getLibraryFile', 'createLibraryFile', 'removeLibraryFile', 'canAccessLibraryFile',
    'setLibraryGrants', 'listLibraryGrants', 'getSource', 'upsertSource',
  ]
  return methods.every(method => typeof candidate[method] === 'function')
    ? candidate as KnowledgeLibraryManagerService : undefined
}

function requireKnowledgeLibrary(res: ServerResponse, knowledge: KnowledgeQueryService | undefined): KnowledgeLibraryManagerService | undefined {
  const manager = knowledgeLibrary(knowledge)
  if (manager === undefined) {
    writeJson(res, 501, { error: '当前资料库 Provider 不支持文件目录管理；请使用 PostgreSQL 权威资料库。' })
    return undefined
  }
  return manager
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

function libraryGrants(body: Record<string, unknown>): Array<{ type: 'user' | 'role'; id: string; access: 'viewer' | 'editor' }> {
  const value = body['grants']
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('grants 必须是最多 200 项的数组')
  const seen = new Set<string>()
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new TypeError(`grants[${index}] 格式无效`)
    const row = entry as Record<string, unknown>
    const type = row['type']; const id = typeof row['id'] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(row['id']) ? row['id'] : undefined; const access = row['access']
    if ((type !== 'user' && type !== 'role') || id === undefined || (access !== 'viewer' && access !== 'editor')) throw new TypeError(`grants[${index}] 分享对象、ID 或权限无效`)
    const key = `${type}:${id}`
    if (seen.has(key)) throw new TypeError(`分享对象重复：${key}`)
    seen.add(key)
    return { type, id, access }
  })
}

function libraryEntities(header: string | undefined): string[] {
  if (header === undefined || header === '') return []
  if (header.length > 8_192) throw new TypeError('知识图谱实体标签过长')
  let value: unknown
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(header)) throw new Error('invalid base64')
    const decoded = Buffer.from(header, 'base64')
    if (decoded.toString('base64') !== header) throw new Error('invalid base64')
    value = JSON.parse(decoded.toString('utf8'))
  } catch { throw new TypeError('知识图谱实体标签格式无效') }
  if (!Array.isArray(value) || value.length > 50) throw new TypeError('最多添加 50 个知识图谱实体标签')
  const entities: string[] = []
  const seen = new Set<string>()
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== 'string') throw new TypeError(`知识图谱实体标签 ${index + 1} 格式无效`)
    const entity = candidate.trim()
    if (entity === '' || Buffer.byteLength(entity, 'utf8') > 128 || /[\u0000-\u001f\u007f]/u.test(entity)) throw new TypeError(`知识图谱实体标签 ${index + 1} 无效`)
    if (!seen.has(entity)) { seen.add(entity); entities.push(entity) }
  }
  return entities
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
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505') return 409
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23503') return 409
  if (error instanceof Error && (error.name === 'SeamError' || error.name === 'RemoteSeamError') && 'code' in error) {
    switch ((error as Error & { code?: unknown }).code) {
      case 'forbidden': return 403
      case 'invalid': return 400
      case 'capability_unavailable': return 501
      case 'timeout': return 504
      case 'unavailable': return 503
    }
  }
  return 502
}

const executeFile = promisify(execFile)
const LIBRARY_UPLOAD_LIMIT = 50 * 1024 * 1024
const OFFICE_TEXT_EXTRACTOR = String.raw`
import sys, zipfile, xml.etree.ElementTree as ET
path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    infos = archive.infolist()
    if len(infos) > 1000 or sum(item.file_size for item in infos) > 80 * 1024 * 1024:
        raise ValueError('office archive expands beyond the extraction limit')
    names = set(archive.namelist())
    def texts(name):
        root = ET.fromstring(archive.read(name))
        return [item.text or '' for item in root.iter() if item.tag.rsplit('}', 1)[-1] in ('t', 'v')]
    if 'word/document.xml' in names:
        selected = ['word/document.xml']
    elif 'ppt/presentation.xml' in names:
        selected = sorted((n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml')), key=lambda n: int(''.join(c for c in n.rsplit('slide',1)[-1][:-4] if c.isdigit()) or '0'))
    elif 'xl/workbook.xml' in names:
        selected = sorted(n for n in names if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'))
        shared = texts('xl/sharedStrings.xml') if 'xl/sharedStrings.xml' in names else []
        values = []
        for name in selected:
            root = ET.fromstring(archive.read(name))
            for row in root.iter():
                if row.tag.rsplit('}', 1)[-1] != 'row': continue
                cells = []
                for cell in list(row):
                    if cell.tag.rsplit('}', 1)[-1] != 'c': continue
                    kind = cell.attrib.get('t')
                    value = next((child.text or '' for child in list(cell) if child.tag.rsplit('}', 1)[-1] in ('v','t')), '')
                    if kind == 's' and value.isdigit() and int(value) < len(shared): value = shared[int(value)]
                    cells.append(value)
                if cells: values.append('\t'.join(cells))
        print('\n'.join(values))
        raise SystemExit(0)
    else:
        raise ValueError('unsupported Office document')
    output = []
    for name in selected:
        output.extend(texts(name))
    print('\n'.join(value for value in output if value))
`

function safeUploadFilename(value: string | undefined): string {
  if (value === undefined || value.length > 1024) throw new TypeError('请提供有效的文件名')
  let decoded = value
  try { decoded = decodeURIComponent(value) } catch { throw new TypeError('文件名编码无效') }
  const filename = basename(decoded.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  if (filename === '' || Buffer.byteLength(filename, 'utf8') > 240 || filename === '.' || filename === '..') throw new TypeError('文件名无效')
  return filename
}

function libraryMimeType(filename: string): string | undefined {
  const ext = extname(filename).toLowerCase()
  const known: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return known[ext]
}

async function runDocumentCommand(command: string, args: string[], timeout: number, maxBuffer = 5 * 1024 * 1024): Promise<string> {
  const result = await executeFile(command, args, { timeout, maxBuffer, encoding: 'utf8' })
  return result.stdout
}

async function extractLibraryText(filename: string, mimeType: string, body: Buffer): Promise<{
  text: string; extractionState: LibraryFileInfo['extractionState']; ocrState: LibraryFileInfo['ocrState']
}> {
  const ext = extname(filename).toLowerCase()
  if (['.txt', '.log', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml'].includes(ext)) {
    const text = body.toString('utf8').replace(/^\uFEFF/u, '').trim()
    return text ? { text, extractionState: 'ready', ocrState: 'not_needed' } : { text: '', extractionState: 'failed', ocrState: 'not_needed' }
  }

  const directory = await mkdtemp(join(tmpdir(), 'lumo-library-'))
  const inputPath = join(directory, `document${ext || '.bin'}`)
  try {
    await writeFile(inputPath, body, { mode: 0o600 })
    if (mimeType === 'application/pdf') {
      let text = ''
      try { text = (await runDocumentCommand('pdftotext', ['-layout', '-enc', 'UTF-8', inputPath, '-'], 30_000)).trim() }
      catch { /* 扫描版/无可提取文本时继续尝试 OCR */ }
      if (text.length >= 20) return { text, extractionState: 'ready', ocrState: 'not_needed' }
      const prefix = join(directory, 'page')
      try {
        await runDocumentCommand('pdftoppm', ['-f', '1', '-l', '20', '-scale-to', '2200', '-jpeg', inputPath, prefix], 60_000, 2 * 1024 * 1024)
        const pages = (await readdir(directory)).filter(name => /^page-\d+\.jpg$/u.test(name)).sort((left, right) => Number(left.match(/\d+/u)?.[0]) - Number(right.match(/\d+/u)?.[0]))
        if (pages.length === 0) return { text: '', extractionState: 'failed', ocrState: 'failed' }
        const recognized: string[] = []
        for (const page of pages) recognized.push((await runDocumentCommand('tesseract', [join(directory, page), 'stdout', '-l', 'chi_sim+eng', '--psm', '3'], 60_000, 2 * 1024 * 1024)).trim())
        const scannedText = recognized.filter(Boolean).join('\n\n').trim()
        return scannedText ? { text: scannedText, extractionState: 'ready', ocrState: 'ready' } : { text: '', extractionState: 'failed', ocrState: 'failed' }
      } catch (error) {
        return { text: '', extractionState: 'failed', ocrState: isMissingExecutable(error) ? 'unavailable' : 'failed' }
      }
    }
    if (mimeType.startsWith('image/')) {
      try {
        const text = (await runDocumentCommand('tesseract', [inputPath, 'stdout', '-l', 'chi_sim+eng', '--psm', '3'], 60_000, 4 * 1024 * 1024)).trim()
        return text ? { text, extractionState: 'ready', ocrState: 'ready' } : { text: '', extractionState: 'failed', ocrState: 'failed' }
      } catch (error) {
        return { text: '', extractionState: 'failed', ocrState: isMissingExecutable(error) ? 'unavailable' : 'failed' }
      }
    }
    if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      try {
        const text = (await runDocumentCommand('python3', ['-c', OFFICE_TEXT_EXTRACTOR, inputPath], 30_000)).trim()
        return text ? { text, extractionState: 'ready', ocrState: 'not_needed' } : { text: '', extractionState: 'failed', ocrState: 'not_needed' }
      } catch {
        return { text: '', extractionState: 'failed', ocrState: 'not_needed' }
      }
    }
    return { text: '', extractionState: 'unsupported', ocrState: 'not_needed' }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function documentChunks(text: string, filename: string, mimeType: string, entities: string[] = []): Array<{ text: string; metadata: Record<string, unknown> }> {
  const maxChars = 5_000
  const blocks = text.replaceAll('\r\n', '\n').split(/\n{2,}|\f/u).map(part => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const block of blocks) {
    let remaining = block
    while (remaining.length > maxChars) {
      if (current) { chunks.push(current); current = '' }
      chunks.push(remaining.slice(0, maxChars))
      remaining = remaining.slice(maxChars)
    }
    if (current.length + remaining.length + 2 > maxChars && current) { chunks.push(current); current = '' }
    current = current ? `${current}\n\n${remaining}` : remaining
  }
  if (current) chunks.push(current)
  if (chunks.length > 500) throw new RangeError('文件提取文本过长，当前单文件索引上限为 250 万字符')
  return chunks.map((chunk, index) => ({ text: chunk, metadata: { filename, mimeType, chunkIndex: index, libraryFile: true, ...(entities.length === 0 ? {} : { entities }) } }))
}

function publicLibraryFile(file: LibraryFileInfo): Omit<LibraryFileInfo, 'objectKey' | 'sha256'> {
  return {
    docId: file.docId, realm: file.realm, folderId: file.folderId, filename: file.filename, mimeType: file.mimeType,
    byteSize: file.byteSize, ownerUserId: file.ownerUserId, extractionState: file.extractionState, ocrState: file.ocrState,
    createdAt: file.createdAt,
  }
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

function writeLocalAssetError(res: ServerResponse, error: unknown): void {
  const status = error instanceof LocalAssetError ? error.status
    : error instanceof RangeError ? 413
      : error instanceof SyntaxError ? 400 : 500
  writeJson(res, status, { error: error instanceof Error ? error.message : '本地资产操作失败。' })
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

/**
 * `ctx.agentTeams` 里本服务用得上的那一部分。
 *
 * 声明成窄接口而不是 import 插件类型：两者都是 dsh 公开面（`ctx.provide('agentTeams')`），
 * 而窄接口让路由可以拿一个假服务直接测——本层唯一有风险的地方是「取哪些字段、怎么拼」，
 * 而不是「dsh 会不会按契约把它注进来」。
 */
interface AgentTeamsService {
  list(): Promise<Array<{ id: string; name: string; topology: string; captainSessionId: string }>>
  status(teamId: string): Promise<{
    team: {
      id: string; name: string; topology: string; captainSessionId: string
      members: Array<{ name: string; role?: string; model?: string; provider: string; status: string; ownerUserId?: string }>
      tasks: Array<{ id: string; subject: string; status: string; assignee?: string; dependencies: string[] }>
    }
    progress: { total: number; pending: number; active: number; completed: number; failed: number; cancelled: number; ready: string[]; blocked: string[] }
    settled: boolean
  }>
}

export async function api(config: Config, knowledge: KnowledgeQueryService | undefined, skills: SkillRegistryService | undefined, sessionLogQuery: SessionLogQuerySeam | undefined, vault: VaultService | undefined, req: IncomingMessage, res: ServerResponse, skillhubRuntime?: SkillHubRuntime, agentTeams?: AgentTeamsService, objectStore?: ObjectStoreService, officeToPdf?: OfficeToPdfService): Promise<void> {
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
  const localAssets = config.deploymentMode === 'local'
    ? new LocalAssetStore(join(dirname(resolve(config.skillhubInstallFile ?? '.lumo/skillhub-installs.json')), 'local-assets.json'), resolve(config.skillhubRoot ?? '.lumo/skills'))
    : undefined
  if (req.method === 'GET' && pathname === '/lumo/api/overview') { writeJson(res, 200, await overview(config, identity, req)); return }

  if (req.method === 'GET' && pathname === '/lumo/api/capabilities') {
    writeJson(res, 200, {
      clusterReady: config.deploymentMode === 'cluster' && config.clusterStatus.toLowerCase() === 'ready',
      organization: config.deploymentMode === 'cluster' && config.clusterStatus.toLowerCase() === 'ready' && isRealmAdmin(identity),
      sharedRuntimeInstall: config.deploymentMode !== 'cluster' || isRealmAdmin(identity),
    })
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/scheduler/clusters') {
    if (!isPlatformAdmin(identity)) { writeJson(res, 403, { error: '仅平台管理员可查看全局调度集群注册表' }); return }
    if (config.deploymentMode === 'local') { writeJson(res, 501, { error: '本地单机没有调度集群注册表' }); return }
    writeUpstream(res, await upstream(config, identity, 'scheduler', '/v1/clusters', req))
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/ops/token-usage') {
    if (!isPlatformAdmin(identity)) { writeJson(res, 403, { error: '平台 Token 用量仅对平台管理员开放' }); return }
    if ((config.usageLedgerUrl ?? '').trim() === '') { writeJson(res, 503, { error: 'usage-ledger 服务未配置，暂时无法读取 Token 用量' }); return }
    const params = new URL(req.url ?? '/', 'http://lumo.local').searchParams
    const fromValues = params.getAll('from')
    const toValues = params.getAll('to')
    if (fromValues.length > 1 || toValues.length > 1) { writeJson(res, 400, { error: 'from 与 to 各只能提供一次' }); return }
    const validDate = (value: string | null): value is string => {
      if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
      const parsed = new Date(`${value}T00:00:00.000Z`)
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    }
    const today = new Date().toISOString().slice(0, 10)
    const to = toValues[0] ?? today
    const toDate = validDate(to) ? new Date(`${to}T00:00:00.000Z`) : undefined
    const defaultFromDate = toDate === undefined ? undefined : new Date(toDate.getTime() - 6 * 24 * 60 * 60 * 1000)
    const from = fromValues[0] ?? defaultFromDate?.toISOString().slice(0, 10) ?? ''
    if (!validDate(from) || !validDate(to)) { writeJson(res, 400, { error: '日期必须使用有效的 YYYY-MM-DD 格式' }); return }
    const start = new Date(`${from}T00:00:00.000Z`).getTime()
    const end = new Date(`${to}T00:00:00.000Z`).getTime()
    const days = Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1
    if (days < 1 || days > 90) { writeJson(res, 400, { error: 'Token 用量查询范围需为 1–90 天' }); return }
    const query = new URLSearchParams({ from, to })
    writeUpstream(res, await upstream(config, identity, 'usage-ledger', `/v1/usage/tokens?${query.toString()}`, req))
    return
  }

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
      const hits = await knowledge.query({ realm: identity.realm, roles: identity.roles, userId: identity.userId, libraryAdmin: isRealmAdmin(identity), text, topK: Math.min(Math.max(requestedTopK, 1), 20), scope: 'published' })
      writeJson(res, 200, { query: text, scope: 'published', hits })
    } catch (error) {
      const status = knowledgeManagementStatus(error)
      writeJson(res, status, { error: error instanceof Error ? error.message : 'knowledge query failed' })
    }
    return
  }

  const libraryFoldersPath = '/lumo/api/knowledge/library/folders'
  if (req.method === 'GET' && libraryFoldersPath === pathname) {
    const manager = requireKnowledgeLibrary(res, knowledge)
    if (manager === undefined) return
    try { writeJson(res, 200, { folders: await manager.listLibraryFolders(identity.realm, identity.userId, identity.roles, isRealmAdmin(identity)) }) }
    catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '资料文件夹不可用' }) }
    return
  }
  if (req.method === 'POST' && libraryFoldersPath === pathname) {
    const manager = requireKnowledgeLibrary(res, knowledge)
    if (manager === undefined) return
    try {
      const body = await readJson(req)
      const parentId = body['parentId'] === null || body['parentId'] === undefined ? null : safeID(typeof body['parentId'] === 'string' ? body['parentId'] : undefined)
      if (body['parentId'] !== null && body['parentId'] !== undefined && parentId === undefined) throw new TypeError('parentId 无效')
      if (parentId !== null && !isRealmAdmin(identity) && !await manager.canAccessLibraryFolder({ realm: identity.realm, folderId: parentId, userId: identity.userId, roles: identity.roles, isAdmin: false, access: 'editor' })) {
        writeJson(res, 403, { error: '没有在此资料文件夹中创建子目录的权限' }); return
      }
      const folder = await manager.createLibraryFolder({
        realm: identity.realm, parentId, name: requiredText(body, 'name', 240), ownerUserId: identity.userId,
        roles: identity.roles, isAdmin: isRealmAdmin(identity),
      })
      writeJson(res, 201, { folder })
    } catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '资料文件夹未创建' }) }
    return
  }

  const libraryFolder = pathname.match(/^\/lumo\/api\/knowledge\/library\/folders\/([^/]+)(?:\/(shares))?$/u)
  if (libraryFolder !== null) {
    const folderId = safeID(libraryFolder[1])
    if (folderId === undefined) { writeJson(res, 400, { error: '资料文件夹 ID 无效' }); return }
    const manager = requireKnowledgeLibrary(res, knowledge)
    if (manager === undefined) return
    const isAdmin = isRealmAdmin(identity)
    if (libraryFolder[2] === 'shares') {
      if (!await manager.canAccessLibraryFolder({ realm: identity.realm, folderId, userId: identity.userId, roles: identity.roles, isAdmin, access: 'editor' })) {
        writeJson(res, 403, { error: '没有管理此资料文件夹分享的权限' }); return
      }
      if (req.method === 'GET') {
        try { writeJson(res, 200, { grants: await manager.listLibraryGrants(identity.realm, 'folder', folderId) }) }
        catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '分享权限读取失败' }) }
        return
      }
      if (req.method === 'PUT') {
        try { await manager.setLibraryGrants({ realm: identity.realm, resourceType: 'folder', resourceId: folderId, actorUserId: identity.userId, roles: identity.roles, isAdmin, grants: libraryGrants(await readJson(req)) }); writeJson(res, 200, { folderId, state: 'shared' }) }
        catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '分享权限未保存' }) }
        return
      }
      writeJson(res, 405, { error: 'method not allowed' }); return
    }
    if (req.method === 'DELETE') {
      try { await manager.deleteLibraryFolder({ realm: identity.realm, folderId, actorUserId: identity.userId, roles: identity.roles, isAdmin }); writeJson(res, 200, { folderId, state: 'removed' }) }
      catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '资料文件夹未删除' }) }
      return
    }
  }

  const libraryFilesPath = '/lumo/api/knowledge/library/files'
  if (req.method === 'GET' && libraryFilesPath === pathname) {
    const manager = requireKnowledgeLibrary(res, knowledge)
    if (manager === undefined) return
    try { writeJson(res, 200, { files: (await manager.listLibraryFiles(identity.realm, identity.userId, identity.roles, isRealmAdmin(identity))).map(publicLibraryFile) }) }
    catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '资料文件读取失败' }) }
    return
  }
  if (req.method === 'POST' && libraryFilesPath === pathname) {
    const manager = requireKnowledgeLibrary(res, knowledge)
    if (manager === undefined) return
    if (objectStore === undefined) { writeJson(res, 501, { error: '对象存储未装配，无法上传资料文件' }); return }
    const params = new URL(req.url ?? '/', 'http://lumo.local').searchParams
    const folderValue = params.get('folder_id')
    const folderId = folderValue === null ? null : safeID(folderValue)
    if (folderValue !== null && folderId === undefined) { writeJson(res, 400, { error: '资料文件夹 ID 无效' }); return }
    if (folderId !== null && !await manager.canAccessLibraryFolder({ realm: identity.realm, folderId, userId: identity.userId, roles: identity.roles, isAdmin: isRealmAdmin(identity), access: 'editor' })) {
      writeJson(res, 403, { error: '没有在此资料文件夹中上传资料的权限' }); return
    }
    try {
      const filename = safeUploadFilename(typeof req.headers['x-lumo-file-name'] === 'string' ? req.headers['x-lumo-file-name'] : undefined)
      const mimeType = libraryMimeType(filename)
      if (mimeType === undefined) { writeJson(res, 415, { error: '支持 PDF、常见图片、TXT、Markdown、CSV、JSON、HTML、XML、YAML、DOCX、XLSX、PPTX 文件' }); return }
      const body = await readBody(req, LIBRARY_UPLOAD_LIMIT)
      if (body.length === 0) { writeJson(res, 400, { error: '上传文件不能为空' }); return }
      const entitiesHeader = req.headers['x-lumo-library-entities']
      if (entitiesHeader !== undefined && typeof entitiesHeader !== 'string') throw new TypeError('知识图谱实体标签格式无效')
      const entities = libraryEntities(typeof entitiesHeader === 'string' ? entitiesHeader : undefined)
      const extracted = await extractLibraryText(filename, mimeType.split(';', 1)[0]!, body)
      const chunks = extracted.text === '' ? [] : documentChunks(extracted.text, filename, mimeType, entities)
      const docId = `file-${randomUUID()}`
      const objectKey = await objectStore.putContent(identity.realm, body, mimeType)
      const file: LibraryFileInfo = {
        docId, realm: identity.realm, folderId, filename, mimeType, objectKey, byteSize: body.length,
        sha256: createHash('sha256').update(body).digest('hex'), ownerUserId: identity.userId,
        extractionState: extracted.extractionState, ocrState: extracted.ocrState, createdAt: new Date().toISOString(),
      }
      await manager.createLibraryFile(file)
      try {
        if (chunks.length > 0) await manager.upsertSource({ docId, realm: identity.realm, space: 'library', title: filename, chunks })
      } catch (error) {
        await manager.removeLibraryFile(docId, identity.realm)
        throw error
      }
      writeJson(res, 201, { file: publicLibraryFile(file), indexed: extracted.text !== '' })
    } catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '资料文件未上传' }) }
    return
  }

  const libraryFile = pathname.match(/^\/lumo\/api\/knowledge\/library\/files\/([^/]+)(?:\/(preview|content|shares))?$/u)
  if (libraryFile !== null) {
    const docId = safeID(libraryFile[1])
    if (docId === undefined) { writeJson(res, 400, { error: '资料文件 ID 无效' }); return }
    const manager = requireKnowledgeLibrary(res, knowledge)
    if (manager === undefined) return
    const file = await manager.getLibraryFile(docId, identity.realm)
    if (file === undefined) { writeJson(res, 404, { error: '资料文件不存在' }); return }
    const isAdmin = isRealmAdmin(identity)
    const route = libraryFile[2]
    if (route === 'shares') {
      if (!await manager.canAccessLibraryFile({ docId, realm: identity.realm, userId: identity.userId, roles: identity.roles, isAdmin, access: 'editor' })) { writeJson(res, 403, { error: '没有管理此资料文件分享的权限' }); return }
      if (req.method === 'GET') {
        try { writeJson(res, 200, { grants: await manager.listLibraryGrants(identity.realm, 'file', docId) }) }
        catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '分享权限读取失败' }) }
        return
      }
      if (req.method === 'PUT') {
        try { await manager.setLibraryGrants({ realm: identity.realm, resourceType: 'file', resourceId: docId, actorUserId: identity.userId, roles: identity.roles, isAdmin, grants: libraryGrants(await readJson(req)) }); writeJson(res, 200, { docId, state: 'shared' }) }
        catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : '分享权限未保存' }) }
        return
      }
      writeJson(res, 405, { error: 'method not allowed' }); return
    }
    if (req.method !== 'GET' || route === undefined) { writeJson(res, 405, { error: 'method not allowed' }); return }
    if (!await manager.canAccessLibraryFile({ docId, realm: identity.realm, userId: identity.userId, roles: identity.roles, isAdmin, access: 'viewer' })) { writeJson(res, 403, { error: '没有查看此资料文件的权限' }); return }
    if (objectStore === undefined) { writeJson(res, 501, { error: '对象存储未装配，无法读取资料文件' }); return }
    try {
      const stored = await objectStore.get(identity.realm, file.objectKey)
      if (stored === undefined) { writeJson(res, 404, { error: '资料文件对象不存在' }); return }
      const extension = extname(file.filename).toLowerCase()
      if (route === 'preview' && (extension === '.docx' || extension === '.pptx')) {
        if (officeToPdf === undefined) { writeJson(res, 503, { error: 'DSH Office 预览服务当前不可用' }); return }
        if (stored.body.length !== file.byteSize || createHash('sha256').update(stored.body).digest('hex') !== file.sha256) {
          writeJson(res, 409, { error: '资料文件内容已变化，请刷新文件列表后重试' }); return
        }
        const controller = new AbortController()
        const cancelIfDisconnected = (): void => { if (!res.writableEnded) controller.abort(new Error('Preview request disconnected')) }
        req.once('aborted', cancelIfDisconnected)
        res.once('close', cancelIfDisconnected)
        try {
          const rendered = await officeToPdf.convert({
            extension: extension.slice(1) as 'docx' | 'pptx', priority: 'foreground',
            source: {
              key: `knowledge-library:${identity.realm}:${docId}:${file.sha256}`,
              version: file.sha256, bytes: stored.body.length,
              read: async (signal, maxBytes) => {
                signal.throwIfAborted()
                if (stored.body.length > maxBytes) return { bytes: stored.body.subarray(0, maxBytes + 1), version: file.sha256 }
                return { bytes: stored.body, version: file.sha256 }
              },
            },
          }, controller.signal)
          if (controller.signal.aborted) return
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename.replace(/\.(docx|pptx)$/iu, '.pdf'))}`,
            'content-length': String(rendered.pdf.byteLength), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          })
          res.end(rendered.pdf)
        } catch (error) {
          if (controller.signal.aborted) return
          const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'failed'
          const message = code === 'input-too-large' ? 'Office 文件超过预览大小限制。'
            : code === 'unavailable' ? 'DSH Office 预览服务当前不可用。'
              : code === 'busy' ? 'Office 预览任务较多，请稍后重试。'
                : 'Office 文件无法转换为预览，请检查文件内容。'
          const status = code === 'input-too-large' ? 413 : code === 'unavailable' || code === 'busy' ? 503 : 422
          writeJson(res, status, { error: message })
        } finally {
          req.removeListener('aborted', cancelIfDisconnected)
          res.removeListener('close', cancelIfDisconnected)
        }
        return
      }
      const isDownload = route === 'content' && new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('download') === '1'
      const safeInline = route === 'preview' && (file.mimeType === 'application/pdf' || file.mimeType.startsWith('image/') || extension === '.xlsx')
      res.writeHead(200, {
        'content-type': isDownload ? 'application/octet-stream' : safeInline ? file.mimeType : 'text/plain; charset=utf-8',
        'content-disposition': `${isDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'content-length': String(stored.body.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      })
      res.end(stored.body)
    } catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : '资料文件读取失败' }) }
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
    let manager: KnowledgeSourceManagerService | undefined
    if (req.method === 'GET' && !singleMachine && !isRealmAdmin(identity)) {
      const library = knowledgeLibrary(knowledge)
      if (library === undefined) { writeJson(res, 403, { error: 'knowledge source management requires realm_admin, platform_admin, or admin' }); return }
      try {
        const file = await library.getLibraryFile(docID, identity.realm)
        if (file === undefined || !await library.canAccessLibraryFile({ docId: docID, realm: identity.realm, userId: identity.userId, roles: identity.roles, isAdmin: false })) {
          writeJson(res, 404, { error: 'knowledge source not found' }); return
        }
        manager = sourceManager(knowledge)
        if (manager === undefined) { writeJson(res, 501, { error: 'knowledge source content is unavailable' }); return }
      } catch (error) { writeJson(res, knowledgeManagementStatus(error), { error: error instanceof Error ? error.message : 'knowledge source unavailable' }); return }
    } else {
      manager = requireKnowledgeAdmin(res, identity, knowledge, singleMachine)
      if (manager === undefined) return
    }
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
      const localSkills = localAssets?.listSkills(identity) ?? []
      writeJson(res, 200, {
        local: true,
        features: unavailable('治理策略'), departments: unavailable('组织目录'), roles: unavailable('角色目录'),
        catalog: { ok: true, status: 200, data: { skills: localSkills } },
        effective: { ok: true, status: 200, data: { skills: localSkills } }, permissions: unavailable('权限判定'),
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
    if (localAssets !== undefined) {
      try {
        const created = localAssets.createSkill(identity, await readJson(req))
        await skillhubRuntime?.refresh()
        writeJson(res, 201, created)
      } catch (error) { writeLocalAssetError(res, error) }
      return
    }
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/skills', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const governedSkill = pathname.match(/^\/lumo\/api\/governance\/skills\/([^/]+)$/u)
  if (governedSkill !== null && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const skillID = safeID(governedSkill[1])
    if (skillID === undefined) { writeJson(res, 400, { error: 'invalid skill id' }); return }
    if (localAssets === undefined) { writeJson(res, 405, { error: 'method not allowed' }); return }
    try {
      if (req.method === 'DELETE') {
        localAssets.deleteSkill(identity, skillID)
        await skillhubRuntime?.refresh()
        res.writeHead(204, { 'cache-control': 'no-store' }); res.end()
      } else {
        const updated = localAssets.updateSkill(identity, skillID, await readJson(req))
        await skillhubRuntime?.refresh()
        writeJson(res, 200, updated)
      }
    } catch (error) { writeLocalAssetError(res, error) }
    return
  }

  const skillAccess = pathname.match(/^\/lumo\/api\/governance\/skills\/([^/]+)\/(access|grants|revocations)(?:\/([^/]+))?$/u)
  if (skillAccess !== null) {
    if (!requireClusterReady(config, res)) return
    const skillID = safeID(skillAccess[1]); const accessID = skillAccess[3] === undefined ? undefined : safeID(skillAccess[3])
    if (skillID === undefined || (skillAccess[3] !== undefined && accessID === undefined)) { writeJson(res, 400, { error: 'invalid skill access id' }); return }
    const path = `/v1/skills/${encodeURIComponent(skillID)}/${skillAccess[2]}${accessID ? `/${encodeURIComponent(accessID)}` : ''}`
    if (req.method === 'GET' && skillAccess[2] === 'access' && !accessID) { writeUpstream(res, await upstream(config, identity, 'governance', path, req)); return }
    if (req.method === 'DELETE' && skillAccess[2] !== 'access' && accessID) { writeUpstream(res, await upstream(config, identity, 'governance', path, req, 'DELETE')); return }
    if (req.method === 'POST' && skillAccess[2] !== 'access' && !accessID) {
      try { writeUpstream(res, await upstream(config, identity, 'governance', path, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    writeJson(res, 405, { error: 'method not allowed' }); return
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
    if (localAssets !== undefined) {
      try {
        if (req.method === 'GET' && version !== undefined) writeJson(res, 200, localAssets.getSkillVersion(identity, skillID, version))
        else if (req.method === 'POST' && version === undefined) {
          const created = localAssets.createSkillVersion(identity, skillID, await readJson(req))
          await skillhubRuntime?.refresh()
          writeJson(res, 201, created)
        } else writeJson(res, 405, { error: 'method not allowed' })
      } catch (error) { writeLocalAssetError(res, error) }
      return
    }
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', upstreamPath, req)); return }
    if (req.method === 'POST' && version === undefined) {
      try { writeUpstream(res, await upstream(config, identity, 'governance', upstreamPath, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
  }

  if (pathname === '/lumo/api/agent-presets' && (req.method === 'GET' || req.method === 'POST')) {
    if (localAssets !== undefined) {
      try {
        if (req.method === 'GET') writeJson(res, 200, { agent_presets: localAssets.listAgentPresets(identity), local: true })
        else writeJson(res, 201, localAssets.createAgentPreset(identity, await readJson(req)))
      } catch (error) { writeLocalAssetError(res, error) }
      return
    }
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/agent-presets', req)); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/agent-presets', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const agentPreset = pathname.match(/^\/lumo\/api\/agent-presets\/([^/]+)$/u)
  if (agentPreset !== null && (req.method === 'GET' || req.method === 'PATCH' || req.method === 'DELETE')) {
    const presetID = safeID(agentPreset[1])
    if (presetID === undefined) { writeJson(res, 400, { error: 'invalid agent preset id' }); return }
    if (localAssets !== undefined) {
      try {
        if (req.method === 'GET') {
          const preset = localAssets.listAgentPresets(identity).find(item => item.id === presetID)
          if (preset === undefined) throw new LocalAssetError(404, '找不到该专家。')
          writeJson(res, 200, preset)
        } else if (req.method === 'PATCH') writeJson(res, 200, localAssets.updateAgentPreset(identity, presetID, await readJson(req)))
        else { localAssets.deleteAgentPreset(identity, presetID); res.writeHead(204, { 'cache-control': 'no-store' }); res.end() }
      } catch (error) { writeLocalAssetError(res, error) }
      return
    }
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/agent-presets/${encodeURIComponent(presetID)}`, req)); return }
    if (req.method === 'DELETE') { writeJson(res, 405, { error: 'method not allowed' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/agent-presets/${encodeURIComponent(presetID)}`, req, 'PATCH', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  if (req.method === 'GET' && pathname === '/lumo/api/workers') {
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/workers${query}`, req))
    return
  }

  // 协作空间：把 dsh 的团队名册交给客户端，**这里不做拼接**。
  //
  // 员工、注册节点、任务上下游都已经各有各的面（`/lumo/api/users`、`/desktop-nodes`、
  // `/delegations`），本路由只补 `agentTeams` 这一块。拼接——按成员上的 `ownerUserId`
  // 把它挂到对应员工下面——是一个纯函数，放在客户端，于是它能被单测直接断言；
  // 在服务端造一个聚合端点只会多出一处「两边字段一起改」的地方。
  if (req.method === 'GET' && pathname === '/lumo/api/collaboration/teams') {
    if (agentTeams === undefined) {
      // 缺席要说成缺席。回一个空列表读起来是「没有团队」——那是一个结论，
      // 而这个部署可能只是没装 agent-teams。
      writeJson(res, 503, { error: 'agent_teams_unavailable', detail: 'ctx.agentTeams 未装配' })
      return
    }
    try {
      const listed = await agentTeams.list()
      const teams = await Promise.all(listed.map(async entry => {
        const projected = await agentTeams.status(entry.id)
        return {
          id: projected.team.id,
          name: projected.team.name,
          topology: projected.team.topology,
          captain_session_id: projected.team.captainSessionId,
          // 成员原样带出，**包括 ownerUserId 缺省**：客户端靠 `undefined` 把它放进
          // 「未绑定」区，在这里补一个空串会让两种含义在传输中就已经分不开。
          members: projected.team.members,
          tasks: projected.team.tasks,
          progress: projected.progress,
          settled: projected.settled,
        }
      }))
      writeJson(res, 200, { teams })
    } catch (error) {
      writeJson(res, 502, { error: 'agent_teams_read_failed', detail: error instanceof Error ? error.message : '读取团队失败' })
    }
    return
  }

  if (pathname === '/lumo/api/users' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users?q=${encodeURIComponent(new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('q') ?? '')}`, req)); return
    }
    if (!requireClusterReady(config, res)) return
    try { writeUpstream(res, await upstream(config, identity, 'governance', '/v1/users', req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const userAccess = pathname.match(/^\/lumo\/api\/users\/([^/]+)\/(access|credentials|oidc)$/u)
  if (userAccess !== null) {
    if (!requireClusterReady(config, res)) return
    const userID = safeID(userAccess[1])
    if (userID === undefined) { writeJson(res, 400, { error: 'invalid user id' }); return }
    const path = `/v1/users/${encodeURIComponent(userID)}/${userAccess[2]}`
    if (req.method === 'GET' && userAccess[2] === 'access') { writeUpstream(res, await upstream(config, identity, 'governance', path, req)); return }
    if (req.method === 'DELETE' && userAccess[2] === 'oidc') { writeUpstream(res, await upstream(config, identity, 'governance', path, req, 'DELETE')); return }
    if (req.method === 'PUT' && (userAccess[2] === 'credentials' || userAccess[2] === 'oidc')) {
      try { writeUpstream(res, await upstream(config, identity, 'governance', path, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    writeJson(res, 405, { error: 'method not allowed' }); return
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

  const organizationResource = pathname.match(/^\/lumo\/api\/(departments|roles)\/([^/]+)$/u)
  if (req.method === 'PUT' && organizationResource !== null) {
    if (!requireClusterReady(config, res)) return
    const id = safeID(organizationResource[2])
    if (id === undefined) { writeJson(res, 400, { error: 'invalid organization id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/${organizationResource[1]}/${encodeURIComponent(id)}`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const desktopDevice = pathname.match(/^\/lumo\/api\/desktop-nodes\/([^/]+)\/device(?:\/(policy|enrollment|commands))?$/u)
  if (desktopDevice !== null) {
    if (!requireClusterReady(config, res)) return
    const nodeID = safeID(desktopDevice[1])
    if (nodeID === undefined) { writeJson(res, 400, { error: 'invalid node id' }); return }
    const resource = desktopDevice[2]
    const path = `/v1/desktop-nodes/${encodeURIComponent(nodeID)}/device${resource ? `/${resource}` : ''}`
    if (req.method === 'GET' && (resource === undefined || resource === 'commands')) {
      writeUpstream(res, await upstream(config, identity, 'governance', path, req)); return
    }
    if (req.method === 'POST' && resource === 'enrollment') {
      writeUpstream(res, await upstream(config, identity, 'governance', path, req, 'POST')); return
    }
    if ((req.method === 'PUT' && resource === 'policy') || (req.method === 'POST' && resource === 'commands')) {
      try { writeUpstream(res, await upstream(config, identity, 'governance', path, req, req.method, await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    writeJson(res, 405, { error: 'method not allowed' }); return
  }

  const desktopNodes = pathname.match(/^\/lumo\/api\/desktop-nodes(?:\/([^/]+)\/state)?$/u)
  if (desktopNodes !== null) {
    if (!requireClusterReady(config, res)) return
    const nodeID = desktopNodes[1] === undefined ? undefined : safeID(desktopNodes[1])
    if (desktopNodes[1] !== undefined && nodeID === undefined) { writeJson(res, 400, { error: 'invalid node id' }); return }
    const path = `/v1/desktop-nodes${nodeID ? `/${encodeURIComponent(nodeID)}/state` : ''}`
    if (req.method === 'GET' && !nodeID) { writeUpstream(res, await upstream(config, identity, 'governance', path, req)); return }
    if ((req.method === 'POST' && !nodeID) || (req.method === 'PUT' && nodeID)) {
      try { writeUpstream(res, await upstream(config, identity, 'governance', path, req, req.method, await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    writeJson(res, 405, { error: 'method not allowed' }); return
  }

  const userRole = pathname.match(/^\/lumo\/api\/users\/([^/]+)\/roles\/([^/]+)$/u)
  if ((req.method === 'PUT' || req.method === 'DELETE') && userRole !== null) {
    if (req.method === 'DELETE' && !requireClusterReady(config, res)) return
    const userID = safeID(userRole[1]); const roleID = safeID(userRole[2])
    if (userID === undefined || roleID === undefined) { writeJson(res, 400, { error: 'invalid user or role id' }); return }
    if (req.method === 'DELETE') { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/users/${encodeURIComponent(userID)}/roles/${encodeURIComponent(roleID)}`, req, 'DELETE')); return }
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

  const taskCollaborators = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/collaborators$/u)
  if (taskCollaborators !== null && (req.method === 'GET' || req.method === 'PUT')) {
    const taskID = safeID(taskCollaborators[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    if (req.method === 'GET') {
      writeUpstream(res, await upstream(config, identity, 'governance', `/v1/tasks/${encodeURIComponent(taskID)}/collaborators`, req)); return
    }
    try { writeUpstream(res, await upstream(config, identity, 'governance', `/v1/tasks/${encodeURIComponent(taskID)}/collaborators`, req, 'PUT', await readBody(req))) }
    catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const taskArtifacts = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/artifacts(?:\/([^/]+)(?:\/(content|publish))?)?$/u)
  if (taskArtifacts !== null) {
    const taskID = safeID(taskArtifacts[1]); const runID = safeID(taskArtifacts[2])
    const artifactID = taskArtifacts[3] === undefined ? undefined : safeID(taskArtifacts[3])
    const action = taskArtifacts[4]
    if (taskID === undefined || runID === undefined || (taskArtifacts[3] !== undefined && artifactID === undefined)) { writeJson(res, 400, { error: 'invalid task, run or artifact id' }); return }
    const collectionPath = `/v1/tasks/${encodeURIComponent(taskID)}/runs/${encodeURIComponent(runID)}/artifacts`
    if (artifactID === undefined && req.method === 'GET') {
      writeUpstream(res, await upstream(config, identity, 'governance', collectionPath, req)); return
    }
    if (artifactID === undefined && req.method === 'POST') {
      if (objectStore === undefined) { writeJson(res, 503, { error: '对象存储未装配，无法保存任务产物' }); return }
      try {
        const filename = safeUploadFilename(typeof req.headers['x-lumo-file-name'] === 'string' ? req.headers['x-lumo-file-name'] : undefined)
        const rawType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';', 1)[0]!.trim().toLowerCase() : ''
        const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(rawType) ? rawType : 'application/octet-stream'
        const body = await readBody(req, LIBRARY_UPLOAD_LIMIT)
        if (body.length === 0) { writeJson(res, 400, { error: '上传文件不能为空' }); return }
        const reservation = await upstream(config, identity, 'governance', collectionPath, req, 'POST', Buffer.from(JSON.stringify({ name: filename, content_type: contentType })), 'application/json')
        if (!reservation.ok) { writeUpstream(res, reservation); return }
        const reserved = reservation.data as { id?: unknown }
        if (typeof reserved?.id !== 'string') { writeJson(res, 502, { error: '治理服务未返回产物记录 ID' }); return }
        const fullKey = await objectStore.putContent(identity.realm, body, contentType)
        const storageKey = fullKey.startsWith(`${identity.realm}/`) ? fullKey.slice(identity.realm.length + 1) : fullKey
        const sha256 = createHash('sha256').update(body).digest('hex')
        const completion = await upstream(config, identity, 'governance', `${collectionPath}/${encodeURIComponent(reserved.id)}/complete`, req, 'PUT', Buffer.from(JSON.stringify({ storage_key: storageKey, sha256, size_bytes: body.length })), 'application/json')
        writeUpstream(res, completion)
      } catch (error) {
        writeJson(res, error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 503, { error: error instanceof Error ? error.message : '任务产物上传失败' })
      }
      return
    }
    if (artifactID !== undefined && action === 'content' && req.method === 'GET') {
      if (objectStore === undefined) { writeJson(res, 503, { error: '对象存储未装配，无法读取任务产物' }); return }
      const storedRef = await upstream(config, identity, 'governance', `${collectionPath}/${encodeURIComponent(artifactID)}/storage`, req)
      if (!storedRef.ok) { writeUpstream(res, storedRef); return }
      const ref = storedRef.data as { storage_key?: unknown; sha256?: unknown; size_bytes?: unknown; name?: unknown; content_type?: unknown }
      if (typeof ref.storage_key !== 'string' || typeof ref.sha256 !== 'string' || typeof ref.size_bytes !== 'number') { writeJson(res, 502, { error: '治理服务返回了无效的产物引用' }); return }
      const stored = await objectStore.get(identity.realm, ref.storage_key)
      if (stored === undefined) { writeJson(res, 404, { error: '任务产物对象不存在' }); return }
      const digest = createHash('sha256').update(stored.body).digest('hex')
      if (stored.body.length !== ref.size_bytes || digest !== ref.sha256) { writeJson(res, 502, { error: '任务产物完整性校验失败' }); return }
      const filename = safeUploadFilename(typeof ref.name === 'string' ? encodeURIComponent(ref.name) : undefined)
      const encodedFilename = encodeURIComponent(filename).replaceAll("'", '%27')
      const mimeType = typeof ref.content_type === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(ref.content_type) ? ref.content_type : 'application/octet-stream'
      res.writeHead(200, { 'content-type': mimeType, 'content-length': String(stored.body.length), 'content-disposition': `attachment; filename*=UTF-8''${encodedFilename}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(stored.body)
      return
    }
    if (artifactID !== undefined && action === 'publish' && req.method === 'POST') {
      if (!requireClusterReady(config, res)) return
      if (objectStore === undefined) { writeJson(res, 503, { error: '对象存储未装配，无法发布任务产物' }); return }
      try {
        const input = await readJson(req)
        const provider = input['provider']
        const repository = typeof input['repository'] === 'string' ? input['repository'].trim() : ''
        const targetBranch = typeof input['target_branch'] === 'string' ? input['target_branch'].trim() : ''
        const filePath = typeof input['file_path'] === 'string' ? input['file_path'].trim() : ''
        const title = typeof input['title'] === 'string' ? input['title'].trim() : ''
        const description = typeof input['body'] === 'string' ? input['body'].trim() : ''
        if ((provider !== 'github' && provider !== 'gitlab') || !GIT_REPOSITORY.test(repository) || !GIT_BRANCH.test(targetBranch) ||
          filePath.length === 0 || filePath.length > 512 || filePath.startsWith('/') || filePath.includes('\\') ||
          filePath.split('/').some(part => part === '' || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/u.test(filePath) ||
          title.length === 0 || title.length > 256 || description.length > 4000) {
          writeJson(res, 400, { error: 'Git 发布参数无效；请检查平台、仓库、分支、文件路径、标题和说明长度' }); return
        }
        if (provider === 'github' && repository.split('/').length !== 2) { writeJson(res, 400, { error: 'GitHub 仓库格式应为 owner/repository' }); return }
        const storageResponse = await upstream(config, identity, 'governance', `${collectionPath}/${encodeURIComponent(artifactID)}/storage?access=contributor`, req)
        if (!storageResponse.ok) { writeUpstream(res, storageResponse); return }
        const ref = storageResponse.data as { storage_key?: unknown; sha256?: unknown; size_bytes?: unknown; name?: unknown }
        if (typeof ref.storage_key !== 'string' || typeof ref.sha256 !== 'string' || typeof ref.size_bytes !== 'number') { writeJson(res, 502, { error: '治理服务返回了无效的产物引用' }); return }
        if (ref.size_bytes > TASK_ARTIFACT_GIT_LIMIT) { writeJson(res, 413, { error: `通过连接器 API 发布的单个文件上限为 ${TASK_ARTIFACT_GIT_LIMIT / 1024} KiB；产物仍可下载使用` }); return }
        const stored = await objectStore.get(identity.realm, ref.storage_key)
        if (stored === undefined) { writeJson(res, 404, { error: '任务产物对象不存在' }); return }
        const digest = createHash('sha256').update(stored.body).digest('hex')
        if (stored.body.length !== ref.size_bytes || digest !== ref.sha256) { writeJson(res, 502, { error: '任务产物完整性校验失败' }); return }
        const branch = `lumo/task-${taskID.slice(-12)}-${artifactID.slice(-12)}-${Date.now()}`
        const content = stored.body.toString('base64')
        let result: unknown
        if (provider === 'github') {
          const [owner, repo] = repository.split('/')
          const repoPath = { owner: owner!, repo: repo! }
          const baseRef = await invokeGitConnector(config, identity, req, 'github', 'get_ref', { ...repoPath, ref: `heads/${targetBranch}` })
          const sha = gitObjectString(baseRef, 'object.sha')
          await invokeGitConnector(config, identity, req, 'github', 'create_ref', repoPath, undefined, { ref: `refs/heads/${branch}`, sha })
          await invokeGitConnector(config, identity, req, 'github', 'put_file', { ...repoPath, path: filePath }, undefined, { message: title, content, branch })
          result = await invokeGitConnector(config, identity, req, 'github', 'create_pull_request', repoPath, undefined, { title, head: branch, base: targetBranch, body: description, draft: true })
        } else {
          const projectPath = { project: repository }
          const baseRef = await invokeGitConnector(config, identity, req, 'gitlab', 'get_branch', { ...projectPath, branch: targetBranch })
          const refName = gitObjectString(baseRef, 'name')
          await invokeGitConnector(config, identity, req, 'gitlab', 'create_branch', projectPath, { branch, ref: refName })
          await invokeGitConnector(config, identity, req, 'gitlab', 'put_file', { ...projectPath, file_path: filePath }, undefined, { branch, content, encoding: 'base64', commit_message: title })
          result = await invokeGitConnector(config, identity, req, 'gitlab', 'create_merge_request', projectPath, undefined, { source_branch: branch, target_branch: targetBranch, title: `Draft: ${title}`, description })
        }
        const url = typeof result === 'object' && result !== null
          ? ((result as { html_url?: unknown; web_url?: unknown }).html_url ?? (result as { web_url?: unknown }).web_url)
          : undefined
        const number = typeof result === 'object' && result !== null
          ? ((result as { number?: unknown; iid?: unknown }).number ?? (result as { iid?: unknown }).iid)
          : undefined
        writeJson(res, 201, { provider, branch, ...(typeof url === 'string' ? { url } : {}), ...(typeof number === 'number' ? { number } : {}) })
      } catch (error) {
        writeJson(res, error instanceof RangeError ? 413 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 502, { error: error instanceof Error ? error.message : 'Git 草稿发布失败' })
      }
      return
    }
  }

  // The collaboration view and the full run result are separate governance
  // faces: the collaboration payload carries summaries without multiplying large
  // outputs, and the result face is where the output itself lives.
  const taskCollaboration = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/collaboration$/u)
  if (req.method === 'GET' && taskCollaboration !== null) {
    const taskID = safeID(taskCollaboration[1])
    if (taskID === undefined) { writeJson(res, 400, { error: 'invalid task id' }); return }
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/tasks/${encodeURIComponent(taskID)}/collaboration`, req))
    return
  }

  const taskRunResult = pathname.match(/^\/lumo\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/result$/u)
  if (req.method === 'GET' && taskRunResult !== null) {
    const taskID = safeID(taskRunResult[1])
    const runID = safeID(taskRunResult[2])
    if (taskID === undefined || runID === undefined) { writeJson(res, 400, { error: 'invalid task or run id' }); return }
    writeUpstream(res, await upstream(config, identity, 'governance', `/v1/tasks/${encodeURIComponent(taskID)}/runs/${encodeURIComponent(runID)}/result`, req))
    return
  }

  // ---- 会话控制面（§8.4.3 的 Session Console 后端） ----
  //
  // 三条路径：读面（状态 + 按钮可用性 + 队列现场）、时间线、写面（一条控制指令）。
  //
  // **realm / role / actor 由代理按已验证会话覆盖，浏览器不能自报。** 控制面只认共享令牌，
  // 它自己的注释写着身份是「调用方主张 + OPA 判定」——也就是说，谁转发请求体谁就在主张身份。
  // 代理这一层是整条链上唯一知道真实身份的地方（cluster-management.md：浏览器不提供可信身份），
  // 所以主张必须在这里落地，而不是把它当作客户端的输入转发过去。
  const sessionControlEvents = pathname.match(/^\/lumo\/api\/sessions\/([^/]+)\/control\/events$/u)
  if (req.method === 'GET' && sessionControlEvents !== null) {
    const sessionRef = safeID(sessionControlEvents[1])
    if (sessionRef === undefined) { writeJson(res, 400, { error: 'invalid session ref' }); return }
    // 游标与 limit 原样透传：控制面自己校验并回 400（`after` 非负、`limit` 正整数并夹到 500）。
    // 在这里再抄一份校验等于同一个契约面的第二份实现——漂移后症状是「某条查询被静默改写」。
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    writeUpstream(res, await upstream(config, identity, 'session-control', `/v1/sessions/${encodeURIComponent(sessionRef)}/control/events${query}`, req))
    return
  }

  const sessionControl = pathname.match(/^\/lumo\/api\/sessions\/([^/]+)\/control$/u)
  if (sessionControl !== null) {
    const sessionRef = safeID(sessionControl[1])
    if (sessionRef === undefined) { writeJson(res, 400, { error: 'invalid session ref' }); return }
    if (req.method === 'GET') {
      writeUpstream(res, await upstream(config, identity, 'session-control', `/v1/sessions/${encodeURIComponent(sessionRef)}/control`, req))
      return
    }
    if (req.method === 'POST') {
      const role = controlRole(identity)
      // 认不出角色时**不转发**：把治理侧的 `owner`/`editor` 原样发过去会得到
      // 「角色未被授予该指令」，读起来像「你权限不够」，而事实是「这个面不认识你的角色」。
      // 两种拒绝该找的人不同——前者找管理员授权，后者是部署没有把治理角色映射到控制角色。
      if (role === undefined) { writeJson(res, 403, { error: 'no_control_role', detail: '当前身份在控制面上没有可用角色（需要 platform_admin / realm_admin / admin / approver / operator 之一）' }); return }
      let body: Record<string, unknown>
      try { body = await readJson(req) } catch (error) { writeJson(res, error instanceof RangeError ? 413 : 400, { error: error instanceof Error ? error.message : 'invalid request body' }); return }
      const forwarded = { ...body, realm: identity.realm, role, actor: identity.userId }
      writeUpstream(res, await upstream(config, identity, 'session-control', `/v1/sessions/${encodeURIComponent(sessionRef)}/control`, req, 'POST', Buffer.from(JSON.stringify(forwarded), 'utf8')))
      return
    }
    writeJson(res, 405, { error: 'method_not_allowed' })
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

  const managedProjectFlows = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/flows\/management$/u)
  if (managedProjectFlows !== null && req.method === 'GET') {
    if (!requireClusterReady(config, res)) return
    const projectID = safeID(managedProjectFlows[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    writeUpstream(res, await upstream(config, identity, 'flows', `/v1/projects/${encodeURIComponent(projectID)}/flows/management`, req)); return
  }

  const flowChange = pathname.match(/^\/lumo\/api\/flows\/([^/]+)\/management\/change$/u)
  if (flowChange !== null && req.method === 'POST') {
    if (!requireClusterReady(config, res)) return
    const flowID = safeID(flowChange[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/management/change`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const managedFlow = pathname.match(/^\/lumo\/api\/flows\/([^/]+)\/management$/u)
  if (managedFlow !== null) {
    if (!requireClusterReady(config, res)) return
    const flowID = safeID(managedFlow[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    const path = `/v1/flows/${encodeURIComponent(flowID)}/management`
    if (req.method === 'GET') { writeUpstream(res, await upstream(config, identity, 'flows', path, req)); return }
    if (req.method === 'PATCH') {
      try { writeUpstream(res, await upstream(config, identity, 'flows', path, req, 'PATCH', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    writeJson(res, 405, { error: 'method not allowed' }); return
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

  const projectMember = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/members(?:\/([^/]+))?$/u)
  if (projectMember !== null && req.method !== 'GET') {
    if (!requireClusterReady(config, res)) return
    const projectID = safeID(projectMember[1]); const userID = projectMember[2] === undefined ? undefined : safeID(projectMember[2])
    if (projectID === undefined || (projectMember[2] !== undefined && userID === undefined)) { writeJson(res, 400, { error: 'invalid project member id' }); return }
    const path = `/v1/projects/${encodeURIComponent(projectID)}/members${userID ? `/${encodeURIComponent(userID)}` : ''}`
    if (req.method === 'DELETE' && userID) { writeUpstream(res, await upstream(config, identity, 'projects', path, req, 'DELETE')); return }
    if ((req.method === 'POST' && !userID) || (req.method === 'PATCH' && userID)) {
      try { writeUpstream(res, await upstream(config, identity, 'projects', path, req, req.method, await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
      return
    }
    writeJson(res, 405, { error: 'method not allowed' }); return
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

  const connectorManifest = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)\/manifest$/u)
  const connectorOAuth = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)\/oauth(\/refresh)?$/u)
  if (connectorOAuth !== null && ((connectorOAuth[2] === undefined && (req.method === 'GET' || req.method === 'DELETE')) || (connectorOAuth[2] !== undefined && req.method === 'POST'))) {
    if (!requireClusterReady(config, res)) return
    const connectorID = safeID(connectorOAuth[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    const path = `/connectors/${encodeURIComponent(connectorID)}/oauth${connectorOAuth[2] ?? ''}`
    writeUpstream(res, await upstream({ ...config, timeoutMs: Math.max(config.timeoutMs, 60_000) }, identity, 'connector', path, req, req.method)); return
  }
  if (pathname === '/lumo/api/connectors/capabilities' && req.method === 'GET') {
    if (!requireClusterReady(config, res)) return
    writeUpstream(res, await upstream(config, identity, 'connector', '/capabilities', req)); return
  }
  if (connectorManifest !== null && req.method === 'GET') {
    if (!requireClusterReady(config, res)) return
    const connectorID = safeID(connectorManifest[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}/manifest`, req)); return
  }

  const connector = pathname.match(/^\/lumo\/api\/connectors\/([^/]+)$/u)
  if (connector !== null && req.method === 'PUT') {
    if (!requireClusterReady(config, res)) return
    const connectorID = safeID(connector[1])
    if (connectorID === undefined) { writeJson(res, 400, { error: 'invalid connector id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'connector', `/connectors/${encodeURIComponent(connectorID)}`, req, 'PUT', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }
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
  // Desktop installs use the same root as the native filesystem skill provider.
  const skillhubUrl = new URL(req.url ?? '/', 'http://lumo.local')
  const skillhubConfig = (): SkillHubConfig => ({
    catalogFile: resolve(config.skillhubCatalogFile ?? '.lumo/skillhub-catalog.json'),
    installFile: resolve(config.skillhubInstallFile ?? '.lumo/skillhub-installs.json'),
    root: resolve(config.skillhubRoot ?? '.lumo/skills'),
    snapshotFile: resolve(config.skillhubSnapshotFile ?? '.lumo/skill-snapshot.json'),
    apiBase: config.skillhubApiBase ?? 'https://api.skillhub.cn',
    command: config.skillhubCommand ?? 'skillhub',
    runtime: skillhubRuntime,
    preinstalledRepositories: [
      'https://github.com/dsh-market/dsh-market.git',
      'RevolutionLA/dsh-dream-skin',
      'bowenliang123/dsh-context',
      'Han-1413141/dsh-cost-meter',
      'liustack/modlens',
      'NanmiCoder/dsh-agent-teams',
    ],
  })
  // `catalog` queries SkillHub live (falling back to the on-disk cache, then the
  // seed); `catalog?cached=1` reads only local state; `refresh` is an alias that
  // always goes to the network.
  if (req.method === 'GET' && (pathname === '/lumo/api/skillhub/catalog' || pathname === '/lumo/api/skillhub/refresh')) {
    const cachedOnly = pathname === '/lumo/api/skillhub/catalog' && skillhubUrl.searchParams.get('cached') === '1'
    try { writeJson(res, 200, { ...await loadCatalog(skillhubConfig(), cachedOnly), canInstall: config.deploymentMode !== 'cluster' || isRealmAdmin(identity) }) } catch (error) { writeJson(res, 502, { error: error instanceof Error ? error.message : 'skillhub catalog unavailable' }) }
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
    if (config.deploymentMode === 'cluster' && !isRealmAdmin(identity)) {
      writeJson(res, 403, { error: 'forbidden', message: '共享运行时的技能、专家包和插件安装需要管理员权限' }); return
    }
    let body: Record<string, unknown>
    try { body = await readJson(req) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }); return }
    const kind = body['kind']; const id = body['id']
    if (kind !== 'skill' && kind !== 'pack' && kind !== 'plugin') { writeJson(res, 400, { error: 'invalid kind' }); return }
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) { writeJson(res, 400, { error: 'invalid id' }); return }
    try { writeJson(res, 200, await installItem(skillhubConfig(), kind, id)) } catch (error) { writeJson(res, error instanceof TypeError ? 400 : 502, { error: error instanceof Error ? error.message : 'install failed' }) }
    return
  }

  res.setHeader('allow', 'GET, POST, PUT, PATCH, DELETE')
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return }
  writeJson(res, 404, { error: 'unknown_lumo_endpoint' })
}

function ops(_req: IncomingMessage, res: ServerResponse): void { res.writeHead(302, { location: '/?lumo=operations' }); res.end() }

export function apply(ctx: Context, config: Config): void {
  assertIdentityConfiguration(config)
  let skillhubRuntime: SkillHubRuntime | undefined
  if (config.deploymentMode === 'local') {
    ctx.inject(['skills'], (skillsCtx) => {
      // Programmatic hosts and early desktop boot may invoke the dependency
      // callback before the concrete registry is attached. The API remains
      // usable; the runtime bridge will be installed once Cordis supplies it.
      if (skillsCtx.get('skills') === undefined) return
      const runtime = registerSkillHubRuntime(skillsCtx, resolve(config.skillhubRoot ?? '.lumo/skills'))
      skillsCtx.effect(() => {
        skillhubRuntime = runtime
        return () => { if (skillhubRuntime === runtime) skillhubRuntime = undefined }
      }, 'lumo-skillhub: installation runtime')
    })
  }
  // 预插件区间的深色引导。放在 registerRoutes 之外、inject 门之前：主题与
  // knowledge/skills 是否装配无关，任何形态下白底闪一帧都不可接受。
  ctx.on('webserver/index-inject', (table) => { table.push(lumoBootThemeInjection()) })
  if (config.desktopHandoffFile !== '') registerDesktopHandoff(ctx, config.desktopHandoffFile)
  const registerRoutes = (runtimeCtx: Context): void => {
    if (config.deploymentMode !== 'local' && runtimeCtx.get('knowledge') === undefined) throw new Error('lumo-platform-ui: ctx.knowledge is unavailable')
    runtimeCtx.effect(() => {
      // Local services can become available after the web server starts.
      const disposeApi = runtimeCtx.webServer.register({
        kind: 'prefix', path: '/lumo/api', handler: (req, res) => api(
          config,
          runtimeCtx.get('knowledge') as KnowledgeQueryService | undefined,
          runtimeCtx.get('skills') as SkillRegistryService | undefined,
          runtimeCtx.get('sessionLogQuery') as SessionLogQuerySeam | undefined,
          runtimeCtx.get('knowledgeVault') as VaultService | undefined,
          req, res, skillhubRuntime,
          // 与 knowledgeVault 同样是**机会式**的取法，不进上面的 inject 列表：
          // inject 会等到列出的服务全部就绪才注册路由，把 agentTeams 加进去就等于
          // 「没装 agent-teams 的形态整个 /lumo/api 都不工作」——一个可选功能拖垮全部。
          // 取不到时路由回 503 并说明缺席，其余面照常。
          runtimeCtx.get('agentTeams') as AgentTeamsService | undefined,
          runtimeCtx.get('objectStore') as ObjectStoreService | undefined,
          runtimeCtx.get('officeToPdf') as OfficeToPdfService | undefined,
        ),
      })
      const disposeOps = runtimeCtx.webServer.register({ kind: 'exact', path: '/lumo/ops', handler: ops })
      return () => { disposeApi(); disposeOps() }
    }, 'lumo-platform-ui: same-origin API')
  }
  if (config.deploymentMode === 'local') registerRoutes(ctx)
  else ctx.inject(['knowledge', 'skills', 'sessionLogQuery'], registerRoutes)
}

export default apply
