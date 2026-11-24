/**
 * 远程电脑本机确认 → 统一 Ask 适配层（P0-1，只做投影与回答转发）。
 *
 * RemoteComputerBroker 的 lease / digest / revision 语义保持不变：本文件**不**改
 * broker 的状态机，只把本地账本行投影成 `source.kind='remote-computer'` 的 Ask，
 * 并把 Ask 回答（approve / reject）翻译成 `broker.decide(id, { digest, approve })`。
 *
 * 接线（P1 设备动作，已完成）：见 lumo-ui/src/remote-asks-wiring.ts
 *  1. /lumo/api/asks 列表合并 `remoteComputerAsks(broker.list())`；
 *  2. /asks/remote-computer:{id}/answer → approve 先经桌面端本机原生确认框，再 `answerRemoteComputerAsk`；
 *  3. /asks/remote-computer:{id}/cancel → `broker.revoke(id, digest)`；
 *  4. 状态变化后写运行树 ask.pending / ask.resolved（按 plan.session_ref）。
 * 仍未做：broker.persist 内部主动广播（需要改 remote-broker.ts，当前由路由层在读取/作答时补发）。
 */
import { APPROVAL_OPTIONS, validateAnswer, type Ask, type AskStatus } from '../../../shared/seam-contracts/asks.ts'
import type { RemoteComputerLocalRequest } from '../../../shared/seam-contracts/remote-computer.ts'

export const REMOTE_COMPUTER_ASK_PREFIX = 'remote-computer:'

/** 账本状态 → Ask 状态。running/completed/failed/unknown 都意味着「已批准」（source_status 区分执行结果）。 */
export function remoteAskStatus(row: Pick<RemoteComputerLocalRequest, 'state'> & { plan: { expires_at: string } }, now = Date.now()): AskStatus {
  switch (row.state) {
    case 'pending': return Date.parse(row.plan.expires_at) <= now ? 'expired' : 'pending'
    case 'denied': return 'rejected'
    case 'cancelled': return 'cancelled'
    default: return 'answered'
  }
}

export function remoteComputerAsk(row: RemoteComputerLocalRequest, now = Date.now()): Ask {
  const status = remoteAskStatus(row, now)
  return {
    id: `${REMOTE_COMPUTER_ASK_PREFIX}${row.envelope.request_id}`,
    kind: 'approval',
    status,
    realm: row.plan.realm,
    title: `远程电脑操作确认：${row.plan.capability}`,
    detail: `${row.plan.intent}\n\n仅本机所有者可确认；有效期至 ${row.plan.expires_at}。`,
    options: APPROVAL_OPTIONS,
    source: { kind: 'remote-computer', ref: row.envelope.request_id, session_ref: row.plan.session_ref },
    requester_user_id: row.plan.sender_user_id || row.plan.owner_user_id,
    ...(row.plan.project_id ? { project_id: row.plan.project_id } : {}),
    created_at: new Date(now).toISOString(),
    expires_at: row.plan.expires_at,
    source_status: row.state,
  }
}

export function remoteComputerAsks(rows: readonly RemoteComputerLocalRequest[], now = Date.now()): Ask[] {
  return rows.map(row => remoteComputerAsk(row, now))
}

/** Ask 回答 → broker.decide。digest 取自账本行，调用方无法伪造。 */
export async function answerRemoteComputerAsk(
  broker: { decide(id: string, decision: { digest: string; approve: boolean }): Promise<RemoteComputerLocalRequest> },
  row: RemoteComputerLocalRequest,
  value: string,
): Promise<Ask> {
  const ask = remoteComputerAsk(row)
  const error = validateAnswer(ask, { value })
  if (error) throw Error('REMOTE_COMPUTER_REQUEST_CONFLICT')
  return remoteComputerAsk(await broker.decide(row.envelope.request_id, { digest: row.envelope.digest, approve: value.trim() === 'approve' }))
}
