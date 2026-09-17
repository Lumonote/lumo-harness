/**
 * 共享执行控制的**生效面 + 提交面**（§8.4 + 铁律 18）。
 *
 * 本类是 §8.4 链条的**下游**：控制指令的裁决、落库与审计都在 Go 控制面
 * （`platform/control-plane/session-control`），本插件负责两件事：
 *
 *   1. **提交**：把一条控制指令 POST 给控制面（`dispatch`）；
 *   2. **生效**：让**已经确立的状态**对 agent 生效（`agent/turn-stopping` /
 *      `tools/pre-execute` 两个挂点）。
 *
 * # 表的所有权（2026-09-17 定）
 *
 * | 表 | 所有者 | 本类 |
 * | --- | --- | --- |
 * | `session_control_state` | Go 控制面（realm / revision / CAS 的唯一维护者） | **只读** |
 * | `session_control_audit` | Go 控制面（含被拒尝试） | **只读** |
 * | `session_controllers` | 本插件（§8.4.2 的 co-controller 名单） | 读写 |
 *
 * **本类不再建前两张表**。此前两边都用 `CREATE TABLE IF NOT EXISTS` 各建一份，列集与状态
 * 词表都不同——先到先得，后到者静默拿到一张自己不认识的表：Go 写 `awaiting-approval` 会被
 * 这边的 CHECK 拒收，而这边读到不认识的状态时按「没有指令」放行。约束见
 * `control-schema-contract.spec.ts`。
 *
 * 提交面走 HTTP 而不是直写表，与「只读」是同一件事的两面：状态行有 CAS、审计行有 realm
 * 归属，任何绕过控制面的写入都会破坏这两者。**本类从不写这两张表，一条也不写。**
 *
 * # 权限模型
 *
 * 三层取交集（realm RBAC ∩ 项目角色 ∩ 会话控制权），且项目权限不得提升 realm 权限
 * （评审 N4 —— 否则建项目即可越权，是权限提升漏洞）。本层只是**前置**：
 * 权威裁决是控制面的 OPA。
 */
import pg from 'pg'
import {
  CONTROL_OUTCOMES,
  EFFECTIVE_OUTCOMES,
  SESSION_CONTROL_STATES,
  ControlCommandRoutingError,
  ControlPlaneProtocolError,
  ControlPlaneUnreachableError,
  type ControlAudit,
  type ControlCommand,
  type ControlDecision,
  type ControlOutcome,
  type ControlPolicy,
  type ControlRequest,
  type ControlSeam,
  type SessionControlState,
} from '../../../shared/seam-contracts/control.ts'

export { SESSION_CONTROL_STATES, type SessionControlState } from '../../../shared/seam-contracts/control.ts'

/** 本插件**自己拥有**的表。共用的两张表由 Go 控制面建，这里不碰。 */
export const CONTROL_DDL = `
-- 会话控制权名单（session manifest 指派的 co-controller，§8.4.2）。
-- 唯一一张由本插件拥有的表：控制面的 OPA 策略目前只按角色裁决，尚未读它。
CREATE TABLE IF NOT EXISTS session_controllers (
  session_ref TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  commands    TEXT[] NOT NULL,
  PRIMARY KEY (session_ref, user_id)
);
`

/**
 * 单次提交的缺省超时。**这个数是从控制面的两个时间上限推出来的，不是拍的**：
 *
 *   - 控制面把一条指令在本实例队列里的最长等待定为 `LUMO_SESSION_CONTROL_WAIT`
 *     （缺省 5s，见 `cmd/session-control/main.go` 的 `defaultWaitLimit`）；
 *   - 单条脉冲的持有上限是 `LUMO_SESSION_CONTROL_HOLD`（缺省 30s）。
 *
 * 超时若**小于**队列等待上限，就会在控制面还没走完队列时断开——而那条指令可能已经被
 * 提交并生效了，于是「超时」被报成失败，调用方重试一次就多出一条审计行。
 * 取 10s 是「大于队列等待、小于持有上限」：覆盖正常路径，又不会把调用方堵住一整个
 * 持有周期。部署把 `LUMO_SESSION_CONTROL_WAIT` 调大时要同步调大这里。
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000

/** 控制面提交面的配置。 */
export interface ControlPlaneConfig {
  /** 控制面基址（例如 `http://session-control:8092`）。空/缺省 = 本实例没接控制面。 */
  baseUrl?: string
  /** 控制面共享令牌（`LUMO_CONTROL_PLANE_TOKEN`）。 */
  token?: string
  /** 单次提交的超时（毫秒），见 {@link DEFAULT_DISPATCH_TIMEOUT_MS}。 */
  timeoutMs?: number
}

interface ControlPlane {
  base: string
  token: string
  timeoutMs: number
}

export class PgControlSeam implements ControlSeam {
  private pool: pg.Pool
  private readonly policy: ControlPolicy
  private readonly controlPlane: ControlPlane | undefined

  constructor(connectionString: string, policy: ControlPolicy, controlPlane: ControlPlaneConfig = {}) {
    this.pool = new pg.Pool({ connectionString })
    this.policy = policy
    this.controlPlane = resolveControlPlane(controlPlane)
  }

  async init(): Promise<void> {
    await this.pool.query(CONTROL_DDL)
  }

  /**
   * 提交一条控制指令（契约见 `ControlSeam.dispatch`）。三步：
   *
   *   1. 本地 RBAC 前置。拒则**直接返回**——请求根本没到控制面，所以没有 `outcome`。
   *   2. 没配控制面地址 → 抛 {@link ControlCommandRoutingError}，明说本实例没接线。
   *   3. POST 给控制面，把它的结论（含拒绝）带回来。
   *
   * 第 3 步里**没有结论**的情况一律抛 {@link ControlPlaneError} 的子类：网络不通、
   * 响应读不懂。它们与「被拒」是两回事——见 `ControlPlaneError` 的注释。
   */
  async dispatch(request: ControlRequest): Promise<ControlDecision> {
    const decision = await this.policy.evaluate({
      command: request.command,
      actor: request.actor,
      role: request.role,
      realm: request.realm,
      sessionRef: request.sessionRef,
    })
    if (!decision.allowed) return decision

    const plane = this.controlPlane
    if (plane === undefined) throw new ControlCommandRoutingError(request.command, request.sessionRef)
    return await submit(plane, request)
  }

  /** 控制面的控制时间线（含被拒尝试）。只读——列名是 Go 侧 `session_control_audit` 的列名。 */
  async audit(sessionRef: string): Promise<ControlAudit[]> {
    const rows = await this.pool.query<{
      id: string
      command: string
      session_ref: string
      actor: string
      actor_role: string
      realm: string
      outcome: string
      from_state: string
      to_state: string
      reason: string
      correlation_id: string
      revision: string
      created_at: Date
    }>(
      `SELECT id, command, session_ref, actor, actor_role, realm, outcome,
              from_state, to_state, reason, correlation_id, revision, created_at
         FROM session_control_audit WHERE session_ref = $1 ORDER BY id`,
      [sessionRef],
    )
    return rows.rows.map((r) => ({
      id: Number(r.id),
      command: r.command as ControlCommand,
      sessionRef: r.session_ref,
      actor: r.actor,
      actorRole: r.actor_role,
      realm: r.realm,
      outcome: r.outcome,
      fromState: r.from_state,
      toState: r.to_state,
      reason: r.reason,
      correlationId: r.correlation_id,
      revision: Number(r.revision),
      createdAt: r.created_at.getTime(),
    }))
  }

  /**
   * 当前控制状态（agent 生命周期挂点读取）。
   *
   * 未登记 → `running`：与控制面 `store.Load` 对陌生会话的处理一致（首条指令以 running
   * 为起点）。**不能**回落成 `paused`——那会让每个新会话一上来就拒绝副作用工具。
   */
  async state(sessionRef: string): Promise<SessionControlState> {
    const row = await this.pool.query<{ state: SessionControlState }>(
      'SELECT state FROM session_control_state WHERE session_ref = $1',
      [sessionRef],
    )
    return row.rows[0]?.state ?? 'running'
  }

  /** 指派会话控制权（§8.4.2 co-controller 名单）。本插件自有的表。 */
  async grant(sessionRef: string, userId: string, commands: ControlCommand[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_controllers (session_ref, user_id, commands) VALUES ($1,$2,$3)
       ON CONFLICT (session_ref, user_id) DO UPDATE SET commands = EXCLUDED.commands`,
      [sessionRef, userId, commands],
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** 规范化控制面配置。URL 在这里校验一次，避免每条指令都在 `fetch` 里才炸。 */
function resolveControlPlane(config: ControlPlaneConfig): ControlPlane | undefined {
  const raw = config.baseUrl?.trim()
  if (!raw) return undefined
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('control: invalid control plane URL')
  }
  return {
    base: url.href.replace(/\/+$/u, ''),
    token: config.token ?? '',
    timeoutMs: config.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
  }
}

/**
 * POST 一条控制指令并解析结论。
 *
 * # 为什么按 `outcome` 而不是 HTTP 状态码判
 *
 * 控制面的 `statusFor` 已经把结论映射到状态码上，但那张表是**多对一**的：403 同时是
 * `policy_denied` 与 `realm_mismatch`，409 同时是 `state_rejected` 与 `conflict`。
 * 调用方要的是「去找管理员」还是「重读状态」，状态码答不了。
 *
 * 也**不**在 TS 侧抄一份 status→outcome 的对照表来交叉校验：那会是同一个契约面的第二份
 * 实现，两边一旦漂移，症状是「某条指令被静默归错类」。控制面是权威，这里只读它的结论。
 *
 * # 非 2xx 但有合法 outcome 的响应是**结论**，不是错误
 *
 * 被拒的指令（403/409）同样带 `outcome`，必须原样返回给调用方——把它抛成错误会让
 * 「求权限」和「服务挂了」变成同一种处置。
 */
async function submit(plane: ControlPlane, request: ControlRequest): Promise<ControlDecision> {
  const url = `${plane.base}/v1/sessions/${encodeURIComponent(request.sessionRef)}/control`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      // 重定向到一个登录页/网关页会把「没认证」读成「控制面没回答」，方向虽然安全
      // （都是没结论），但诊断信息全丢。与 `OpaControlPolicy` 保持同款。
      redirect: 'error',
      signal: AbortSignal.timeout(plane.timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(plane.token ? { authorization: `Bearer ${plane.token}` } : {}),
      },
      body: JSON.stringify({
        command: request.command,
        realm: request.realm,
        role: request.role,
        actor: request.actor,
        reason: request.reason,
        correlation_id: request.correlationId,
      }),
    })
  } catch (error) {
    throw new ControlPlaneUnreachableError(
      `控制面不可达（POST ${url}，超时 ${plane.timeoutMs}ms）：${messageOf(error)}`,
      { cause: error },
    )
  }

  // 先取原文再解析：`response.json()` 在 HTML 错误页上抛的错不带原文，
  // 而「到底收到了什么」正是排查这类问题唯一有用的信息。
  const raw = await response.text()
  const body: unknown = parseJson(raw)
  const outcome = readOutcome(body)
  if (outcome === undefined) {
    throw new ControlPlaneProtocolError(
      `控制面 POST ${url} 回了 ${response.status}，但响应体不是一个可识别的控制面结论` +
      `（缺少 outcome 字段，或它的值不在词表内）。常见成因：` +
      `LUMO_CONTROL_PLANE_TOKEN 不匹配（认证中间件回 {"error":"control_plane_auth"}）、` +
      `地址指向了别的服务（网关的 HTML 错误页）、控制面版本比本插件新（多了一种 outcome）。` +
      `原文前 200 字：${raw.slice(0, 200)}`,
    )
  }

  const record = body as Record<string, unknown>
  return {
    // `allowed` 的语义是「已生效」，**只**由 outcome 决定 —— 不看状态码，也不因为
    // 「HTTP 请求成功了」就置 true。一条被拒的指令同样有成功的 HTTP 往返。
    allowed: EFFECTIVE_OUTCOMES.includes(outcome),
    outcome,
    detail: typeof record['reason'] === 'string' ? record['reason'] : undefined,
    toState: readState(record['to_state']),
    revision: typeof record['revision'] === 'number' ? record['revision'] : undefined,
    correlationId: typeof record['correlation_id'] === 'string' ? record['correlation_id'] : undefined,
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 取出合法的 outcome。取不到就返回 undefined（调用方抛协议错，不猜一个结论）。 */
function readOutcome(body: unknown): ControlOutcome | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)['outcome']
  if (typeof value !== 'string') return undefined
  return (CONTROL_OUTCOMES as readonly string[]).includes(value) ? (value as ControlOutcome) : undefined
}

/** 读回控制面确立的状态。词表外的值当作「没给」——不把它塞进 `SessionControlState`。 */
function readState(value: unknown): SessionControlState | undefined {
  if (typeof value !== 'string') return undefined
  return (SESSION_CONTROL_STATES as readonly string[]).includes(value)
    ? (value as SessionControlState)
    : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
