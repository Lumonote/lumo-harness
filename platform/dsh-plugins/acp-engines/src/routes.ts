/**
 * ACP 引擎会话的同源 BFF 路由：/lumo/api/acp/*。由 lumo-ui index.ts 一行接入（与 asks-api / run-tree-api 同一模式）。
 *
 *   GET  /lumo/api/acp/engines                     静态探测（可执行文件是否在）
 *   POST /lumo/api/acp/engines/{id}/probe {cwd}    握手探测（initialize 读能力）
 *   GET  /lumo/api/acp/sessions                    当前用户的会话
 *   POST /lumo/api/acp/sessions {engineId,cwd,title?,parentRunId?}
 *   POST /lumo/api/acp/sessions/{id}/prompt {text}
 *   POST /lumo/api/acp/sessions/{id}/cancel
 *   POST /lumo/api/acp/sessions/{id}/close
 *   GET  /lumo/api/acp/sessions/{id}/events?after=N SSE：`event: session` + `id: seq`
 *   GET  /lumo/api/acp/asks?status=pending          会话权限 Ask（与 P0-1 Ask 同形）
 *   POST /lumo/api/acp/asks/{id}/answer {value}
 *
 * 只在本地单机形态启用：会拉起本机进程，服务器形态的远程拉起要走 desktop-agent / 调度面，不在这里做。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { EngineHost } from './engine-host.ts'
import type { SessionAskBroker } from './permission-asks.ts'
import { ENGINE_ID } from './registry.ts'

export interface AcpIdentity { userId: string; realm: string; projectId?: string }
export interface AcpRouteDeps {
  host: EngineHost | undefined
  asks: SessionAskBroker | undefined
  identity: AcpIdentity
  readBody: (req: IncomingMessage) => Promise<Buffer>
}

export const ACP_PREFIX = '/lumo/api/acp'
const SESSION_ID = /^[0-9a-f-]{36}$/u
const ASK_ID = /^session:acp-[A-Za-z0-9._:-]{1,200}$/u
const MAX_PROMPT = 200_000

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req: IncomingMessage, deps: AcpRouteDeps): Promise<Record<string, unknown>> {
  const raw = (await deps.readBody(req)).toString('utf8')
  if (raw.trim() === '') return {}
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('需要 JSON 对象')
  return value as Record<string, unknown>
}

const str = (v: unknown, max = 4096): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

/** 处理了返回 true；未匹配返回 false。 */
export async function handleAcpRoute(req: IncomingMessage, res: ServerResponse, pathname: string, deps: AcpRouteDeps): Promise<boolean> {
  if (pathname !== ACP_PREFIX && !pathname.startsWith(`${ACP_PREFIX}/`)) return false
  const { host, asks, identity } = deps
  if (host === undefined || asks === undefined) { json(res, 501, { error: 'ACP 引擎会话未启用（仅本地单机形态，且未设置 LUMO_ACP_ENGINES=off）' }); return true }
  const sub = pathname.slice(ACP_PREFIX.length)
  const method = req.method ?? 'GET'
  let input: Record<string, unknown> = {}
  if (method === 'POST') {
    try { input = await body(req, deps) } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求体无效' }); return true }
  }

  if (method === 'GET' && sub === '/engines') { json(res, 200, { engines: host.probeStatic() }); return true }
  let m = /^\/engines\/([^/]+)\/probe$/u.exec(sub)
  if (method === 'POST' && m) {
    const id = decodeURIComponent(m[1]!)
    const cwd = str(input.cwd)
    if (!ENGINE_ID.test(id) || cwd === undefined) { json(res, 400, { error: '需要合法引擎 id 与 cwd' }); return true }
    json(res, 200, await host.probe(id, cwd)); return true
  }

  if (method === 'GET' && sub === '/sessions') { json(res, 200, { sessions: host.list(identity.userId) }); return true }
  if (method === 'POST' && sub === '/sessions') {
    const engineId = str(input.engineId, 64); const cwd = str(input.cwd)
    if (engineId === undefined || !ENGINE_ID.test(engineId) || cwd === undefined) { json(res, 400, { error: '需要 engineId 与 cwd' }); return true }
    try {
      const title = str(input.title, 200); const parentRunId = str(input.parentRunId, 200)
      const session = await host.createSession({ engineId, cwd, realm: identity.realm, userId: identity.userId, ...(identity.projectId ? { projectId: identity.projectId } : {}), ...(title ? { title } : {}), ...(parentRunId ? { parentRunId } : {}) })
      json(res, 201, { session })
    } catch (error) { json(res, 422, { error: error instanceof Error ? error.message : String(error) }) }
    return true
  }

  m = /^\/sessions\/([^/]+)\/(prompt|cancel|close|events)$/u.exec(sub)
  if (m) {
    const id = m[1]!
    if (!SESSION_ID.test(id)) { json(res, 400, { error: 'invalid session id' }); return true }
    const action = m[2]!
    if (method === 'GET' && action === 'events') { streamEvents(req, res, host, id, identity.userId); return true }
    if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true }
    if (action === 'prompt') {
      const text = typeof input.text === 'string' ? input.text : ''
      if (text.trim() === '' || text.length > MAX_PROMPT) { json(res, 400, { error: '提示词为空或过长' }); return true }
      const r = host.prompt(id, identity.userId, text)
      json(res, r.ok ? 202 : 409, r); return true
    }
    if (action === 'cancel') { const r = host.cancel(id, identity.userId); json(res, r.ok ? 200 : 409, r); return true }
    const ok = host.close(id, 'completed', identity.userId)
    json(res, ok ? 200 : 404, { ok }); return true
  }

  if (method === 'GET' && sub === '/asks') {
    const status = new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('status') ?? undefined
    json(res, 200, { asks: asks.list({ userId: identity.userId, ...(status ? { status } : {}) }) }); return true
  }
  m = /^\/asks\/([^/]+)\/answer$/u.exec(sub)
  if (method === 'POST' && m) {
    const id = decodeURIComponent(m[1]!)
    const value = str(input.value, 200)
    if (!ASK_ID.test(id) || value === undefined) { json(res, 400, { error: '需要合法 ask id 与 value' }); return true }
    const r = asks.answer(id, value, identity.userId)
    json(res, r.ok ? 200 : 409, r); return true
  }

  json(res, 404, { error: 'unknown acp route' })
  return true
}

function streamEvents(req: IncomingMessage, res: ServerResponse, host: EngineHost, id: string, userId: string): void {
  const after = Number(new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('after') ?? req.headers['last-event-id'] ?? 0)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const unsubscribe = host.subscribe(id, userId, Number.isFinite(after) ? after : 0, (seq, event) => {
    res.write(`id: ${seq}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`)
    if (event.type === 'session.closed') { cleanup(); res.end() }
  })
  if (unsubscribe === undefined) { res.write(`event: gone\ndata: {}\n\n`); res.end(); return }
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  ping.unref?.()
  function cleanup(): void { clearInterval(ping); unsubscribe?.() }
  req.on('close', cleanup)
}
