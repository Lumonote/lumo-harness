/**
 * 跨节点子代理委派的 wire 契约（行 5 切片 1：one-shot spawn）。
 *
 * 为什么定这些形态（与 dsh 型**结构等价、零 import dsh**，session-log.ts 先例）：
 *
 * 1. **父描述 `ChildParentDescriptor`** —— 行 5 的核心困难是「spawn 在父节点、
 *    执行在承载节点」。dsh 的 `SubagentProvider.start` 收的是 `parent: Agent`：
 *    活的进程内对象，跨节点不可序列化，承载节点上根本没有它。所以把子代理真正需要
 *    继承的少数事实（sessionId/cwd/委派深度/路由/策略）降成可传输的快照；
 *    meta 只有 header 纯数据（行 5 审计明示「spawn 本体进程内」），描述即可重建。
 *
 * 2. **回执闭集 `ChildResultBody`** —— 父侧要以「结局」而不是「异常」接受子代理收场。
 *    `stopReason` 是 dsh turn 终端的映射闭集（completed/aborted/error/max-tokens/refusal），
 *    枚举不出自由文本，父侧才能分类处置（重试/展示/上报）；`ok:false` 是基础设施故障
 *    （reject），与 `ok:true` 内 stopReason 承载 child 结局是两回事——拒绝静默猜测。
 *
 * 3. **运行键 `runKeyOf` 的 realm 段隔离** —— 承载侧运行表是跨 realm 共享的 Map，
 *    键必须带 realm：childId 是父侧 mint 的全局 id，但两套 realm 身份重叠时
 *    「childId 撞名」会让一个 realm 的取消/回执命中另一个 realm 的 run
 *    （越狱身份重叠）。分隔符约定平台签发 id 不含 `::`（JobRef 同训），
 *    否则 `(realm='a', childId='b::c')` 与 `(realm='a::b', childId='c')` 同键。
 *
 * 4. **`childDepthOf` 对非安全整数抛 invalid** —— 深度是委派上限
 *    （`assertSubagentMaxDepth`）的输入，乱深度 = 上限守卫失真；与 dsh 的
 *    `resolveChildDepth` 同一理由。负数/非整数/超安全整数是调用方输入错误，
 *    不是节点故障 → `invalid`。
 *
 * 范围外（契约为其留位）：fork/continuable 的 seed 传输（Task 3 明示不传）、
 * 取消经行 6 控制信号通道（本切片用承载侧直连 stop）。
 */
import { invalid } from './errors.ts'
import { validRealmKey } from './object-store.ts'

/** 运行表键的分隔符。realm/childId 均为平台签发 id，约定不含 `::`。 */
const RUN_KEY_SEP = '::'

/** 父会话的可传输描述（替代跨节点不可序列化的 parent: Agent）。 */
export interface ChildParentDescriptor {
  /** 父会话 id（child 的 meta.parentSession）。 */
  readonly sessionId: string
  /** 父会话 header 的 cwd（承载侧的 child 工作区）。 */
  readonly cwd?: string
  /** 父会话持久化的委派深度（承载侧 childDepth = +1；`delegationDepthOf` 的传输形态）。 */
  readonly delegationDepth: number
  /** 父 agent 路由 —— child 继承（照 `resolveChildAgentOptions` 的传输面）。 */
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  /** 照 `captureDelegatedPolicyOverrides` 的序列化面。 */
  readonly sandboxMode?: string
  readonly approvalPolicy?: 'never'
}

/** 承载侧建立远端子代理的确定性输入。 */
export interface StartChildRequest {
  /** 父侧 mint 的 child session id（幂等键：承载侧已存在 → notFound/invalid）。 */
  readonly childId: string
  readonly realm: string
  readonly label?: string
  /** 子代理用户消息内容（模型面 JSON，`ContentBlock[]` 结构等价）。 */
  readonly prompt: unknown[]
  /** 子代理描述（`SubagentDescriptorData` 结构等价；承载侧 append `subagent/descriptor`）。 */
  readonly descriptor: unknown
  readonly parent: ChildParentDescriptor
  /** 完成/中止结果回执端点（承载侧 POST `ChildResultBody`）。 */
  readonly callbackUrl: string
}

export interface StartChildOk {
  ok: true
  readonly childId: string
}
export interface StartChildFail {
  ok: false
  readonly code: string
  readonly message: string
}
export type StartChildResponse = StartChildOk | StartChildFail

/** 回执的 child 结局闭集：ok:false 用不上它（那是基础设施故障，code/message 承载）。 */
export const RESULT_STOP_REASONS = ['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const
export type SubagentResultStopReason = (typeof RESULT_STOP_REASONS)[number]

/** 闭集守卫：仅字面值匹配，词表外一律拒绝（闭集外不猜）。 */
export function isResultStopReason(s: string): s is SubagentResultStopReason {
  return (RESULT_STOP_REASONS as readonly string[]).includes(s)
}

/** 回执信封：`ok: false` = 基础设施故障（reject）；`ok: true` 内 stopReason 承载 child 结局 */
export interface ChildResultBody {
  readonly runId: string
  readonly ok: boolean
  readonly output?: unknown[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason?: SubagentResultStopReason
  readonly code?: string
  readonly message?: string
}

/** 必填字符串字段：须存在、是字符串、非空（可选字段见 stringOrUndefined）。 */
function requireString(obj: Record<string, unknown>, key: string, scope: string): string {
  const val = obj[key]
  if (typeof val !== 'string' || val === '') {
    throw invalid(`subagent-host: ${scope}.${key} 必须是非空字符串，收到 ${JSON.stringify(val)}`)
  }
  return val
}

/** 可选字符串字段：缺省合法，存在则必须是字符串。 */
function stringOrUndefined(obj: Record<string, unknown>, key: string, scope: string): void {
  const val = obj[key]
  if (val !== undefined && typeof val !== 'string') {
    throw invalid(`subagent-host: ${scope}.${key} 必须是字符串，收到 ${JSON.stringify(val)}`)
  }
}

/** 父描述校验（assertStartChildRequest 的内部件；childDepthOf 只锁深度语义）。 */
function assertParent(v: unknown): ChildParentDescriptor {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw invalid('subagent-host: StartChildRequest.parent 必须是 ChildParentDescriptor 对象')
  }
  const p = v as Record<string, unknown>
  requireString(p, 'sessionId', 'parent')
  const depth = p.delegationDepth
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0) {
    throw invalid(
      `subagent-host: parent.delegationDepth 必须是非负安全整数，收到 ${JSON.stringify(depth)}`,
    )
  }
  for (const key of ['cwd', 'provider', 'model', 'sandboxMode'] as const) {
    stringOrUndefined(p, key, 'parent')
  }
  const maxTokens = p.maxTokens
  if (maxTokens !== undefined && typeof maxTokens !== 'number') {
    throw invalid(`subagent-host: parent.maxTokens 必须是数字，收到 ${JSON.stringify(maxTokens)}`)
  }
  if (p.approvalPolicy !== undefined && p.approvalPolicy !== 'never') {
    throw invalid(
      `subagent-host: parent.approvalPolicy 闭集为 'never'（或缺省），收到 ${JSON.stringify(p.approvalPolicy)}`,
    )
  }
  return v as ChildParentDescriptor
}

/** 结构校验（失败抛 invalid('subagent-host: 原因')）。 */
export function assertStartChildRequest(v: unknown): asserts v is StartChildRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw invalid('subagent-host: StartChildRequest 必须是对象')
  }
  const req = v as Record<string, unknown>
  requireString(req, 'callbackUrl', 'StartChildRequest')
  const childId = requireString(req, 'childId', 'StartChildRequest')
  // childId 与 realm 同训：含 :: 的 childId 会在 assert 之后令 runKeyOf 抛 invalid
  // （（realm='a', childId='b::c'）与（realm='a::b', childId='c'）同键），
  // 必须在入口闸住（500 前先 400）。
  if (childId.includes(RUN_KEY_SEP)) {
    throw invalid(
      `subagent-host: StartChildRequest.childId 含运行键分隔符 ${RUN_KEY_SEP}（平台签发 id 不含 ${RUN_KEY_SEP}）：${JSON.stringify(childId)}`,
    )
  }
  // realm 与 runKeyOf 同训：坏段的 realm 会在 assert 之后令 runKeyOf 抛 invalid，
  // 必须在入口闸住（500 前先 400）。
  const realm = requireString(req, 'realm', 'StartChildRequest')
  if (!validRealmKey(realm) || realm.includes(RUN_KEY_SEP)) {
    throw invalid(
      `subagent-host: StartChildRequest.realm 段不合法（须非空单段、不含 /、\\ 与 ${RUN_KEY_SEP}）：${JSON.stringify(realm)}`,
    )
  }
  if (req.label !== undefined && typeof req.label !== 'string') {
    throw invalid(`subagent-host: StartChildRequest.label 必须是字符串，收到 ${JSON.stringify(req.label)}`)
  }
  if (!Array.isArray(req.prompt)) {
    throw invalid('subagent-host: StartChildRequest.prompt 必须是数组（ContentBlock[] 结构等价）')
  }
  if (!('descriptor' in req) || req.descriptor === undefined) {
    throw invalid('subagent-host: StartChildRequest 缺必填字段 descriptor')
  }
  assertParent(req.parent)
}

/** 结果回执校验（失败抛 invalid）。 */
export function assertChildResultBody(v: unknown): asserts v is ChildResultBody {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw invalid('subagent-host: ChildResultBody 必须是对象')
  }
  const b = v as Record<string, unknown>
  requireString(b, 'runId', 'ChildResultBody')
  if (typeof b.ok !== 'boolean') {
    throw invalid(`subagent-host: ChildResultBody.ok 必须是布尔值，收到 ${JSON.stringify(b.ok)}`)
  }
  if (b.output !== undefined && !Array.isArray(b.output)) {
    throw invalid('subagent-host: ChildResultBody.output 必须是数组')
  }
  for (const key of ['diagnostic', 'code', 'message'] as const) {
    stringOrUndefined(b, key, 'ChildResultBody')
  }
  if (b.stopReason !== undefined) {
    if (typeof b.stopReason !== 'string' || !isResultStopReason(b.stopReason)) {
      throw invalid(
        `subagent-host: ChildResultBody.stopReason 必须在终端词表内`
        + `（${RESULT_STOP_REASONS.join('/')}），收到 ${JSON.stringify(b.stopReason)}`,
      )
    }
  }
}

/**
 * 承载侧运行表键：`realm::childId`。
 *
 * realm 段隔离（与对象存储键同训：越狱身份重叠即拒绝）——键拼进同一张 Map，
 * 没有 realm 前缀的话，一个 realm 的取消/回执请求真会命中另一个 realm 的同名 run。
 */
export function runKeyOf(realm: string, childId: string): string {
  if (!validRealmKey(realm)) {
    throw invalid(
      `subagent-host: runKeyOf realm 段不合法（须非空单段、不含 / 与 \\）：${JSON.stringify(realm)}`,
    )
  }
  if (realm.includes(RUN_KEY_SEP)) {
    throw invalid(`subagent-host: runKeyOf realm 含保留分隔符 ${RUN_KEY_SEP}：${JSON.stringify(realm)}`)
  }
  if (childId === '') {
    throw invalid('subagent-host: runKeyOf childId 为空（父侧必须 mint）')
  }
  if (childId.includes(RUN_KEY_SEP)) {
    throw invalid(`subagent-host: runKeyOf childId 含保留分隔符 ${RUN_KEY_SEP}：${JSON.stringify(childId)}`)
  }
  return `${realm}${RUN_KEY_SEP}${childId}`
}

/**
 * child 深度 = 父深度 + 1。非安全整数抛 invalid（与 `resolveChildDepth` 同一理由——
 * 它是委派上限的输入，乱深度 = 上限守卫失真；且这是输入错误，不是节点故障）。
 */
export function childDepthOf(parent: ChildParentDescriptor): number {
  const depth = parent.delegationDepth
  if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0) {
    throw invalid(`subagent-host: 父深 parent.delegationDepth 必须是非负安全整数，收到 ${JSON.stringify(depth)}`)
  }
  return depth + 1
}
