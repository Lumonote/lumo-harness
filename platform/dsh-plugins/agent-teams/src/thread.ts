/**
 * 线程档位在插件侧的投影与判据（§24.2 两档成员：Worker 一次性 / Thread 可续跑）。
 *
 * ## 这一层不持有判据，只持有**本节点**的判据
 *
 * Thread 行的权威判据（状态闭集与合法边、工作目录归属、节点丢失的处置结论）在
 * `control-plane/collaborator/internal/domain/thread.go` —— 那里是 `threads` 表的唯一
 * 写入方。本模块只放**插件侧才拿得到输入**的那几条：本节点的身份、本节点的工作区根、
 * 以及「这次唤醒该不该由我来做」。把它摊进派发/写回两处会漂移，而漂移的后果是
 * 「一个线程被两个节点同时唤醒」——那正是 §24.2.1 禁止的形状。
 *
 * ## 为什么唤醒判据要这么严（fail-closed）
 *
 * 唤醒是 `awaiting` 线程**唯一**能被重新推进的入口。它一旦宽松，就有两条后门：
 *
 * 1. **允许别的节点唤醒** → 线程在一个节点上被唤醒、现场却在另一个节点上，等于绕开
 *    「承载节点亲和、绝不迁移」；
 * 2. **允许非 `awaiting` 的线程被唤醒** → 一个仍在 `running` 的线程被第二次推进会
 *    同时有两个执行者写同一个工作目录。
 *
 * 所以拿不到判定时一律拒绝：本节点身份未知、状态读不到、轮次形状不对 —— 全部拒绝。
 * 「不知道」在这一层永远不构成「可以」。
 */

import { resolve, sep } from 'node:path'

/** 线程状态闭集（§11 的 threads.state 注释 + `failed`，见 Go 侧 domain/thread.go 的登记）。 */
export type ThreadState = 'idle' | 'running' | 'awaiting' | 'stopped' | 'done' | 'failed'

/** 闭集的有序快照。用数组而不是 `Record`：它同时被 Union 类型与运行时查表使用。 */
export const THREAD_STATES: readonly ThreadState[] = [
  'idle', 'running', 'awaiting', 'stopped', 'done', 'failed',
]

/** 运行时查表用 Set（本仓库惯例：查表用 Map/Set，不用对象字面量——`in` 会命中原型链）。 */
const THREAD_STATE_SET: ReadonlySet<string> = new Set<string>(THREAD_STATES)

/** 终态：线程生命周期结束，要续跑必须**新建 Thread**（承载节点亲和不迁移）。 */
export const TERMINAL_THREAD_STATES: readonly ThreadState[] = ['stopped', 'done', 'failed']

/**
 * 线程行（`threads` 表的读投影）。**字段名与列名逐字一致**（§11），不做驼峰转换：
 * 这一层的唯一用途是与协作服务的行对齐，改名的收益只是好看，代价是每次对照 DDL 都要
 * 在脑子里翻译一遍 —— 而这类翻译错误恰好会在「唤醒挂到哪条线程」上静默生效。
 */
export interface ThreadRow {
  id: string
  realm: string
  project_id: string
  task_id: string
  coordinator_session_ref: string
  session_ref: string
  node_id: string
  workspace: string
  state: ThreadState
  created_at: string
  updated_at: string
}

/** 行的结构不合法。读路径遇到脏行必须响亮，不能把半条线程喂进唤醒路径。 */
export class ThreadRowError extends Error {
  constructor(message: string, readonly threadId: string) {
    super(message)
    this.name = 'ThreadRowError'
  }
}

/** 工作目录不合法（越界、绝对路径等）。 */
export class ThreadWorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThreadWorkspaceError'
  }
}

/** 线程 id 的合法形态：它要进 URL 路径段、工作目录段、以及唤醒通道 id。 */
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function requireString(row: Record<string, unknown>, field: string, threadId: string): string {
  const value = row[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ThreadRowError(
      `线程 ${threadId} 的 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`, threadId,
    )
  }
  return value
}

/**
 * 把协作服务返回的 JSON 校验成 `ThreadRow`。
 *
 * 三条从严的判法：
 *
 * - **未知状态直接抛**，不当「未知即跳过」。一个拼错的状态会让唤醒判据永远拒绝
 *   （`state-not-awaiting`），症状是一条**永远不会醒**的线程，而它在库里看起来完全正常。
 * - **`threadId` 给了就必须对上**：读到的行不是请求的那条时，唤醒/归因会挂到别人身上。
 *   这类错（分页错位、缓存串号）在返回体里长得完全一样，只能在这里拦。
 * - **时间戳必须可解析**：`created_at`/`updated_at` 会进看板的静默时长（§24.6 的
 *   「执行中（静默 N 分钟）」）。一个 `Invalid Date` 在那里会显示成「静默 NaN 分钟」，
 *   而看板是注意力路由的唯一入口——它不能给出读不懂的时间。
 */
export function parseThreadRow(value: unknown, threadId?: string): ThreadRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ThreadRowError(`线程记录不是对象：${JSON.stringify(value)?.slice(0, 120)}`, threadId ?? '(未知)')
  }
  const raw = value as Record<string, unknown>
  const id = requireString(raw, 'id', threadId ?? String(raw['id'] ?? '(未知)'))
  if (threadId !== undefined && id !== threadId) {
    throw new ThreadRowError(`读到的线程行是 ${id}，请求的是 ${threadId}`, threadId)
  }
  if (!THREAD_ID_RE.test(id)) {
    throw new ThreadRowError(`线程 id ${JSON.stringify(id)} 不合法：只允许 [A-Za-z0-9_-]`, id)
  }
  const state = requireString(raw, 'state', id)
  if (!THREAD_STATE_SET.has(state)) {
    throw new ThreadRowError(
      `线程 ${id} 的 state 不在闭集内：${state}（合法取值：${THREAD_STATES.join(' | ')}）`, id,
    )
  }
  for (const field of ['created_at', 'updated_at'] as const) {
    const stamp = requireString(raw, field, id)
    if (Number.isNaN(Date.parse(stamp))) {
      throw new ThreadRowError(`线程 ${id} 的 ${field} 不是可解析的时间：${stamp}`, id)
    }
  }
  return {
    id,
    realm: requireString(raw, 'realm', id),
    project_id: requireString(raw, 'project_id', id),
    task_id: requireString(raw, 'task_id', id),
    coordinator_session_ref: requireString(raw, 'coordinator_session_ref', id),
    session_ref: requireString(raw, 'session_ref', id),
    node_id: requireString(raw, 'node_id', id),
    workspace: requireString(raw, 'workspace', id),
    state: state as ThreadState,
    created_at: String(raw['created_at']),
    updated_at: String(raw['updated_at']),
  }
}

/**
 * 一个轮次的身份：**就是 §23.3 的一个 Run**（§24.2.2：一轮 = 一个 Run）。
 *
 * 线程行里没有代数列（列照抄 §11），轮次身份由 Run 侧持有。本结构只是把它搬进唤醒
 * 路径时的形状 —— 唤醒必须能说清「我唤醒的是哪一轮」，否则 §14 判据 10 的成本归因
 * （一次由事件唤醒的 Run 花了多少）就无从聚合。
 */
export interface ThreadRound {
  readonly task_id: string
  readonly attempt: number
}

/** 线程的两个推进动作（各自对应一次状态转移，见 Go 侧的 `threadTransitions`）。 */
export type ThreadAction =
  /** 挂起一轮：`running → awaiting`。 */
  | 'suspend'
  /** 唤醒一轮：`awaiting → running`。 */
  | 'wake'

/**
 * 每个动作**要求**的当前状态（查表用 Map，不用对象字面量：`in` 会命中原型链）。
 *
 * 这两条不是风格问题，是 §24.2.1 的两条硬约束：
 *
 * - `suspend` 要求 `running`：`idle` 没跑过就挂起，等于「等一个从未 arm 的唤醒」
 *   （Go 侧的状态表同样没有这条边）；
 * - `wake` 要求 `awaiting`：`running` 已有执行者在写同一个工作目录，再推进一次就是
 *   「同一 Thread 两个执行者」——与「同一 Thread 两个 node_id 并存」同一种事故。
 */
const ACTION_SOURCE_STATE: ReadonlyMap<ThreadAction, ThreadState> = new Map<ThreadAction, ThreadState>([
  ['suspend', 'running'],
  ['wake', 'awaiting'],
])

/** 拒绝的理由闭集。自由文本没法聚合，而同 `coordinator.ts` 的训诫：理由要能数出来。 */
export type WakeRefusal =
  /** 本节点身份未知（没配 nodeId 或为空）：拿不到判定 → 拒绝。 */
  | 'local-node-unknown'
  /** 线程不承载在本节点上：推进它会绕过「绝不迁移」。 */
  | 'node-mismatch'
  /** 当前状态不是该动作要求的源状态。 */
  | 'state-not-expected'
  /** 轮次引用的不是本行的任务。 */
  | 'round-task-mismatch'
  /** 轮次形状不合法（`attempt` 不是 >= 1 的整数）。 */
  | 'round-invalid'

/** 推进判定。 */
export type WakeDecision =
  | { allow: true }
  | { allow: false; reason: WakeRefusal; detail: string }

/** 拒绝推进（调用方据此区分「被拒绝」与「传输失败」）。 */
export class ThreadWakeRefusedError extends Error {
  constructor(readonly reason: WakeRefusal, readonly detail: string) {
    super(`拒绝推进线程：${reason}（${detail}）`)
    this.name = 'ThreadWakeRefusedError'
  }
}

/** 状态不符时的可读理由（挂起与唤醒各自的拒绝理由不同，因为它们要触发不同的处置）。 */
function stateMismatchDetail(action: ThreadAction, state: ThreadState): string {
  if (TERMINAL_THREAD_STATES.includes(state)) {
    return `线程已终态 ${state}：在原地复活一个已经结束的线程就是「假装可迁移」（要续跑请新建 Thread）`
  }
  if (action === 'suspend') {
    return state === 'awaiting'
      ? '线程已经在等，重复挂起会再造一个等待项（两个等待项里只有一个会被兑现）'
      : `挂起要求线程正在 running，当前是 ${state}：没跑过就等 = 等一个从未被 arm 的唤醒（§8.1 的「永不唤醒」形状）`
  }
  return state === 'running'
    ? '线程正在 running：已有执行者在写同一个工作目录，再唤醒一次就是两个执行者推同一份现场'
    : `唤醒要求线程处于 awaiting，当前是 ${state}`
}

/**
 * 这一次推进该不该由本节点做（§24.2.1 的亲和判据 + §24.2.2 的一轮 = 一个 Run）。
 *
 * 规则**先命中先返回**，顺序即优先级：
 *
 * 1. 本节点身份未知 → `local-node-unknown`
 * 2. `thread.node_id !== nodeId` → `node-mismatch`
 * 3. `state !== ACTION_SOURCE_STATE[action]` → `state-not-expected`
 * 4. `round.task_id !== thread.task_id` → `round-task-mismatch`
 * 5. `round.attempt` 非法 → `round-invalid`
 *
 * ### 为什么「本节点身份未知」排第一
 *
 * 它与其余四条不是一类：那四条是**判断结果**，这条是**判断不了**。排第一是为了让
 * 归因正确 —— 节点身份没配好时，四条具体判据都会给出各自的理由，现场会去查线程，
 * 而真正要修的是装配（`nodeId` 没配）。**顺序即归因**（同 `acceptance.ts` 的训诫）。
 *
 * ### 为什么状态判据要带动作
 *
 * 挂起与唤醒的源状态不同，而两者的**错误形状也不同**：挂起错了会造出一个没人兑现的
 * 等待项，唤醒错了会造出第二个执行者。用同一个「必须是 awaiting」去判两者，只会让
 * 挂起路径**永远被拒**——一个静默失效的挂起入口比一个报错的更贵。
 */
export function threadActionDecision(input: {
  thread: ThreadRow
  nodeId: string
  round: ThreadRound
  action: ThreadAction
}): WakeDecision {
  const { thread, round, action } = input
  const expected = ACTION_SOURCE_STATE.get(action)
  if (expected === undefined) {
    // 闭集类型下不可达；真出现了说明调用方绕过了类型（未类型化的脚本 / 脏配置）。
    // 不猜成某个动作：猜错会让一次「挂起」被当成「唤醒」放行。
    throw new Error(`未知的线程动作：${JSON.stringify(action)}`)
  }
  const nodeId = input.nodeId.trim()
  if (nodeId === '') {
    return {
      allow: false,
      reason: 'local-node-unknown',
      detail: '本进程没有节点身份（nodeId 未配置或为空）：没有身份就无法主张「这条线程归我推进」',
    }
  }
  if (thread.node_id !== nodeId) {
    return {
      allow: false,
      reason: 'node-mismatch',
      detail: `线程承载于 ${thread.node_id}，本节点是 ${nodeId}：跨节点推进等于绕过「承载节点亲和、绝不迁移」`,
    }
  }
  if (thread.state !== expected) {
    return { allow: false, reason: 'state-not-expected', detail: stateMismatchDetail(action, thread.state) }
  }
  if (round.task_id !== thread.task_id) {
    return {
      allow: false,
      reason: 'round-task-mismatch',
      detail: `轮次引用任务 ${round.task_id}，本行是 ${thread.task_id}：唤醒的归因会记到别的任务头上`,
    }
  }
  if (!Number.isSafeInteger(round.attempt) || round.attempt < 1) {
    return {
      allow: false,
      reason: 'round-invalid',
      detail: `轮次代数必须是 >= 1 的整数，收到 ${JSON.stringify(round.attempt)}（0 表示从未派发，不是一轮）`,
    }
  }
  return { allow: true }
}

/** 默认唤醒有效期：一次 CI / 流水线的合理上限，够长以覆盖真实等待，够短以在班次内暴露。 */
export const DEFAULT_WAKE_TTL_MS = 30 * 60_000
/** 唤醒有效期上限，与 `@lumo/mailbox` 的默认上限同量级：跨夜的人工环节仍在射程内。 */
export const MAX_WAKE_TTL_MS = 24 * 60 * 60_000

/**
 * 把调用方给的 TTL 收敛到 `[1, MAX_WAKE_TTL_MS]`；缺省/非法取 `DEFAULT_WAKE_TTL_MS`。
 *
 * **语义是收敛而不是报错**（同 `ResolveDecisionIndexLimit` 的取舍），但要看清这里的
 * 「非法」指向哪边：`undefined`、0、负数、`NaN` 一律取默认值 —— 也就是「拿不到一个像样的
 * 判定时用最保守的有限值」，绝不落到「无上限」。§8.1 的原话是「没有『永远等下去』这个
 * 选项」，所以这一个函数里不存在「无限」这个返回。
 */
export function resolveWakeTtlMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_WAKE_TTL_MS
  }
  return Math.min(Math.floor(requested), MAX_WAKE_TTL_MS)
}

/**
 * 一条线程某一轮的唤醒通道 id。
 *
 * 形如 `thread/<threadId>/wake/<attempt>`。**带代数**是刻意的：改派会让代数递增，于是
 * 新一轮拿到**新通道**，旧一轮的迟到兑现不可能满足新一轮的等待 —— 与 `courier.ts` 的
 * `channelId` 同训（那里带的是 `attempt`，理由完全相同）。
 *
 * id 里**不放 `task_id`**：线程行的 `task_id` 一经写入不变，而 `wakeDecision` 已经要求
 * 轮次引用的就是本行的任务 —— 把它再写进通道 id 只会多一处可能对不上的地方。
 *
 * 线程 id 与代数在这里都要过闸（fail-closed）：id 含 `/` 时两个不同的 (线程, 轮次) 会
 * 派生出同一个通道 id，一次兑现就会唤醒**错的线程**；代数非法则通道 id 落不到任何一轮上。
 */
export function threadWakeChannel(threadId: string, round: ThreadRound): string {
  if (!THREAD_ID_RE.test(threadId)) {
    throw new ThreadRowError(
      `线程 id ${JSON.stringify(threadId)} 不能用作唤醒通道（只允许 [A-Za-z0-9_-]：含分隔符会让两条线程派生出同一个通道）`,
      threadId,
    )
  }
  if (!Number.isSafeInteger(round.attempt) || round.attempt < 1) {
    throw new ThreadRowError(
      `轮次代数必须是 >= 1 的整数，收到 ${JSON.stringify(round.attempt)}`, threadId,
    )
  }
  return `thread/${threadId}/wake/${round.attempt}`
}

/**
 * 唤醒载荷：**只带归因键**，不带现场事实。
 *
 * 这是 §24.3.2「工作目录不进复制日志」在代码里的落点：载荷会进 session 事件（模型可见
 * 层），而承载节点与工作目录是**节点局部事实** —— 它们进了模型可见层，就等于把一份
 * 只在某个节点上成立的路径写进了所有节点都读的日志里，与「把句柄写进复制日志」同训。
 * 需要现场时由承载节点自己按 `workspace` 列解析，不靠消息传。
 */
export function wakePayload(threadId: string, round: ThreadRound): {
  thread_id: string
  round: { task_id: string; attempt: number }
} {
  return { thread_id: threadId, round: { task_id: round.task_id, attempt: round.attempt } }
}

/**
 * 把线程行的工作目录解析成**本节点上的绝对路径**（§24.3.2）。
 *
 * ## 只解析与校验，不物化
 *
 * 这里**不创建目录、不写任何文件**。设计说明 §24.3.2 第 1 条要求目录「由 Provisioner 按
 * 制品 digest 物化」，而 Provisioner 的接线不在本切片的范围内 —— 所以本切片只做
 * 「路径的归属与校验」，物化如实地没做（见报告）。不物化也不假装：没有任何 `mkdir`。
 *
 * ## 归属判据与越界判据的分工
 *
 * 「这个 workspace 是不是本行 id 该有的那个」**只在 Go 侧判一次**
 * （`domain.ValidateThreadWorkspace` 的等值判据）：在两端各判一遍，迟早一边放宽。
 * 本函数只判**本节点才有的那一半** —— 能不能安全地把它解析到本节点的工作区根下。
 * 三条拒绝各自的理由：
 *
 * 1. **根必须是绝对路径**：相对的根会随进程 cwd 变化，同一个 Thread 两次解析可能落在
 *    两个目录里，而它自以为只有一个现场。
 * 2. **不能是绝对路径的 workspace**：`path.resolve` 遇到绝对路径会**整个丢掉根**，
 *    于是校验形同虚设、线程写到了根之外。
 * 3. **解析结果必须仍在根下**：`..` 与符号链接之外的一切都能被前两条挡住，这一条是
 *    最后一道（`resolve` 会先把 `..` 折掉再比较）。
 */
export function resolveThreadWorkspacePath(root: string, workspace: string): string {

  const trimmedRoot = root.trim()
  if (trimmedRoot === '') {
    throw new ThreadWorkspaceError('节点工作区根为空：没有根就无法判定线程的目录落在哪里')
  }
  if (!trimmedRoot.startsWith('/')) {
    throw new ThreadWorkspaceError(
      `节点工作区根 ${JSON.stringify(root)} 必须是绝对路径：相对的根会随进程 cwd 变化，同一个线程会落到两个目录里`,
    )
  }
  if (workspace.trim() === '') {
    throw new ThreadWorkspaceError('线程行的 workspace 为空')
  }
  if (workspace.startsWith('/')) {
    throw new ThreadWorkspaceError(
      `workspace ${JSON.stringify(workspace)} 不能是绝对路径：它会让解析整个丢掉节点工作区根（路径归属随之失效）`,
    )
  }
  if (workspace.includes('\0') || workspace.includes('\\')) {
    throw new ThreadWorkspaceError(`workspace ${JSON.stringify(workspace)} 含非法字符（NUL / 反斜杠）`)
  }
  const resolvedRoot = resolve(trimmedRoot)
  const resolved = resolve(resolvedRoot, workspace)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    throw new ThreadWorkspaceError(
      `workspace ${JSON.stringify(workspace)} 解析后越出了节点工作区根：${resolved} 不在 ${resolvedRoot} 下`,
    )
  }
  return resolved
}

// ───────────────────────── 节点失联 → 重派（§24.2.3(4)） ─────────────────────────

/**
 * 协作服务产生的一条**节点失联通知**（`thread_node_loss_notices` 行的读投影）。
 *
 * 它是 §24.2.3(4) 信号链中段的那一步：`collaborator` 把线程标成 `failed` 之后落一条通知，
 * 由**持有 mailbox 的那一侧**（本插件，见 `thread-wake.ts` 的 `announce`）投进协调者的
 * 唤醒通道。为什么不让协作服务直接写 mailbox：那张表由 `@lumo/mailbox` 插件持有，从 Go 侧
 * 写它要复制等待项 id 的派生规则与「首次兑现为准」的写语义，任一处漂移都会让通知**静默丢失**。
 */
export interface NodeLossNotice {
  /** 单调游标（`BIGSERIAL`）。时间戳会撞（同一毫秒里同一节点上的多条线程一起 failed），游标不会。 */
  readonly seq: number
  readonly realm: string
  readonly thread_id: string
  readonly node_id: string
  readonly session_ref: string
  readonly coordinator_session_ref: string
  readonly reason: string
  readonly created_at: string
}

/**
 * 把协作服务返回的通知校验成 `NodeLossNotice`（fail-closed）。
 *
 * 三条从严的判法，都是「脏数据必须响亮」的同一条理由：
 *
 * - **未知字段缺失即抛**：一条没有 `coordinator_session_ref` 的通知是**投不出去**的，
 *   而它在日志里看起来完全正常；
 * - **`thread_id` 必须能当唤醒通道段**（`[A-Za-z0-9_-]`）：通知会被拿去派生通道 id，
 *   含分隔符的 id 会让两个不同的线程派生出同一个通道——一次投递唤醒**错的线程**；
 * - **`seq` 必须是 >= 1 的整数**：它是消费方的游标，一个 `NaN` 游标会让轮询永远从头开始
 *   （每次都重投同一条通知）或永远停在原地（新的通知再也读不到）。
 */
export function parseNodeLossNotice(value: unknown, expectThreadId?: string): NodeLossNotice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ThreadRowError(`节点失联通知不是对象：${JSON.stringify(value)?.slice(0, 120)}`, expectThreadId ?? '(未知)')
  }
  const raw = value as Record<string, unknown>
  const threadId = requireString(raw, 'thread_id', expectThreadId ?? String(raw['thread_id'] ?? '(未知)'))
  if (expectThreadId !== undefined && threadId !== expectThreadId) {
    throw new ThreadRowError(`读到的通知属于线程 ${threadId}，请求的是 ${expectThreadId}`, expectThreadId)
  }
  if (!THREAD_ID_RE.test(threadId)) {
    throw new ThreadRowError(
      `通知里的线程 id ${JSON.stringify(threadId)} 不能用作唤醒通道（只允许 [A-Za-z0-9_-]）`, threadId,
    )
  }
  const seq = raw['seq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw new ThreadRowError(
      `通知的 seq 必须是 >= 1 的整数（它是消费游标），收到 ${JSON.stringify(seq)}`, threadId,
    )
  }
  const createdAt = requireString(raw, 'created_at', threadId)
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new ThreadRowError(`通知的 created_at 不是可解析的时间：${createdAt}`, threadId)
  }
  return {
    seq,
    realm: requireString(raw, 'realm', threadId),
    thread_id: threadId,
    node_id: requireString(raw, 'node_id', threadId),
    session_ref: requireString(raw, 'session_ref', threadId),
    coordinator_session_ref: requireString(raw, 'coordinator_session_ref', threadId),
    reason: requireString(raw, 'reason', threadId),
    created_at: createdAt,
  }
}

/**
 * 节点失联通知落到唤醒通道上的载荷。
 *
 * 与 `wakePayload`（正常事件唤醒）分开，是因为两者要触发的**判断不同**：`wakePayload`
 * 只带归因键（哪条线程、哪一轮），而这条要带「现场没了」这个事实的具体来源——
 * 协调者据此区分 §7.1 R2 的两种情形（不可恢复 ≠ 可重试）：节点丢了要**新建 Thread 重派**，
 * 而普通的等待超时只需重跑一轮。
 *
 * **不装工作目录**（§24.3.2）：`workspace` 是节点局部事实，进了这条载荷就等于把只在某个
 * 节点上成立的路径写进了会被所有节点读到的消息里。`node_id` 可以带——它是**全集群共用**的
 * 标识（就是注册表里那一列），不是任何一台机器的局部路径。
 */
export function nodeLossPayload(threadId: string, round: ThreadRound, notice: NodeLossNotice): {
  kind: 'node-lost'
  thread_id: string
  node_id: string
  reassign_run: boolean
  reason: string
  round: { task_id: string; attempt: number }
} {
  if (notice.thread_id !== threadId) {
    throw new ThreadRowError(
      `通知属于线程 ${notice.thread_id}，不能投到 ${threadId} 的通道上（一次投递会唤醒错的线程）`, threadId,
    )
  }
  return {
    kind: 'node-lost',
    thread_id: threadId,
    node_id: notice.node_id,
    // 恒为 true：节点丢了 = 现场没了 = 只能重派新 Run（§24.2.1）。这个字段存在是为了让
    // 协调者的判断有**可读的**输入，而不是靠它自己从 reason 文本里猜。
    reassign_run: true,
    reason: notice.reason,
    round: { task_id: round.task_id, attempt: round.attempt },
  }
}

/**
 * 重派产生的新线程 id：`<旧 id>-r<新一轮代数>`（纯函数）。
 *
 * 为什么**派生**而不是让调用方随便起一个：
 *
 * 1. 重派是**重试**，同一个失败线程的第二次重派必须算出同一个 id —— 这样并发/重复的
 *    重派请求会撞上注册表的主键冲突（看得见的拒绝），而不是造出两条并行的线程各跑一遍
 *    同一份工作（看不见的重复执行）；
 * 2. id 要进工作目录段与 URL 路径段，所以必须过 `THREAD_ID_RE`；长度也要卡住 128 ——
 *    超长 id 在注册表侧被拒时，现场看到的是一个「格式错误」，而根因是重派时没截断。
 */
export function replacementThreadId(threadId: string, attempt: number): string {
  if (!THREAD_ID_RE.test(threadId)) {
    throw new ThreadRowError(`旧线程 id ${JSON.stringify(threadId)} 不合法，无法派生重派 id`, threadId)
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ThreadRowError(`轮次代数必须是 >= 1 的整数，收到 ${JSON.stringify(attempt)}`, threadId)
  }
  const derived = `${threadId}-r${attempt}`
  if (!THREAD_ID_RE.test(derived)) {
    throw new ThreadRowError(
      `派生出的重派 id ${JSON.stringify(derived)} 不合法（长度上限 128，只允许 [A-Za-z0-9_-]）`, threadId,
    )
  }
  return derived
}

/**
 * 重派的那一轮 = **上一轮 + 1**（§24.2.2：一轮 = 一个 Run）。
 *
 * 为什么不复用旧代数：`(task_id, attempt)` 是 §23.3 的 Run 唯一键。复用旧的代数意味着
 * 「新 Run 覆盖旧 Run 的身份」，而旧 Run 的记录还在（它只是跑没了）——那会让成本归因
 * （§14 判据 10）与审计都指向一次**其实已经失败**的执行。
 */
export function nextRoundAfterLoss(previous: ThreadRound): ThreadRound {
  if (!Number.isSafeInteger(previous.attempt) || previous.attempt < 1) {
    throw new ThreadRowError(
      `上一轮的代数必须是 >= 1 的整数，收到 ${JSON.stringify(previous.attempt)}`, previous.task_id,
    )
  }
  if (previous.attempt >= Number.MAX_SAFE_INTEGER) {
    throw new ThreadRowError(`轮次代数已达上限，无法再派生新一轮（这已经不是重试能解决的问题）`, previous.task_id)
  }
  return { task_id: previous.task_id, attempt: previous.attempt + 1 }
}

/** 拒绝重派的理由闭集（自由文本没法聚合，同 `WakeRefusal` 的训诫）。 */
export type ReplacementRefusal =
  /** 线程不是 `failed`：还在跑（或只是被停下、已经完成）的线程不许重派。 */
  | 'thread-not-failed'
  /** 新承载节点就是刚丢的那个。 */
  | 'node-reused'
  /** 新会话复用了旧会话 ref:旧会话的现场在已失联的节点上。 */
  | 'session-reused'
  /** 新线程 id 与旧 id 相同（重派必须是一条**新线程**）。 */
  | 'thread-id-reused'
  /** 轮次形状不合法（代数不是 >= 1 的整数）。 */
  | 'round-invalid'

/** 一次重派的计划。 */
export interface ThreadReplacementPlan {
  /** 新线程行（**没有** created_at / updated_at：时间由库端的单一时钟源给出）。 */
  readonly thread: Omit<ThreadRow, 'created_at' | 'updated_at'>
  /** 新一轮的 Run 身份（代数 = 上一轮 + 1）。 */
  readonly round: ThreadRound
}

/** 重派判定。 */
export type ThreadReplacementDecision =
  | { allow: true; plan: ThreadReplacementPlan }
  | { allow: false; reason: ReplacementRefusal; detail: string }

/**
 * 节点失联后的重派计划（纯函数，**唯一判据来源**）。
 *
 * 规则先命中先返回，顺序即优先级。每一条都在挡一种具体的事故：
 *
 * 1. **`thread.state !== 'failed'` → 拒。** `running` 的线程重派会造出两个执行者写同一份
 *    工作树；`done` / `stopped` 的线程重派是「复活一个已经结束的线程」——`stopped` 的现场
 *    还在承载节点上（等人/等指令），它根本不需要重派，重派等于把一份还有人的现场再复制一份。
 * 2. **新节点 == 丢失的节点 → 拒。** 把重派的 Run 放回一台已经没了（或正在失联）的机器上，
 *    是**静默失败**：注册表会看到一行状态完全正常的线程，而它永远不会被推进。
 * 3. **新会话 == 旧会话 → 拒。** 旧会话的现场（工作目录、进程）在死节点上；复用 ref 会让
 *    新 Run 的日志被追加到一份已经断掉的会话上，`threads_session` 唯一索引也会同时挡下它
 *    （「一个会话只能挂一条线程行」）。两次拒绝的一致口径由这里维持。
 * 4. **新 id == 旧 id → 拒。** 重派的唯一合法形态是**新建 Thread**（§24.2.1：承载节点亲和，
 *    绝不迁移），在原 id 上重开就是「换台机器接着跑」。
 * 5. **代数非法 → 拒。** 见 `nextRoundAfterLoss`。
 *
 * 返回的是**计划**（`plan`）而不是「已执行」：判据与动作分开，动作由调用方（运行时）做，
 * 于是这条判据可以逐条测，而不必拉起注册表与执行面。
 */
export function planThreadReplacement(input: {
  thread: ThreadRow
  /** 上一轮（用于派生新 Run 的代数）。 */
  previousRound: ThreadRound
  /** 协调者选定的**新**承载节点。 */
  newNodeId: string
  /** 新会话 ref（必须是新的，见判据 3）。 */
  newSessionRef: string
  /** 新线程 id；缺省由 `<旧 id>-r<新代数>` 派生。 */
  newThreadId?: string
}): ThreadReplacementDecision {
  const { thread, previousRound } = input
  if (thread.state !== 'failed') {
    return {
      allow: false, reason: 'thread-not-failed',
      detail: `线程 ${thread.id} 处于 ${thread.state}：只有 failed（现场已被判定消失）才需要重派。`
        + `running 会造出两个执行者；stopped/done 的现场还在承载节点上，复活它就是「假装可迁移」`,
    }
  }
  const newNodeId = input.newNodeId.trim()
  if (newNodeId === '') {
    return { allow: false, reason: 'node-reused', detail: '重派必须给出**新**承载节点：没有节点就没有可执行的现场' }
  }
  if (newNodeId === thread.node_id) {
    return {
      allow: false, reason: 'node-reused',
      detail: `新承载节点仍是 ${thread.node_id}（刚判定失联的那个）：把 Run 放回同一台机器是静默失败`
        + '——注册表会看到一行状态正常的线程，而它永远不会被推进',
    }
  }
  const newSessionRef = input.newSessionRef.trim()
  if (newSessionRef === '') {
    return { allow: false, reason: 'session-reused', detail: '重派必须给出新会话 ref：线程定义含一个稳定会话（§24.2.1）' }
  }
  if (newSessionRef === thread.session_ref) {
    return {
      allow: false, reason: 'session-reused',
      detail: `新会话复用了 ${thread.session_ref}：旧会话的现场在已失联的节点 ${thread.node_id} 上`
        + '（threads_session 唯一索引也会挡下它——一个会话只能挂一条线程行）',
    }
  }
  let round: ThreadRound
  try {
    round = nextRoundAfterLoss(previousRound)
  } catch (error: unknown) {
    return { allow: false, reason: 'round-invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  let newThreadId: string
  try {
    newThreadId = input.newThreadId ?? replacementThreadId(thread.id, round.attempt)
  } catch (error: unknown) {
    return { allow: false, reason: 'round-invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  if (newThreadId === thread.id) {
    return {
      allow: false, reason: 'thread-id-reused',
      detail: `重派后的 id 仍是 ${thread.id}：重派的唯一合法形态是**新建 Thread**`
        + '（承载节点亲和不迁移，在原 id 上重开就是「换台机器接着跑」）',
    }
  }
  try {
    validateReplacementShape(newThreadId, newSessionRef, newNodeId)
  } catch (error: unknown) {
    return { allow: false, reason: 'round-invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  return {
    allow: true,
    plan: {
      thread: {
        id: newThreadId,
        realm: thread.realm,
        project_id: thread.project_id,
        // 任务不变：一轮 = 一个 Run，而 Run 挂在任务上（§24.2.2）。变的是代数。
        task_id: thread.task_id,
        // 协调者不变：重派正是协调者的路由决策（§24.2.3(4)：协调者做路由与验收）。
        coordinator_session_ref: thread.coordinator_session_ref,
        session_ref: newSessionRef,
        node_id: newNodeId,
        // 新线程 = 新工作目录（§24.3.2）。旧目录随旧节点消失，绝不沿用（沿用等于共享一份
        // 已经没人维护的现场）。
        workspace: `thread/${newThreadId}/`,
        state: 'idle',
      },
      round,
    },
  }
}

/** 重派行的形状自证（id/session/node 都要能进 URL 与目录段）。 */
function validateReplacementShape(threadId: string, sessionRef: string, nodeId: string): void {
  if (!THREAD_ID_RE.test(threadId)) {
    throw new ThreadRowError(`新线程 id ${JSON.stringify(threadId)} 不合法：只允许 [A-Za-z0-9_-] 且长度 1..128`, threadId)
  }
  for (const [field, value] of [['session_ref', sessionRef], ['node_id', nodeId]] as const) {
    if (value.includes('/') || /[\s]/.test(value) || value.length > 200) {
      throw new ThreadRowError(`${field} ${JSON.stringify(value)} 含空白或 /（它会与工作目录路径同时出现在排查输出里）`, threadId)
    }
  }
}
