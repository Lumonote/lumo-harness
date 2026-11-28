import type { ServerResponse } from 'node:http'
import type { EngineHost } from './engine-host.ts'
import type { SessionScope } from './session-scope.ts'
import type { AttachmentStore } from './attachment-store.ts'
const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
export function handleConversationRoute(sub: string, method: string, input: Record<string, unknown>, scope: SessionScope, host: EngineHost, res: ServerResponse, url: URL, attachments?: AttachmentStore): boolean {
  const match = /^\/sessions\/([0-9a-f-]{36})\/(history|receipt|metadata|export|release|delete|mode)$/u.exec(sub)
  if (!match) return false
  const id = match[1]!, action = match[2]!
  const session = host.get(id, scope)
  if (!session) { reply(res, 404, { error: '会话不存在' }); return true }
  try {
    if (action === 'receipt' && method === 'GET') {
      const messageId = url.searchParams.get('clientMessageId') ?? ''
      if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(messageId)) throw new Error('消息标识无效')
      const receipt = host.receipt(id, scope, messageId)
      reply(res, 200, { receipt: receipt ?? null })
    } else if (action === 'history' && method === 'GET') {
      const before = url.searchParams.get('before'), limit = url.searchParams.get('limit')
      if ((before !== null && (!/^\d+$/u.test(before) || !Number.isSafeInteger(Number(before)))) || (limit !== null && (!/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 1000))) throw new Error('历史分页参数无效')
      reply(res, 200, host.history(id, scope, before === null ? undefined : Number(before), limit === null ? undefined : Number(limit)))
    } else if (action === 'export' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="conversation-${id}.json"` })
      const pages = []; let before: number | undefined
      do { const page = host.history(id, scope, before, 1000)!; pages.push(page.events); if (!page.hasMore) break; before = page.before } while (true)
      res.end(JSON.stringify({ version: 1, session, events: pages.reverse().flat() }))
    } else if (method !== 'POST') reply(res, 405, { error: 'method not allowed' })
    else if (action === 'metadata') {
      const patch: { title?: string; archived?: boolean; pinned?: boolean } = {}
      if (input.title !== undefined) { if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('标题长度应为 1–200 字'); patch.title = input.title.trim() }
      for (const key of ['archived', 'pinned'] as const) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw new Error('会话属性无效'); patch[key] = input[key] }
      reply(res, 200, { session: host.metadata(id, scope, patch) })
    } else if (action === 'release') reply(res, 200, { ok: host.release(id, scope) })
    else if (action === 'delete') { const ok = host.delete(id, scope); if (ok) attachments?.releaseOwner(`session:${id}`, scope); reply(res, 200, { ok }) }
    else if (action === 'mode') {
      // Async mode requests are dispatched in the main route.
      return false
    } else reply(res, 405, { error: 'method not allowed' })
  } catch (error) { reply(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
  return true
}
