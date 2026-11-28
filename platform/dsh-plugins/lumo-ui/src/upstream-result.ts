import type { ServerResponse } from 'node:http'

export interface UpstreamResult { ok: boolean; status: number; data: unknown; error?: string; headers?: Record<string, string> }

export function writeUpstreamResult(res: ServerResponse, result: UpstreamResult, writeJson: (res: ServerResponse, status: number, value: unknown) => void): void {
  for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value)
  if (result.ok) {
    // 204 No Content 必须无 body；其余用 JSON 承载，避免 DELETE 写回 "null"。
    if (result.status === 204) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return }
    writeJson(res, result.status, result.data); return
  }
  const upstreamError = typeof result.data === 'object' && result.data !== null ? result.data : undefined
  writeJson(res, result.status || 502, upstreamError ?? { error: result.error || 'upstream unavailable' })
}
