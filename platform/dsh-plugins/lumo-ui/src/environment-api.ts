import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeviceActionsClient } from './device-actions.ts'

const PREFIX = '/lumo/api/environment'
const ROUTES = new Set(['/servers', '/device', '/device/activate', '/device/pause', '/device/resume', '/device/leave'])
const local = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(host)

/** Local desktop BFF only. Cross-origin browser requests never reach the native bridge. */
export async function handleEnvironmentRoute(req: IncomingMessage, res: ServerResponse, pathname: string, deps: {
  client?: DeviceActionsClient; readBody(req: IncomingMessage): Promise<Buffer>
}): Promise<boolean> {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const suffix = pathname.slice(PREFIX.length)
  if (!ROUTES.has(suffix)) { send(404, { error: 'unknown_environment_endpoint' }); return true }
  if (!deps.client) { send(501, { error: '本机接入仅在 Lumo Desktop 的本地工作台可用。' }); return true }
  let origin: URL
  try { origin = new URL(`http://${req.headers.host ?? ''}`) } catch { send(403, { error: 'local_origin_required' }); return true }
  if (!local(origin.hostname) || req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin.origin)) {
    send(403, { error: '本机接入只能由本地工作台发起。' }); return true
  }
  if ((req.method === 'GET' && !['/servers', '/device'].includes(suffix)) || !['GET', 'POST'].includes(req.method ?? '')) { send(405, { error: 'method_not_allowed' }); return true }
  let body: unknown
  if (req.method === 'POST') {
    try { const raw = await deps.readBody(req); if (raw.byteLength > 16_384) throw Error(); body = JSON.parse(raw.toString('utf8') || '{}') } catch { send(400, { error: '接入配置格式错误或过大。' }); return true }
  }
  try {
    const out = await deps.client.environment(req.method as 'GET' | 'POST', suffix, body)
    send(out.status, out.body)
  } catch { send(502, { error: '本机设备服务暂不可用。' }) }
  return true
}
