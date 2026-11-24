/**
 * 跨设备记忆同步的控制台代理：`/lumo/api/memory-sync/{changes,push}` → projects
 * `/v1/memory-sync/{changes,push}`。
 *
 * 身份完全由调用方传入的 `forward`（index.ts 的 upstream：用已验证的 RequestIdentity
 * 重新构造 Authorization 与 X-Lumo-* 头）决定；这里**不读取、不转发**请求里的任何
 * 头，所以客户端自带的 X-Lumo-* 头天然被丢弃。查询串只放行白名单参数。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface MemorySyncProxyDeps {
  readBody(req: IncomingMessage, maxBytes?: number): Promise<Buffer>
  forward(path: string, method: 'GET' | 'POST', body?: Buffer): Promise<void>
  reject(status: number, error: string): void
}

const PUSH_MAX_BYTES = 4 << 20

export async function handleMemorySyncRoute(req: IncomingMessage, _res: ServerResponse, pathname: string, deps: MemorySyncProxyDeps): Promise<boolean> {
  if (pathname === '/lumo/api/memory-sync/changes') {
    if (req.method !== 'GET') { deps.reject(405, 'method not allowed'); return true }
    const incoming = new URL(req.url ?? '/', 'http://lumo.local').searchParams
    const params = new URLSearchParams()
    for (const key of ['workspace', 'since', 'limit']) {
      const value = incoming.get(key)
      if (value !== null) params.set(key, value)
    }
    await deps.forward(`/v1/memory-sync/changes?${params}`, 'GET')
    return true
  }
  if (pathname === '/lumo/api/memory-sync/push') {
    if (req.method !== 'POST') { deps.reject(405, 'method not allowed'); return true }
    let body: Buffer
    try { body = await deps.readBody(req, PUSH_MAX_BYTES) } catch { deps.reject(413, 'request body too large'); return true }
    await deps.forward('/v1/memory-sync/push', 'POST', body)
    return true
  }
  return false
}
