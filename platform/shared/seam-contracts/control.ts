/**
 * 共享执行控制 seam 契约（§8.4）。
 *
 * # 这一层的职责边界（2026-09-17 重新划定）
 *
 * §8.4 在本仓库里有**两个实现**，它们不是「两套做法」而是**一条链的两端**：
 *
 * | 端 | 位置 | 职责 |
 * | --- | --- | --- |
 * | 裁决 + 落库 | `platform/control-plane/session-control`（Go 服务） | 排队 → OPA → 状态机 → CAS 提交 → 审计 |
 * | 生效 | `platform/dsh-plugins/control`（本 seam 的实现方） | 把已确立的状态作用于 agent |
 *
 * 两端共用两张表：`session_control_state`（每会话一行）与 `session_control_audit`（只追加）。
 * **这两张表归 Go 服务唯一所有**——它是状态机的所有者，也是 realm / revision / CAS 的唯一维护者。
 * 本 seam 的实现方**只读状态、不写状态**：控制指令的提交入口是控制面的 HTTP API
 * （`POST /v1/sessions/{ref}/control`），不是这里。
 *
 * # 为什么必须写下来
 *
 * 这条边界此前没有文字约束，于是两侧各自建了这两张表（都用 `CREATE TABLE IF NOT EXISTS`，
 * 先到先得），列集与状态词表都不一致：Go 写 `awaiting-approval` 时，若插件先建表就会被
 * 它的 CHECK 约束拒收；而插件读到不认识的状态时按「没有指令」放行。两侧没有编译期约束，
 * 改一边另一边照样 `tsc` 干净。`control-schema-contract.spec.ts` 是那道约束。
 *
 * # `dispatch` 的两种合法形态（2026-09-17 接线后）
 *
 * 接线之前，`dispatch` 的唯一合法行为是「有权就抛 {@link ControlCommandRoutingError}」——
 * 那是个**占位符**，它的存在意义是提醒「这条链还没接上」。现在它接上了：有权者的指令会
 * 真的 POST 给控制面，并把控制面的结论（{@link ControlDecision.outcome}）带回来。
 *
 * 于是契约从「必须抛错」放宽成**「必须交出控制面证据」**：
 *
 *   - 配了控制面地址 → 返回控制面的 `outcome`（**哪怕控制面回的是拒绝**）；
 *   - 没配控制面地址（例如 local 形态没有这个服务）→ 抛路由错误，明说本实例没接线。
 *
 * 唯一仍然禁止的是：**本层直接声称生效**。那会让调用方以为一条没人执行的指令执行了
 * ——状态行没人写、审计里没有它，事后无从追溯是谁按的按钮。
 */

export type ControlCommand =
  | 'pause' | 'resume' | 'stop' | 'abort'
  | 'approve' | 'reject' | 'replay' | 'degrade'

/**
 * 会话在控制面视角下的执行状态。**唯一事实源是 Go 侧 `internal/state` 的五个 `State` 常量**
 * ——这里镜像一份只为让 TS 侧有可比较的运行时集合，`control-schema-contract.spec.ts`
 * 会现场解析 Go 源码并断言两者相等（不手抄字符串：改名当天测试要红）。
 *
 * 与 §8.4.3 的对应：running / paused / awaiting-approval / aborted 来自该节，
 * `stopped` 是 §8.4.1 的 safe stop 终态。
 */
export const SESSION_CONTROL_STATES = [
  'running', 'paused', 'awaiting-approval', 'stopped', 'aborted',
] as const

export type SessionControlState = (typeof SESSION_CONTROL_STATES)[number]

/**
 * 一条控制指令的**结论分类**。唯一事实源是 Go 侧 `internal/control` 的 `Outcome` 常量，
 * 这里镜像一份，由 `control-schema-contract.spec.ts` 现场解析 Go 源码断言相等。
 *
 * 为什么要按结论而不是布尔来传：调用方的处置完全不同——`policy_denied` 要找管理员、
 * `policy_unavailable` 要去看 OPA、`busy` 要重试、`conflict` 要重读、`state_rejected`
 * 要去看当前状态。合成一个 `false` 会让这五种现场全部指向同一个错误的地方。
 * 控制面侧的 `statusFor` 已经把这件事做在 HTTP 状态码上（见 `internal/server`），
 * 但状态码**丢了区分度**（403 同时是 policy_denied 与 realm_mismatch，409 同时是
 * state_rejected 与 conflict），所以本层读的是响应体里的 `outcome` 字段。
 */
export const CONTROL_OUTCOMES = [
  'applied', 'noop', 'state_rejected', 'policy_denied',
  'policy_unavailable', 'realm_mismatch', 'conflict', 'busy',
] as const

export type ControlOutcome = (typeof CONTROL_OUTCOMES)[number]

/**
 * 只有这两种结论意味着「指令真的生效了」。
 *
 * `noop` 也算生效：它表示指令合法且**已经到达控制面**，只是没有副作用（终态的重复指令、
 * 挂起态重复 pause）。它与 `applied` 的区别是「这次点击有没有改变什么」，不是
 * 「有没有执行」——把 noop 归到失败里会让「重复点按钮」看起来像报错。
 */
export const EFFECTIVE_OUTCOMES: readonly ControlOutcome[] = ['applied', 'noop']

/** 本层（本地 RBAC 前置）的拒因。**不是**控制面的结论词表。 */
export type LocalDenyReason =
  /** realm 层角色授权表里没有这条指令 */
  | 'not-authorized'
  /** 项目层角色收窄后不允许（评审 N4：项目权限不得提升 realm 权限） */
  | 'policy-denied'
  /**
   * 策略引擎（OPA）拿不到判定。**必须与 `policy-denied` 分开**：前者要去看 OPA
   * （临时），后者要找管理员（永久）。控制面侧早就分成了两个 Outcome
   * （`policy_unavailable` / `policy_denied`），本层此前把两者合成一个 `policy-denied`
   * ——「引擎连不上」于是被报成「你没有权限」，运维会去查错地方。
   */
  | 'policy-unavailable'

/**
 * 本地前置策略的结论。**它与 {@link ControlDecision} 不是一回事**：这里的 `allowed`
 * 是「本层不拦」，不是「指令已生效」。分成两个类型是为了让「本层放行」不能冒充
 * 「已生效」——结构上 `ControlPolicyVerdict` 是 `ControlDecision` 的子集，所以本地
 * 拒绝时可以直接把它当作结论返回（那时两个 `allowed=false` 语义恰好重合：都没生效）。
 */
export interface ControlPolicyVerdict {
  allowed: boolean
  reason?: LocalDenyReason
}

export interface ControlPolicy {
  /** 返回 allowed=false + 具体失败原因（策略点由装配层注入，区别于实现细节） */
  evaluate(req: { command: ControlCommand; actor: string; role: string; realm: string; sessionRef: string }): ControlPolicyVerdict | Promise<ControlPolicyVerdict>
}

export interface ControlRequest {
  command: ControlCommand
  sessionRef: string
  actor: string
  role: string
  realm: string
  reason: string
  correlationId: string
}

export interface ControlDecision {
  /**
   * 指令是否**已生效**。仅当 {@link outcome} 是 `applied` / `noop` 时为 true。
   *
   * 它**不是**「本地策略允许」——本地放行而控制面拒绝时这里是 false，且带着控制面的
   * `outcome`。调用方要区分「被拒了」（有 outcome）与「没拿到结论」（实现方抛错）。
   */
  allowed: boolean

  /**
   * 本层前置的拒因。**有它就说明请求根本没到控制面**，因此也就没有 `outcome`。
   * 它与 `outcome` 互斥：出现 `reason` 时是本地拒，出现 `outcome` 时是控制面结论。
   */
  reason?: LocalDenyReason

  /** 控制面的权威结论。仅当请求真的提交到控制面并拿到可识别的响应时出现。 */
  outcome?: ControlOutcome

  /** 控制面给出的可读原因（`Result.reason`）。 */
  detail?: string

  /** 控制面确立的会话状态（`Result.to_state`）。控制台据此不必再读一次。 */
  toState?: SessionControlState

  /** 控制面的状态版本号（`Result.revision`）。 */
  revision?: number

  /** 控制面为这条指令生成的关联 id（审计表里能查到它）。 */
  correlationId?: string
}

export interface ControlAudit {
  /** 控制面审计行的主键（`session_control_audit.id`），只增不减 */
  id: number
  command: ControlCommand
  sessionRef: string
  actor: string
  actorRole: string
  realm: string
  /** 控制面的结论分类（applied / noop / state_rejected / policy_denied / …），非布尔 */
  outcome: string
  fromState: string
  toState: string
  reason: string
  correlationId: string
  revision: number
  createdAt: number
}

export interface ControlSeam {
  /**
   * 读控制面确立的会话状态。**未登记的会话返回 `running`**——与控制面 `store.Load`
   * 对陌生会话的处理一致（首条指令以 running 为起点）。本方法是 agent 生命周期挂点的
   * 热路径，实现方可以缓存（当前 TTL 1s）。
   */
  state(sessionRef: string): Promise<SessionControlState>

  /**
   * 提交一条控制指令。**权威裁决点是控制面里的 OPA**（`session_control.rego`），
   * 落库与审计也在那边；本层只做两件事：
   *
   *   1. 本地 RBAC **前置**：明显越权的请求当场拒掉（`reason` 存在），不为一次必然被拒
   *      的调用打一次网络往返。它不是权威——控制面可能拒绝本地放行的请求。
   *   2. 把放行的请求 POST 给控制面，并把控制面的结论带回来（`outcome` 存在）。
   *
   * 两种合法返回/抛出，**必须给调用方留下「控制面说了什么」的证据**：
   *
   *   - 有 `outcome`：拿到了控制面的裁决（包括被拒——`allowed=false` 且带 `outcome`）。
   *   - 抛 {@link ControlCommandRoutingError}：本实例**没有**配控制面地址，
   *     请调用方自己打 `POST /v1/sessions/{ref}/control`。
   *
   * **不允许**回落成「已生效」（`allowed=true` 而无 `outcome`）——那会让调用方以为一条
   * 没人执行的指令已经执行了。也不允许把「网络不通 / 响应读不懂」当成「被拒」：前者是
   * **没有结论**（抛错，调用方可重试），后者是**确定被拒**（返回结论，重试无意义）。
   * 这与 Go 侧 `Controller.Execute` 的返回值语义同构（`(Result, nil)` 有结论、
   * `(Result{}, err)` 没结论）。
   */
  dispatch(request: ControlRequest): Promise<ControlDecision>

  /** 读控制面的控制时间线（含被拒的尝试）。只读。 */
  audit(sessionRef: string): Promise<ControlAudit[]>
}

/**
 * 本实例没有接控制面，指令必须提交给控制面：
 * `POST /v1/sessions/{ref}/control`。
 *
 * 接线之前它是**唯一**的返回路径（那是个占位符）；现在它只在「没配控制面地址」时抛出，
 * 语义是「这里没有这条链路」，不是「这条指令有问题」。
 */
export class ControlCommandRoutingError extends Error {
  constructor(readonly command: ControlCommand, readonly sessionRef: string) {
    super(
      `控制指令 ${command} 必须提交给控制面：POST /v1/sessions/${encodeURIComponent(sessionRef)}/control。` +
      `本实例未配置控制面地址（lumo-control 的 controlPlaneUrl / LUMO_SESSION_CONTROL_URL），` +
      `而本插件不写 session_control_state / session_control_audit。`,
    )
    this.name = 'ControlCommandRoutingError'
  }
}

/**
 * 提交控制指令时**没有拿到结论**。它与 {@link ControlDecision} 是两个正交的出口：
 *
 *   - 拿到结论（含被拒）→ 返回 `ControlDecision`，调用方按 `outcome` 处置；
 *   - 没拿到结论 → 抛本族错误，调用方按「不知道」处置（通常重试或去看控制面）。
 *
 * **「没拿到结论」不允许被当成「被拒」**：前者重试有意义，后者重试没有意义。
 * 这与 Go 侧 `Controller.Execute` 的 `(Result, nil)` / `(Result{}, err)` 二分同构。
 */
export abstract class ControlPlaneError extends Error {}

/**
 * 控制面不可达：连接被拒、DNS 解析失败、超时、TLS 失败。处置是「稍后重试」。
 *
 * 超时**也算不可达**，哪怕那条指令可能已经在控制面生效了——我们不知道结果，
 * 所以不能报「成功」；也不该报「被拒」，那会让调用方以为重试没用。
 */
export class ControlPlaneUnreachableError extends ControlPlaneError {}

/**
 * 控制面回了响应，但它不是一个可识别的控制面结论：网关的 HTML 错误页、
 * 认证中间件的 `{"error":"control_plane_auth"}`、控制面版本更新后的未知 `outcome`。
 * 处置是「去看控制面」，不是重试。
 *
 * 这一类**必须抛错而不是猜一个结论**：把网关的 502 读成「策略拒绝」会让运维去查
 * 权限，而真实原因是那个服务根本没起来。
 */
export class ControlPlaneProtocolError extends ControlPlaneError {}


/**
 * 契约断言：任何真实 Provider 实现都必须通过。
 * provider 由测试方构造（策略函数由测试注入以模拟有权/无权场景）。
 */
export async function assertControlContract(
  seam: ControlSeam,
  assert: (cond: boolean, msg: string) => void,
) {
  // 1. 词表必须是控制面那一套。少一个状态 = Go 写出的那个状态在插件侧落进「不认识」分支。
  const states = new Set<string>(SESSION_CONTROL_STATES)
  assert(states.size === SESSION_CONTROL_STATES.length, '状态词表不得有重复项')

  const outcomes = new Set<string>(CONTROL_OUTCOMES)
  assert(outcomes.size === CONTROL_OUTCOMES.length, '结论词表不得有重复项')
  for (const effective of EFFECTIVE_OUTCOMES) {
    assert(outcomes.has(effective), `「已生效」结论 ${effective} 不在结论词表里`)
  }

  // 2. 陌生会话的默认状态必须是 running —— 与控制面「首条指令以 running 为起点」一致。
  //    这里**不能**回落成 paused：默认挂起会让每个新会话一上来就拒绝副作用工具。
  const fresh = await seam.state('s-never-seen')
  assert(fresh === 'running', `未登记会话的状态必须是 running，实际 ${fresh}`)

  // 3. 已登记会话读回来的状态必须落在词表内 —— 库里存了词表外的值（例如另一侧
  //    遗留的 stopping）时，插件会静默按「没有指令」处理。
  const known = await seam.state('s1')
  assert(states.has(known), `读回的状态 ${known} 不在词表内`)

  // 4. 无权者的指令必须被本地前置拒掉。
  const req: ControlRequest = {
    command: 'pause', sessionRef: 's1', actor: 'bob',
    role: 'viewer', realm: 'r1', reason: '临时停线', correlationId: 'c1',
  }
  const denied = await seam.dispatch(req)
  assert(!denied.allowed, '无权者的指令必须被拒')

  // 5. 有权者必须把请求交给控制面，且**必须留下证据**：要么返回控制面的结论
  //    （outcome 存在），要么抛路由错误说明本实例没接控制面。
  //    禁止的是「本层直接声称生效」——那会让调用方以为一条没人执行的指令执行了。
  //
  //    证据还必须**自洽**：`allowed` 的语义是「已生效」，所以它必须等于
  //    「outcome 属于 EFFECTIVE_OUTCOMES」。带着结论却把方向说反的实现更危险——
  //    它看起来证据齐全，却会把一条被拒的指令报成成功。
  let routed = false
  let contradiction = ''
  try {
    const decision = await seam.dispatch({ ...req, actor: 'alice', role: 'admin' })
    if (decision.outcome !== undefined) {
      routed = true
      const shouldAllow = EFFECTIVE_OUTCOMES.includes(decision.outcome)
      if (decision.allowed !== shouldAllow) {
        contradiction = `allowed=${decision.allowed} 而 outcome=${decision.outcome}`
      }
    }
  } catch (error) {
    routed = error instanceof ControlCommandRoutingError
  }
  assert(
    routed,
    '有权者的指令必须交给控制面裁决：要么返回控制面的 outcome，要么抛路由错误；不得在本层直接声称生效',
  )
  assert(
    contradiction === '',
    `控制面结论与 allowed 不一致（${contradiction}）：调用方只看 allowed 决定「生效了吗」，` +
    `方向说反会把一条被拒的指令报成成功`,
  )
}
