/**
 * subagent-remote 的 HTTP 客户端:父节点对 Scheduler 放置/终态、承载节点 start/stop
 * 的出站调用(fetch 风格照 connector/src/client.ts:超时合并、结构化错误优先、
 * 非结构化按状态映射;错误归因分两族 —— Scheduler 域外语义与基础设施走 dsh
 * `SubagentError`,承载节点 wire 失败走平台 `SeamError`,code 透传由调用方定夺重试)。
 */
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { SeamError } from '../../../shared/seam-contracts/errors.ts'
import { codeForStatus, type SeamErrorCode } from '../../../shared/seam-contracts/remote.ts'
import type { ChildResultBody, StartChildRequest, StartChildFail } from '../../../shared/seam-contracts/subagent-host.ts'

/** 单次调用超时(控制面内网调用;过短误杀健康节点,undici 默认 300s 又太长)。 */
const TIMEOUT_MS = 30_000

/**
 * Scheduler 放置:`POST {schedulerUrl}/v1/placements`(X-Lumo-Realm 头)。
 * 201 → node_id(放置成功);202 → 域外(队列形态不支持,`REMOTE_PLACEMENT_QUEUED`);
 * 其它 → 基础设施 `SubagentError`(服务端错误码透传)。
 */
export async function postPlacement(opts: {
  base: string
  realm: string
  childId: string
}): Promise<string> {
  const res = await rawFetch(`${opts.base}/v1/placements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lumo-realm': opts.realm },
    body: JSON.stringify({ task_id: opts.childId, cluster_id: '', requires: [], priority: 0 }),
  })
  if (res.status === 202) {
    throw new SubagentError(
      `Scheduler 已排队(task_id=${opts.childId}):队列形态域外 —— 本切片要求同步放置`,
      'REMOTE_PLACEMENT_QUEUED',
    )
  }
  if (res.status !== 201) {
    const detail = await schedulerErrorOf(res)
    throw new SubagentError(
      `Scheduler 放置失败(HTTP ${res.status})${detail.message !== undefined ? `: ${detail.message}` : ''}`,
      detail.error ?? 'internal',
    )
  }
  const body = (await res.json()) as Record<string, unknown>
  const nodeId = body['node_id']
  if (typeof nodeId !== 'string' || nodeId === '') {
    throw new SubagentError(`Scheduler 201 应答缺 node_id(收到 ${JSON.stringify(body)})`, 'internal')
  }
  return nodeId
}

/**
 * 承载 start:`POST {nodeUrl}/subagent/start`(realm + 令牌头)。
 * 200 → 成功;StartChildFail → `SeamError`(code 透传,重试与否由 code 定);
 * 非结构化错误 → 按状态映射(codeForStatus)。
 */
export async function postChildStart(opts: {
  base: string
  realm: string
  token?: string
  request: StartChildRequest
}): Promise<void> {
  const res = await rawFetch(`${opts.base}/subagent/start`, {
    method: 'POST',
    headers: jsonHeaders(opts.realm, opts.token),
    body: JSON.stringify(opts.request),
  })
  if (res.ok) return
  const fail = await startChildFailOf(res)
  throw new SeamError(codeOf(fail?.code, res.status), fail?.message ?? `承载节点返回 ${res.status}`)
}

/** 承载 stop:`POST {nodeUrl}/subagent/stop`。幂等由承载侧保证(未知 runId 也 200)。 */
export async function postChildStop(opts: {
  base: string
  realm: string
  token?: string
  childId: string
}): Promise<void> {
  const res = await rawFetch(`${opts.base}/subagent/stop`, {
    method: 'POST',
    headers: jsonHeaders(opts.realm, opts.token),
    body: JSON.stringify({ childId: opts.childId }),
  })
  if (res.ok) return
  const fail = await startChildFailOf(res)
  throw new SeamError(codeOf(fail?.code, res.status), fail?.message ?? `承载节点返回 ${res.status}`)
}

/**
 * 拒绝码归因:承载侧 StartChildFail.code 透传(平台 SeamError 族);
 * 通不过边界校验的宿主在 `codeOf` 内被归为 `internal`(未知状态一律当作 internal,不猜)。
 */
function codeOf(wireCode: string | undefined, status: number): SeamErrorCode {
  const mapped = wireCode ?? codeForStatus(status)
  if (mapped === 'forbidden' || mapped === 'invalid' || mapped === 'unavailable'
    || mapped === 'timeout' || mapped === 'internal' || mapped === 'capability_unavailable') {
    return mapped
  }
  return 'internal'
}

/**
 * Scheduler 终态上报:`POST {schedulerUrl}/v1/tasks/{childId}/result`(best-effort:
 * 失败不阻塞回执结集,失败吞掉由调用方负责 —— callback.ts 的 reportTerminal)。
 */
export async function postTerminalState(opts: {
  base: string
  realm: string
  childId: string
  state: string
}): Promise<void> {
  const res = await rawFetch(`${opts.base}/v1/tasks/${encodeURIComponent(opts.childId)}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lumo-realm': opts.realm },
    body: JSON.stringify({ state: opts.state }),
  })
  if (res.ok) return
  const detail = await schedulerErrorOf(res)
  throw new SubagentError(
    `Scheduler 终态上报失败(HTTP ${res.status})${detail.message !== undefined ? `: ${detail.message}` : ''}`,
    detail.error ?? 'internal',
  )
}

/** 回执体 → Scheduler 终态词表(scheduler-tasks.state 闭集 COMPLETED/FAILED/ABORTED)。 */
export function terminalStateOf(body: ChildResultBody): string {
  if (!body.ok) return 'FAILED'
  switch (body.stopReason) {
    case 'completed': return 'COMPLETED'
    case 'aborted': return 'ABORTED'
    // error/max-tokens/refusal 都是任务层面的失败结局;缺省 stopReason 不猜成功
    default: return 'FAILED'
  }
}

function jsonHeaders(realm: string, token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-lumo-realm': realm,
    ...(token !== undefined ? { 'x-lumo-seam-token': token } : {}),
  }
}

/**
 * 通用出站取回:超时(AbortSignal.timeout)与网络层失败分类 ——
 * 超时 → `timeout`(可重试);连接失败/DNS → `unavailable`(可重试,遥感熔断)。
 */
async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new SeamError('timeout', `调用 ${url} 超时(${TIMEOUT_MS}ms)`)
    }
    throw new SeamError('unavailable', `调用 ${url} 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 解析 StartChildFail(承载侧 wire 的 ok:false 信封);非该形状返回 undefined(不猜)。 */
async function startChildFailOf(res: Response): Promise<StartChildFail | undefined> {
  try {
    const body = (await res.json()) as Record<string, unknown>
    if (body['ok'] === false && typeof body['code'] === 'string' && typeof body['message'] === 'string') {
      return { ok: false, code: body['code'], message: body['message'] }
    }
  } catch {
    /* 非 JSON:回退状态映射 */
  }
  return undefined
}

/** 解析 Scheduler 错误体(Go writeError 的 {error, message});不可解析 → 不反馈细节。 */
async function schedulerErrorOf(res: Response): Promise<{ error?: string; message?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown>
    return {
      ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
      ...(typeof body['message'] === 'string' ? { message: body['message'] } : {}),
    }
  } catch {
    return {}
  }
}
