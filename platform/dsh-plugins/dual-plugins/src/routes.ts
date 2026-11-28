/**
 * 人用通道 BFF：/lumo/api/dual/*。由 lumo-ui index.ts 一行接入。
 *   GET  /lumo/api/dual/plugins                 清单（页面 + 工具），给 UI 列页面、展示工具与风险
 *   POST /lumo/api/dual/tools/{name}/invoke     人从页面直接调用（channel=ui），同样走判定/Ask/运行树
 *   GET  /lumo/api/dual/asks?status=pending     工具审批 Ask（P0-1 同形）
 *   POST /lumo/api/dual/asks/{id}/answer {value}
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Ask } from '../../../shared/seam-contracts/asks.ts'
import type { DualPluginGateway } from './gateway.ts'
import { TOOL_NAME_RE } from './manifest.ts'

export const ownsToolAsk = (ask: Ask, identity: DualRouteDeps['identity']) => ask.realm === identity.realm && ask.requester_user_id === identity.userId && (ask.project_id || undefined) === (identity.projectId || undefined)

export const DUAL_PREFIX = '/lumo/api/dual'
export interface DualRouteDeps {
  gateway: DualPluginGateway | undefined
  identity: { userId: string; realm: string; projectId?: string | undefined }
  readBody: (req: IncomingMessage) => Promise<Buffer>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, deps: DualRouteDeps): Promise<Record<string, unknown>> {
  const raw = (await deps.readBody(req)).toString('utf8')
  if (raw.trim() === '') return {}
  const v: unknown = JSON.parse(raw)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('需要 JSON 对象')
  return v as Record<string, unknown>
}

const STATUS: Record<string, number> = { unknown_tool: 404, channel_closed: 403, invalid_args: 400, denied: 403, rejected: 409, ask_expired: 409, aborted: 409, result_unknown: 504, failed: 502, disabled: 501 }

export async function handleDualRoute(req: IncomingMessage, res: ServerResponse, pathname: string, deps: DualRouteDeps): Promise<boolean> {
  if (pathname !== DUAL_PREFIX && !pathname.startsWith(`${DUAL_PREFIX}/`)) return false
  const { gateway, identity } = deps
  if (!gateway) { json(res, 501, { error: '双受众插件已关闭（LUMO_DUAL_PLUGINS=off）' }); return true }
  try {
    if (req.method === 'GET' && pathname === `${DUAL_PREFIX}/plugins`) { json(res, 200, { plugins: gateway.listPlugins(), decider: gateway.decider.adapter }); return true }
    const inv = pathname.match(/^\/lumo\/api\/dual\/tools\/([^/]+)\/invoke$/u)
    if (req.method === 'POST' && inv) {
      const name = decodeURIComponent(inv[1]!)
      if (!TOOL_NAME_RE.test(name)) { json(res, 400, { error: 'invalid tool name' }); return true }
      const body = await readJson(req, deps)
      const r = await gateway.invoke(name, body.args ?? {}, { realm: identity.realm, userId: identity.userId, ...(identity.projectId ? { projectId: identity.projectId } : {}), channel: 'ui' })
      json(res, r.ok ? 200 : (STATUS[r.code] ?? 500), r); return true
    }
    if (req.method === 'GET' && pathname === `${DUAL_PREFIX}/asks`) {
      const status = new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('status') ?? undefined
      json(res, 200, { asks: gateway.asks.list({ userId: identity.userId, ...(status ? { status } : {}) }).filter(ask => ownsToolAsk(ask, identity)) }); return true
    }
    const ans = pathname.match(/^\/lumo\/api\/dual\/asks\/([^/]+)\/answer$/u)
    if (req.method === 'POST' && ans) {
      const id = decodeURIComponent(ans[1]!)
      if (!/^run:dual-[A-Za-z0-9-]{1,64}$/u.test(id)) { json(res, 400, { error: 'invalid ask id' }); return true }
      const ask = gateway.asks.get(id)
      if (!ask || !ownsToolAsk(ask, identity)) { json(res, 404, { error: 'ask 不存在' }); return true }
      const body = await readJson(req, deps)
      const r = gateway.asks.answer(id, typeof body.value === 'string' ? body.value : '', identity.userId)
      json(res, r.ok ? 200 : 409, r); return true
    }
    json(res, 404, { error: 'unknown_dual_endpoint' }); return true
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : 'bad request' }); return true
  }
}
