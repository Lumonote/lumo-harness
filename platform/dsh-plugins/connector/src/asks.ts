/**
 * 连接器调用的 Ask 闸门（P0-1）：网关返回 428 approval_required 时，不再只把状态码
 * 抛给调用方，而是拿到统一 Ask，等待人工决议后用 approvalId 重放**同一请求**。
 *
 * 旧语义保持：网关侧一次性 consume、请求哈希绑定不变；未传 waitForAsk 时行为与
 * 直接调用 client.invoke 相同（GatewayError 照抛）。
 */
import { askFromConnectorApproval, withAskContext, type Ask, type ConnectorApprovalRecord } from '../../../shared/seam-contracts/asks.ts'
import { GatewayError, type ConnectorClient, type InvokeRequest, type InvokeResult } from './client.ts'

export interface AskGateOptions {
  /** 返回 Ask 的最新状态（通常轮询 GET /asks 或订阅 /asks/events）。 */
  fetchAsk: (askID: string, signal?: AbortSignal) => Promise<Ask | undefined>
  /** 新建 Ask 时通知上层（例如渲染到会话里的 user-approval 卡片）。 */
  onAsk?: (ask: Ask) => void
  /** 决议后通知上层（运行树解除关联等）。 */
  onSettled?: (ask: Ask) => void
  /** 执行上下文：写进 Ask.source.run_id / session_ref，使审批能挂到 P0-3 运行树节点。 */
  context?: { run_id?: string; session_ref?: string }
  /** 等待上限（毫秒）；超时按 expired 处理。缺省等到 Ask 自身 expires_at。 */
  maxWaitMs?: number
  pollMs?: number
  signal?: AbortSignal
}

export class AskRejectedError extends Error {
  constructor(readonly ask: Ask) { super(`人工审批未通过：${ask.status}`); this.name = 'AskRejectedError' }
}

/** 从 GatewayError 中取出 428 附带的审批记录（旧线格式 `approval` 字段）。 */
export function askFromGatewayError(error: unknown): Ask | undefined {
  if (!(error instanceof GatewayError) || error.code !== 'approval_required') return undefined
  const detail = error.detail as { approval?: ConnectorApprovalRecord; ask?: Ask } | undefined
  if (detail?.ask) return detail.ask
  return detail?.approval ? askFromConnectorApproval(detail.approval) : undefined
}

export async function waitForAsk(askID: string, options: AskGateOptions): Promise<Ask> {
  const pollMs = options.pollMs ?? 2_000
  const deadline = options.maxWaitMs === undefined ? Infinity : Date.now() + options.maxWaitMs
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
    const ask = await options.fetchAsk(askID, options.signal)
    if (ask && ask.status !== 'pending') return ask
    if (ask && (Date.parse(ask.expires_at) <= Date.now() || Date.now() >= deadline)) return { ...ask, status: 'expired' }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

export async function invokeWithAsk(client: Pick<ConnectorClient, 'invoke'>, req: InvokeRequest, options: AskGateOptions): Promise<InvokeResult> {
  try {
    return await client.invoke(req)
  } catch (error) {
    const raw = askFromGatewayError(error)
    if (raw === undefined) throw error
    const context = options.context ?? { ...(req.sessionRef ? { session_ref: req.sessionRef } : {}) }
    const ask = withAskContext(raw, context)
    options.onAsk?.(ask)
    let settled: Ask
    try {
      settled = withAskContext(await waitForAsk(ask.id, options), context)
    } catch (waitError) {
      // 中止也要解除运行树关联，否则节点会一直停在 awaiting_ask。
      options.onSettled?.({ ...ask, status: 'cancelled' })
      throw waitError
    }
    options.onSettled?.(settled)
    if (settled.status !== 'answered' || settled.answer?.value === 'reject') throw new AskRejectedError(settled)
    return client.invoke({ ...req, approvalId: settled.source.ref })
  }
}
