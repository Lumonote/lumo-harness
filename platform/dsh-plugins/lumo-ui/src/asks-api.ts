/**
 * 统一 Ask 的同源 BFF 路由（P0-1）：/lumo/api/asks* → connector-gateway /asks*。
 * 独立成文件，index.ts 只做一行接入。SSE 需要流式透传，所以不复用缓冲式 upstream()。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface AsksRouteDeps {
  connectorUrl: string
  headers: Record<string, string>
  timeoutMs: number
  readBody: (req: IncomingMessage) => Promise<Buffer>
}

const ASK_ID = /^[A-Za-z0-9._:-]{1,160}$/u

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 处理了返回 true；未匹配返回 false，由调用方继续路由。 */
export async function handleAsksRoute(req: IncomingMessage, res: ServerResponse, pathname: string, deps: AsksRouteDeps): Promise<boolean> {
  if (!pathname.startsWith('/lumo/api/asks')) return false
  const base = deps.connectorUrl.replace(/\/+$/u, '')
  if (base === '') { json(res, 503, { error: 'connector 服务未配置' }); return true }

  if (req.method === 'GET' && pathname === '/lumo/api/asks/events') {
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    try {
      const upstream = await fetch(`${base}/asks/events`, { headers: { ...deps.headers, accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal })
      if (!upstream.ok || upstream.body === null) { json(res, upstream.status || 502, { error: '事件流不可用' }); return true }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } catch { /* 客户端断开或上游断流：直接结束 */ }
    res.end()
    return true
  }

  if (req.method === 'GET' && pathname === '/lumo/api/asks') {
    const query = new URL(req.url ?? '/', 'http://lumo.local').search
    return proxy(res, `${base}/asks${query}`, { method: 'GET', headers: deps.headers }, deps.timeoutMs)
  }

  const match = /^\/lumo\/api\/asks\/([^/]+)\/(answer|cancel)$/u.exec(pathname)
  if (req.method === 'POST' && match !== null) {
    const id = decodeURIComponent(match[1]!)
    if (!ASK_ID.test(id)) { json(res, 400, { error: 'invalid ask id' }); return true }
    let body: string
    try { body = (await deps.readBody(req)).toString('utf8') || '{}' } catch (error) { json(res, 413, { error: error instanceof Error ? error.message : 'invalid request body' }); return true }
    return proxy(res, `${base}/asks/${encodeURIComponent(id)}/${match[2]}`, { method: 'POST', headers: { ...deps.headers, 'content-type': 'application/json' }, body }, deps.timeoutMs)
  }
  json(res, 404, { error: 'unknown ask route' })
  return true
}

async function proxy(res: ServerResponse, url: string, init: RequestInit, timeoutMs: number): Promise<true> {
  try {
    const upstream = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    const text = await upstream.text()
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  } catch (error) {
    json(res, 502, { error: error instanceof Error ? error.message : 'connector 不可达' })
  }
  return true
}
