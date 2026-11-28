import { handleConversationRoute } from './conversation-routes.ts'
import { promptDigest } from './engine-host.ts'
import { promptContext, type AgentSkills } from './prompt-context.ts'
import { projectFiles, projectFileBlocks, projectFilePreview } from './project-files.ts'
import type { ContentBlock } from './acp-protocol.ts'
import type { AttachmentStore } from './attachment-store.ts'
import { ATTACHMENT_LIMITS, attachmentRefs } from './chat-attachments.ts'
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

import type { EngineHost, SessionReplayInfo, SessionSummary } from './engine-host.ts'
import type { SessionAskBroker } from './permission-asks.ts'
import { validModelId } from './session-models.ts'
import { ENGINE_ID } from './registry.ts'
import { handleRoleRoomRoute } from './role-room-routes.ts'
import type { RoleRooms } from './role-rooms.ts'

export type { SessionScope as AcpIdentity } from './session-scope.ts'
import type { SessionScope as AcpIdentity } from './session-scope.ts'
export interface AcpRouteDeps {
  skills?: AgentSkills | undefined
  attachments?: AttachmentStore | undefined
  rooms?: RoleRooms | undefined
  host?: EngineHost | undefined
  asks?: SessionAskBroker | undefined
  identity: AcpIdentity
  readBody: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>
}

export const ACP_PREFIX = '/lumo/api/acp'
const SESSION_ID = /^[0-9a-f-]{36}$/u
const ASK_ID = /^session:acp-[A-Za-z0-9._:-]{1,200}$/u
const MAX_PROMPT = 200_000

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function body(req: IncomingMessage, deps: AcpRouteDeps, maxBytes?: number): Promise<Record<string, unknown>> {
  const raw = (await deps.readBody(req, maxBytes)).toString('utf8')
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
  const withRoom = (session: SessionSummary) => {
    const room = deps.rooms?.sessionOwner(session.id, identity), role = room?.roles.find(r => r.sessionId === session.id)
    return { ...session, ...(room && role ? { room: { id: room.id, name: room.name, roleId: role.id, roleName: role.name } } : {}) }
  }
  const method = req.method ?? 'GET'
  let input: Record<string, unknown> = {}
  if (method === 'POST') {
    try { input = await body(req, deps, sub === '/attachments' ? ATTACHMENT_LIMITS.bodyBytes : undefined) } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求体无效' }); return true }
  }

  if (sub === '/attachments' && method === 'POST') {
    if (!deps.attachments) { json(res, 503, { error: '附件服务未启用' }); return true }
    try { json(res, 201, { attachment: deps.attachments.upload(input, identity) }) }
    catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '附件上传失败' }) }
    return true
  }
  if (sub === '/attachments/stats' && method === 'GET') {
    if (!deps.attachments) json(res, 503, { error: '附件服务未启用' })
    else { try { const stats = deps.attachments.stats(identity); json(res, 200, { ...stats, stats, identity }) } catch (error) { json(res, 500, { error: String(error) }) } }
    return true
  }
  if ((sub === '/attachments/cleanup' || sub === '/attachments/collect') && method === 'POST') {
    if (!deps.attachments) json(res, 503, { error: '附件服务未启用' })
    else { try { const collected = deps.attachments.collect(identity); json(res, 200, { ...collected, stats: deps.attachments.stats(identity), identity }) } catch (error) { json(res, 500, { error: String(error) }) } }
    return true
  }
  if (sub.startsWith('/attachments/') && method === 'GET') {
    try {
      const result = deps.attachments?.get(sub.slice('/attachments/'.length), identity)
      if (!result) throw new Error('附件不可用')
      const { file, bytes } = result
      res.writeHead(200, { 'content-type': file.mimeType, 'content-length': bytes.length, 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'",
        'content-disposition': `${/^image\/(png|jpeg|webp|gif)$/u.test(file.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}` })
      res.end(bytes)
    } catch { json(res, 404, { error: '附件不存在或不可访问' }) }
    return true
  }
  const contextRoute = /^\/(sessions|rooms)\/([A-Za-z0-9_-]{1,80})\/(skills|files|preview)$/u.exec(sub)
  if (contextRoute && method === 'GET') {
    try {
      const target = contextRoute[1] === 'sessions' ? host.get(contextRoute[2]!, identity) : deps.rooms?.view(contextRoute[2]!, identity)
      if (!target) { json(res, 404, { error: '对话不存在' }); return true }
      if (contextRoute[3] === 'preview') json(res, 200, projectFilePreview(target.cwd, new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('path') ?? ''))
      else if (contextRoute[3] === 'files') json(res, 200, { files: projectFiles(target.cwd, new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('query') ?? '') })
      else {
        if (!deps.skills) throw new Error('Skill 服务未启用')
        json(res, 200, await whileConnected(res, signal => deps.skills!.list(target.cwd, signal)))
      }
    } catch (error) { json(res, 422, { error: error instanceof Error ? error.message : '上下文目录不可用' }) }
    return true
  }
  if (await handleRoleRoomRoute(sub, method, input, identity, deps.rooms, res, req.url)) return true
  if (method === 'GET' && sub === '/engines') { json(res, 200, { engines: host.probeStatic() }); return true }
  let m = /^\/engines\/([^/]+)\/probe$/u.exec(sub)
  if (method === 'POST' && m) {
    const id = decodeURIComponent(m[1]!)
    const cwd = str(input.cwd)
    if (!ENGINE_ID.test(id) || cwd === undefined) { json(res, 400, { error: '需要合法引擎 id 与 cwd' }); return true }
    json(res, 200, await host.probe(id, cwd)); return true
  }

  m = /^\/engines\/([^/]+)\/models$/u.exec(sub)
  if (method === 'POST' && m) {
    const engineId = m[1]!, cwd = str(input.cwd)
    if (!ENGINE_ID.test(engineId) || !cwd) { json(res, 400, { error: '需要引擎与工作区目录' }); return true }
    try {
      const session = await whileConnected(res, signal => host.createSession({ ...identity, engineId, cwd, title: '读取模型目录' }, signal))
      try { host.delete(session.id, identity) }
      catch (error) { throw new Error(`模型已读取，但临时会话未能关闭。请在独立会话中结束「读取模型目录」后重试：${error instanceof Error ? error.message : String(error)}`) }
      json(res, 200, { models: session.models ?? null, identity })
    } catch (error) { json(res, 422, { error: error instanceof Error ? error.message : String(error) }) }
    return true
  }
  if (method === 'GET' && sub === '/sessions') { json(res, 200, { sessions: host.list(identity, new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('q') ?? '').map(withRoom), identity }); return true }
  if (method === 'POST' && sub === '/sessions') {
    const engineId = str(input.engineId, 64); const cwd = str(input.cwd)
    if (engineId === undefined || !ENGINE_ID.test(engineId) || cwd === undefined) { json(res, 400, { error: '需要 engineId 与 cwd' }); return true }
    if (input.modelId !== undefined && !validModelId(input.modelId)) { json(res, 400, { error: '模型标识无效' }); return true }
    try {
      const title = str(input.title, 200); const parentRunId = str(input.parentRunId, 200)
      const session = await whileConnected(res, signal => host.createSession({ engineId, cwd, realm: identity.realm, userId: identity.userId, ...(identity.projectId ? { projectId: identity.projectId } : {}), ...(title ? { title } : {}), ...(parentRunId ? { parentRunId } : {}), ...(input.modelId ? { modelId: input.modelId as string } : {}) }, signal))
      json(res, 201, { session })
    } catch (error) { json(res, 422, { error: error instanceof Error ? error.message : String(error) }) }
    return true
  }

  const managedAction = /^\/sessions\/([^/]+)\/(metadata|release|delete|mode|continue)$/u.exec(sub)
  if (method === 'POST' && managedAction && deps.rooms?.sessionOwner(managedAction[1]!, identity)) { json(res, 409, { error: '此会话属于 Agent 群组，请从群组管理' }); return true }
  if (handleConversationRoute(sub, method, input, identity, host, res, new URL(req.url ?? '/', 'http://lumo.local'), deps.attachments)) return true
  m = /^\/sessions\/([^/]+)\/(prompt|cancel|close|events|attach|resume|model|mode|continue)$/u.exec(sub)
  if (m) {
    const id = m[1]!
    if (!SESSION_ID.test(id)) { json(res, 400, { error: 'invalid session id' }); return true }
    const action = m[2]!
    if (action === 'events') {
      if (method === 'GET') streamEvents(req, res, host, id, identity)
      else json(res, 405, { error: 'method not allowed' })
      return true
    }
    if (method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true }
    if (action !== 'attach' && deps.rooms?.sessionOwner(id, identity)) { json(res, 409, { error: '此会话属于 Agent 群组，请从群组操作成员、模型与回合' }); return true }
    if (action === 'attach' || action === 'resume') {
      try {
        const session = action === 'resume' ? await whileConnected(res, signal => host.resume(id, identity, signal)) : host.get(id, identity)
        if (!session || session.state === 'starting') { json(res, 409, { error: '会话不可连接，请刷新列表' }); return true }
        json(res, 200, { session: withRoom(session) })
      } catch (error) { json(res, 422, { error: error instanceof Error ? error.message : String(error) }) }
      return true
    }
    if (action === 'continue') {
      if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 32_000 || (input.clientRequestId !== undefined && (typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.clientRequestId))) || (input.engineId !== undefined && (typeof input.engineId !== 'string' || !ENGINE_ID.test(input.engineId)))) { json(res, 400, { error: '需要有效的交接摘要和引擎' }); return true }
      try { json(res, 201, { session: await whileConnected(res, signal => host.continue(id, identity, { summary: input.summary as string, ...(str(input.title, 200) ? { title: input.title as string } : {}), ...(input.engineId ? { engineId: input.engineId as string } : {}), ...(str(input.clientRequestId, 160) ? { clientRequestId: input.clientRequestId as string } : {}) }, signal)) }) }
      catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
      return true
    }
    if (action === 'mode') {
      if (!str(input.modeId, 200)) { json(res, 400, { error: '模式标识无效' }); return true }
      try { json(res, 200, { session: await host.setMode(id, identity, input.modeId as string) }) }
      catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
      return true
    }
    if (action === 'model') {
      if (!validModelId(input.modelId)) { json(res, 400, { error: '模型标识无效' }); return true }
      try { json(res, 200, { session: await host.setModel(id, identity, input.modelId) }) }
      catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
      return true
    }
    if (action === 'prompt') {
      const session = host.get(id, identity)
      if (session && deps.rooms?.workspaceBusy(session.cwd)) { json(res, 409, { error: '此工作区正在进行群组协作，请等待完成或先停止协作' }); return true }
      const text = typeof input.text === 'string' ? input.text : ''
      let release: (() => void) | undefined
      try {
        const context = promptContext(input)
        const refs = attachmentRefs(input.attachments)
        const clientMessageId = input.clientMessageId === undefined ? undefined : str(input.clientMessageId, 160)
        if (input.clientMessageId !== undefined && (!clientMessageId || !/^[A-Za-z0-9._:-]+$/u.test(clientMessageId))) throw new Error('消息标识无效')
        const digest = promptDigest({ text, attachments: refs, ...context })
        if (clientMessageId) { const receipt = host.receipt(id, identity, clientMessageId, digest); if (receipt) { json(res, 202, { ok: true, duplicate: true, receipt }); return true } }
        if (!session) { json(res, 404, { error: '会话不存在' }); return true }
        const preparation = host.preparePrompt(id, identity)
        res.on('close', preparation.cancel)
        release = () => { res.off('close', preparation.cancel); preparation.release() }
        if ((!text.trim() && !refs.length && !context.skills?.length && !context.files?.length) || text.length > MAX_PROMPT) throw new Error('提示词为空或过长')
        if (refs.length && !deps.attachments) throw new Error('附件服务未启用')
        const attachments = refs.length ? deps.attachments!.resolve(refs, identity) : []
        let prompt = attachments.length ? deps.attachments!.prompt(text, attachments, identity, session?.capabilities) : text
        if (!session) { json(res, 404, { error: '会话不存在' }); return true }
        const extra: ContentBlock[] = projectFileBlocks(session.cwd, context.files ?? [])
        if (context.skills?.length) {
          if (!deps.skills) throw new Error('Skill 服务未启用')
          extra.push({ type: 'text', text: await whileConnected(res, signal => deps.skills!.load(context.skills!, session.cwd, signal), preparation.signal) })
        }
        if (extra.length) prompt = [...(typeof prompt === 'string' ? [{ type: 'text', text: prompt || '请使用所选上下文；任务不明确时先询问。' }] : prompt), ...extra]
        preparation.signal.throwIfAborted()
        if (attachments.length) deps.attachments!.retain(`session:${id}`, attachments, identity)
        const r = host.prompt(id, identity, prompt, { text, attachments, ...context }, { ...(clientMessageId ? { clientMessageId } : {}), digest, workspaceOwner: `session:${id}`, preparationSignal: preparation.signal })
        json(res, r.ok ? 202 : 409, r)
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '附件发送失败' }) }
      finally { release?.() }
      return true
    }
    if (action === 'cancel') { const r = host.cancel(id, identity); json(res, r.ok ? 200 : 409, r); return true }
    try { const ok = host.close(id, identity); json(res, ok ? 200 : 404, { ok }) }
    catch (error) { json(res, 500, { error: error instanceof Error ? error.message : String(error) }) }
    return true
  }

  if (method === 'GET' && sub === '/asks') {
    const status = new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('status') ?? undefined
    json(res, 200, { asks: asks.list(identity, status ? { status } : {}) }); return true
  }
  m = /^\/asks\/([^/]+)\/answer$/u.exec(sub)
  if (method === 'POST' && m) {
    const id = decodeURIComponent(m[1]!)
    const value = str(input.value, 200)
    if (!ASK_ID.test(id) || value === undefined) { json(res, 400, { error: '需要合法 ask id 与 value' }); return true }
    const r = asks.answer(id, value, identity)
    json(res, r.ok ? 200 : 409, r); return true
  }

  json(res, 404, { error: 'unknown acp route' })
  return true
}

function streamEvents(req: IncomingMessage, res: ServerResponse, host: EngineHost, id: string, identity: AcpIdentity): void {
  // Native EventSource reconnects with the original URL and a newer header.
  const raw = req.headers['last-event-id'] ?? new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('after') ?? '0'
  if (typeof raw !== 'string' || !/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    json(res, 400, { error: 'invalid event cursor' }); return
  }
  const after = Number(raw)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  let unsubscribe: (() => void) | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  let ended = false
  let info: SessionReplayInfo | undefined
  function cleanup(): void {
    ended = true
    if (ping !== undefined) { clearInterval(ping); ping = undefined }
    const stop = unsubscribe; unsubscribe = undefined; stop?.()
    res.off('close', cleanup)
  }
  function finish(): void { cleanup(); res.end() }
  // Events are durable: a slow subscriber reconnects from its last received id.
  // Stop at the stream high-water mark instead of accumulating more output.
  function write(value: string): boolean {
    if (ended) return false
    if (!res.write(value)) { finish(); return false }
    return true
  }
  res.on('close', cleanup)
  unsubscribe = host.subscribe(id, identity, after, (seq, event) => {
    if (ended) return
    if (!write(`id: ${seq}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`)) return
    if (event.type === 'session.closed' && (!info || seq >= info.seq)) {
      if (info) { const current = host.get?.(id, identity) ?? info.session; if (!write(`event: hello\ndata: ${JSON.stringify({ ...info, seq, session: { ...current, state: current.capabilities?.loadSession ? 'detached' : 'closed', historyOnly: true } })}\n\n`)) return }
      finish()
    }
  }, replay => {
    info = replay
    if (replay.reason) write(`id: ${replay.resetAfter}\nevent: reset\ndata: ${JSON.stringify(replay)}\n\n`)
  })
  // Replay callbacks run synchronously, before subscribe returns its disposer.
  if (ended) { cleanup(); return }
  if (unsubscribe === undefined) { if (write(`event: gone\ndata: {}\n\n`)) finish(); return }
  // No id: the snapshot must never advance the browser beyond replayed events.
  if (info && !write(`event: hello\ndata: ${JSON.stringify(info)}\n\n`)) return
  if (info?.session.historyOnly) { finish(); return }
  ping = setInterval(() => { write(': ping\n\n') }, 25_000)
  ping.unref?.()
}

/** 浏览器离开建立/恢复请求时回收尚未交付的进程；普通 SSE 断开不结束会话。 */
async function whileConnected<T>(res: ServerResponse, work: (signal: AbortSignal) => Promise<T>, preparation?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  res.on('close', abort)
  const signal = preparation ? AbortSignal.any([controller.signal, preparation]) : controller.signal
  let rejectAborted: (() => void) | undefined
  try {
    signal.throwIfAborted()
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(signal.reason ?? new Error('请求已取消'))
      signal.addEventListener('abort', rejectAborted, { once: true })
    })
    const result = await Promise.race([work(signal), aborted])
    signal.throwIfAborted()
    return result
  } finally {
    res.off('close', abort)
    if (rejectAborted) signal.removeEventListener('abort', rejectAborted)
  }
}
