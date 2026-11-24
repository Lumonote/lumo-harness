/**
 * 远程电脑本机确认 → 统一 Ask 的接线（完成 computer-use/src/remote-asks.ts 头部 TODO 1–4）。
 *
 * 在 lumo-ui 的 /lumo/api/asks* 路由之前接入（index.ts 一行），只处理本机账本相关的部分：
 *  1. GET  /lumo/api/asks            → 上游 connector 列表 ∪ remoteComputerAsks(service.list())
 *                                      （上游未配置或失败时仍返回本机部分，并带 upstream_error）
 *  2. POST /lumo/api/asks/remote-computer:{id}/answer {value}
 *        approve：先经 P1 设备动作框架弹**本机原生确认框**（DeviceActionsClient.confirm），
 *        用户在本机点「允许」才调 broker.decide(approve=true)；reject 直接 decide(approve=false)。
 *        桌面端不可用时 approve 返回 501（仍可用旧的 /lumo/api/remote-computer/{id}/decide 页面确认）。
 *  3. POST /lumo/api/asks/remote-computer:{id}/cancel → broker.revoke(id, digest)
 *  4. 每次本机状态变化后把 Ask 关联写入运行树（ask.pending / ask.resolved，按 plan.session_ref 挂节点）；
 *     列表读取时也补发一次 pending 关联（幂等，reducer 按 askId 去重）。
 * 不改 remote-broker.ts 的 lease / digest / revision 状态机。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { REMOTE_COMPUTER_ASK_PREFIX, answerRemoteComputerAsk, remoteComputerAsk, remoteComputerAsks } from '../../computer-use/src/remote-asks.ts'
import type { RemoteComputerLocalRequest } from '../../../shared/seam-contracts/remote-computer.ts'
import { runTreeLinkOf, type Ask } from '../../../shared/seam-contracts/asks.ts'
import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'

export interface RemoteAskService {
  list(): RemoteComputerLocalRequest[] | Promise<RemoteComputerLocalRequest[]>
  decide(id: string, decision: { digest: string; approve: boolean }): Promise<RemoteComputerLocalRequest>
  revoke(id: string, digest: string): Promise<unknown>
}
export interface LocalConfirm { confirm(title: string, detail: string): Promise<boolean> }

export interface RemoteAsksRouteDeps {
  service: RemoteAskService | undefined
  confirm: LocalConfirm | undefined
  runTree?: { apply(event: RunTreeEvent): unknown }
  connectorUrl: string
  headers: Record<string, string>
  timeoutMs: number
  readBody: (req: IncomingMessage) => Promise<Buffer>
  fetchImpl?: typeof fetch
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function linkRemoteAsk(runTree: RemoteAsksRouteDeps['runTree'], ask: Ask): void {
  if (!runTree) return
  const link = runTreeLinkOf(ask)
  const base = { askId: link.askId, ...(link.runId ? { runId: link.runId } : {}), ...(link.sessionRef ? { sessionRef: link.sessionRef } : {}) }
  try { runTree.apply(link.state === 'pending' ? { type: 'ask.pending', ...base } : { type: 'ask.resolved', ...base }) } catch { /* 运行树故障不影响确认 */ }
}

/** 处理了返回 true；其余交给 handleAsksRoute。service 未装配时完全不接管（行为与旧版一致）。 */
export async function handleRemoteAsksRoute(req: IncomingMessage, res: ServerResponse, pathname: string, deps: RemoteAsksRouteDeps): Promise<boolean> {
  const service = deps.service
  if (!service) return false
  if (req.method === 'GET' && pathname === '/lumo/api/asks') {
    const local = remoteComputerAsks(await service.list())
    for (const ask of local) if (ask.status === 'pending') linkRemoteAsk(deps.runTree, ask)
    let upstream: Ask[] = []
    let upstreamError: string | undefined
    const base = deps.connectorUrl.replace(/\/+$/u, '')
    if (base) {
      try {
        const query = new URL(req.url ?? '/', 'http://lumo.local').search
        const r = await (deps.fetchImpl ?? fetch)(`${base}/asks${query}`, { headers: deps.headers, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs) })
        if (r.ok) upstream = ((await r.json()) as { asks?: Ask[] }).asks ?? []
        else upstreamError = `connector ${r.status}`
      } catch (error) { upstreamError = error instanceof Error ? error.message : 'connector 不可达' }
    }
    const status = new URL(req.url ?? '/', 'http://lumo.local').searchParams.get('status')
    const merged = [...upstream, ...(status ? local.filter(a => a.status === status) : local)]
    json(res, 200, { asks: merged, ...(upstreamError ? { upstream_error: upstreamError } : {}) })
    return true
  }
  const match = /^\/lumo\/api\/asks\/([^/]+)\/(answer|cancel)$/u.exec(pathname)
  if (req.method !== 'POST' || !match) return false
  const askId = decodeURIComponent(match[1]!)
  if (!askId.startsWith(REMOTE_COMPUTER_ASK_PREFIX)) return false
  const requestId = askId.slice(REMOTE_COMPUTER_ASK_PREFIX.length)
  const row = (await service.list()).find(r => r.envelope.request_id === requestId)
  if (!row) { json(res, 404, { error: 'ask not found' }); return true }
  try {
    if (match[2] === 'cancel') {
      await service.revoke(requestId, row.envelope.digest)
      const after = (await service.list()).find(r => r.envelope.request_id === requestId) ?? row
      const ask = remoteComputerAsk(after)
      linkRemoteAsk(deps.runTree, ask)
      json(res, 200, { ask }); return true
    }
    let value: string
    try { value = String((JSON.parse((await deps.readBody(req)).toString('utf8') || '{}') as { value?: unknown }).value ?? '') } catch { json(res, 400, { error: 'invalid_json' }); return true }
    if (value.trim() === 'approve') {
      if (!deps.confirm) { json(res, 501, { error: '需要桌面端本机确认：请在桌面版 Lumo 中操作，或使用远程电脑确认页' }); return true }
      const ok = await deps.confirm.confirm('远程电脑操作确认', `${row.plan.sender_user_id || row.plan.owner_user_id} 请求在这台电脑上执行：${row.plan.capability}\n\n${row.plan.intent}\n\n有效期至 ${row.plan.expires_at}`)
      if (!ok) value = 'reject'
    }
    const ask = await answerRemoteComputerAsk(service, row, value)
    linkRemoteAsk(deps.runTree, ask)
    json(res, 200, { ask })
  } catch { json(res, 409, { error: 'remote_computer_decision_uncertain' }) }
  return true
}
