/** Host half: keep DSH's native Web shell and add a same-origin Lumo control API. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { assertIdentityConfiguration, IdentityAssertionError, resolveRequestIdentity, type RequestIdentity } from './identity.ts'

export const name = 'lumo-platform-ui'
export const inject = ['webServer']

export interface Config {
  schedulerUrl: string
  projectsUrl: string
  flowsUrl: string
  connectorUrl: string
  realm: string
  userId: string
  roles: string[]
  projectId: string
  deptId: string
  controlPlaneToken: string
  identityAssertionSecret: string
  timeoutMs: number
  plugins: PluginSummary[]
}

export const Config: z<Config> = z.object({
  schedulerUrl: z.string(), projectsUrl: z.string(), flowsUrl: z.string(), connectorUrl: z.string(),
  realm: z.string(), userId: z.string(), roles: z.array(z.string()), projectId: z.string(), deptId: z.string(), controlPlaneToken: z.string(), identityAssertionSecret: z.string().default(''),
  timeoutMs: z.number().default(5000),
  plugins: z.array(z.object({
    id: z.string(), label: z.string(), description: z.string(),
    surface: z.union(['overview', 'projects', 'flows', 'connectors', 'plugins'] as const),
    kind: z.union(['runtime', 'governance'] as const),
  })).default([]),
})

type ServiceName = 'scheduler' | 'projects' | 'flows' | 'connector'
interface UpstreamResult { ok: boolean; status: number; data: unknown; error?: string }

interface PluginSummary {
  id: string
  label: string
  description: string
  surface: 'overview' | 'projects' | 'flows' | 'connectors' | 'plugins'
  kind: 'runtime' | 'governance'
}

function base(config: Config, service: ServiceName): string {
  return { scheduler: config.schedulerUrl, projects: config.projectsUrl, flows: config.flowsUrl, connector: config.connectorUrl }[service].replace(/\/+$/u, '')
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
  const results = await Promise.all([
    upstream(config, identity, 'scheduler', '/healthz', req), upstream(config, identity, 'scheduler', '/v1/leader', req), upstream(config, identity, 'scheduler', '/v1/nodes', req),
    upstream(config, identity, 'projects', '/healthz', req), upstream(config, identity, 'projects', '/v1/projects', req),
    upstream(config, identity, 'flows', '/healthz', req), upstream(config, identity, 'flows', '/v1/flows', req),
    upstream(config, identity, 'connector', '/healthz', req), upstream(config, identity, 'connector', '/connectors', req),
  ])
  const [schedulerHealth, leader, nodes, projectsHealth, projects, flowsHealth, flows, connectorHealth, connectors] = results
  return {
    generatedAt: new Date().toISOString(),
    services: { scheduler: schedulerHealth, projects: projectsHealth, flows: flowsHealth, connector: connectorHealth },
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

function safeID(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) return undefined
  return value
}

function writeUpstream(res: ServerResponse, result: UpstreamResult): void {
  if (result.ok) { writeJson(res, result.status, result.data); return }
  const upstreamError = typeof result.data === 'object' && result.data !== null ? result.data : undefined
  writeJson(res, result.status || 502, upstreamError ?? { error: result.error || 'upstream unavailable' })
}

async function api(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const dashboard = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/dashboard$/u)
  if (req.method === 'GET' && dashboard !== null) {
    const projectID = safeID(dashboard[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    writeUpstream(res, await upstream(config, identity, 'projects', `/v1/projects/${encodeURIComponent(projectID)}/dashboard`, req)); return
  }

  const flow = pathname.match(/^\/lumo\/api\/flows\/([^/]+)\/(submit|run)$/u)
  if (req.method === 'POST' && flow !== null) {
    const flowID = safeID(flow[1])
    if (flowID === undefined) { writeJson(res, 400, { error: 'invalid flow id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/flows/${encodeURIComponent(flowID)}/${flow[2]}`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
    return
  }

  const projectFlow = pathname.match(/^\/lumo\/api\/projects\/([^/]+)\/flows$/u)
  if (req.method === 'POST' && projectFlow !== null) {
    const projectID = safeID(projectFlow[1])
    if (projectID === undefined) { writeJson(res, 400, { error: 'invalid project id' }); return }
    try { writeUpstream(res, await upstream(config, identity, 'flows', `/v1/projects/${encodeURIComponent(projectID)}/flows`, req, 'POST', await readBody(req))) } catch (error) { writeJson(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }) }
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

  res.setHeader('allow', 'GET, POST, DELETE')
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return }
  writeJson(res, 404, { error: 'unknown_lumo_endpoint' })
}

function ops(_req: IncomingMessage, res: ServerResponse): void { res.writeHead(302, { location: '/?lumo=ops' }); res.end() }

export function apply(ctx: Context, config: Config): void {
  assertIdentityConfiguration(config)
  ctx.effect(() => {
    const disposeApi = ctx.webServer.register({ kind: 'prefix', path: '/lumo/api', handler: (req, res) => api(config, req, res) })
    const disposeOps = ctx.webServer.register({ kind: 'exact', path: '/lumo/ops', handler: ops })
    return () => { disposeApi(); disposeOps() }
  }, 'lumo-platform-ui: same-origin API')
}

export default apply
