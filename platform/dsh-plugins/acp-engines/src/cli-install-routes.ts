import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ManagedCliTools } from './managed-cli.ts'
import { CLI_VERSION, RELEASE_ID } from './cli-install-catalog.ts'

function localRequest(req: IncomingMessage): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '')) return false
  try {
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:'
    const host = new URL(`${protocol}//${req.headers.host}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    if (req.method === 'GET' && !req.headers.origin) return true
    const origin = new URL(req.headers.origin ?? '')
    return origin.origin === host.origin
  } catch { return false }
}

/** The parent BFF authenticates requests; installation additionally requires local same-origin access. */
export function handleCliInstallRoute(req: IncomingMessage, res: ServerResponse, sub: string, input: Record<string, unknown>, cli?: ManagedCliTools): boolean {
  const match = /^\/engines\/([a-z0-9][a-z0-9._-]{0,63})\/installation(?:\/(install|cancel))?$/u.exec(sub)
  if (!match) return false
  const json = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
  if (!cli) { json(501, { error: '本机 CLI 安装管理未启用' }); return true }
  if (!localRequest(req)) { json(403, { error: 'CLI 安装管理仅允许本机同源页面访问' }); return true }
  const id = match[1]!, action = match[2]
  try {
    if (!action && req.method === 'GET') json(200, { tool: cli.view(id) })
    else if (action && req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) { json(415, { error: '需要 JSON 请求' }); return true }
      if (action === 'cancel') {
        if (typeof input.jobId !== 'string' || !RELEASE_ID.test(input.jobId)) throw new TypeError('安装任务标识无效')
        json(200, { tool: cli.cancel(id, input.jobId) })
      } else {
        if (typeof input.requestId !== 'string' || !RELEASE_ID.test(input.requestId) || typeof input.version !== 'string' || !CLI_VERSION.test(input.version)
          || !['install', 'reinstall'].includes(String(input.action)) || Object.keys(input).some(key => !['requestId', 'version', 'action'].includes(key))) throw new TypeError('安装参数无效；只接受版本，不接受自定义命令或下载地址')
        json(202, { tool: cli.start(id, { requestId: input.requestId, version: input.version, action: input.action as 'install' | 'reinstall' }) })
      }
    } else json(405, { error: 'method not allowed' })
  } catch (error) { json(error instanceof TypeError ? 400 : 409, { error: error instanceof Error ? error.message : String(error) }) }
  return true
}
