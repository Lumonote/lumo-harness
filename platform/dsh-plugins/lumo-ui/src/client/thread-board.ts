/**
 * 线程看板（§24.6 注意力路由）：把线程分进五格，**纯投影**。无 IO、无 React、无状态。
 *
 * ## 为什么这一刀值得单独存在
 *
 * 「有产出物待裁决」与「只等一个决定 / 一次批准」合成一个「待处理」列表，等于把两种完全
 * 不同的打断混成一种：审产出物要**进入心流**（找回上下文、读完、判断），回答一个问题只是
 * **一次点击**。混在一起时人会按最贵的那种预估成本，于是连便宜的等待也被拖成贵的——
 * 那笔钱就是注意力税。所以这两格必须分开呈现，不是一格加个标签：
 * **任何「合并成一个待处理列表」的改动都会把这一刀的意义整个抹掉。**
 *
 * ## 为什么是投影，不是状态机（§15 第 14 条「终端只渲染视图，不实现状态机」）
 *
 * 格子**全部**由后端已经给出的态派生：业务态 §23.3、运行态、控制态 §8.4。本模块不新增存储、
 * 不新增状态、不做状态转移，也不缓存「这条我看过了」。看板一旦开始自己记东西，就出现了
 * 第二份与后端分叉的真相——而分叉的症状是「看板上少了一条线程」，那看起来像「本来就没有」。
 *
 * 同一条规矩的推论：**读不到的格说读不到**，既不显示成 0，也不显示成空。空是一个结论
 * （「没有人在等我」），缺读面只是缺读面；两者在屏幕上长得一样是这一层最贵的一种错。
 *
 * ## 两条可见性要求（§24.6 自文章 §11.4 继承；都只降低感知等待，不缩短实际耗时）
 *
 * 1. **「在跑但没有新消息」要能被看懂。** 有活跃 Run 但超过 `stalledAfterMs` 没有事件的行
 *    **仍留在「执行中」格**（它确实在跑），但标出静默时长——否则它看起来就是卡死，
 *    而「看起来卡死」会招来不必要的介入：重派、重启、或者干脆人工接手。
 * 2. **等待有上限。** §8.1 的「每个等待强制带 TTL，没有『永远等下去』这个选项」。超过
 *    `waitTtlMs` 的等待进「已停」格，注意力类型也从「心流 / 点击」变成「分类」——
 *    一个等待不允许永远挂在等待格里冒充「还在进行」。
 */

/** 五格。顺序即呈现顺序：先要人介入的，后不用管的。 */
export type ThreadCellId = 'deep-review' | 'light-answer' | 'executing' | 'stopped' | 'done'

export interface ThreadCellSpec {
  id: ThreadCellId
  label: string
  /** 注意力类型：这一栏回答「要花什么」——心流 / 一次点击 / 不用管 / 分类。 */
  attention: string
  /** 判据原文。面板把它当说明显示，测试拿它对齐设计。 */
  rule: string
}

export const THREAD_CELLS: readonly ThreadCellSpec[] = [
  { id: 'deep-review', label: '待深度审', attention: '心流', rule: '业务态 IN_REVIEW：有产出物待裁决' },
  { id: 'light-answer', label: '待轻量答', attention: '点击', rule: '控制态 awaiting-approval：只等一个决定 / 一次批准' },
  { id: 'executing', label: '执行中', attention: '无', rule: '业务态 ASSIGNED / EXECUTING / VERIFYING：无需介入' },
  { id: 'stopped', label: '已停', attention: '分类', rule: '运行态 FAILED / CANCELLED、业务态 REJECTED，或等待超过上限' },
  { id: 'done', label: '已完成', attention: '无', rule: '业务态 DONE / ARCHIVED：终态' },
]

/**
 * 静默阈值：有活跃 Run 但这么久没有事件，就标明静默时长。
 *
 * 10 分钟是个**呈现阈值**，不是判据：它不改变任何行的所在格，只决定那句「静默 N 分钟」
 * 出不出现。取值偏大是刻意的——误报静默会招来多余的介入，比晚报几分钟贵得多。
 */
export const DEFAULT_STALLED_AFTER_MS = 10 * 60_000

/**
 * 等待上限。与 agent-teams 的 `DEFAULT_WAKE_TTL_MS`（唤醒默认 TTL）同值 30 分钟。
 *
 * **这是近似，不是那条等待真实的 TTL**：真实 TTL 由 arm 时决定（可在 1 分钟到 24 小时之间），
 * 而 §24.6 的舰队读面里没有这个数。取默认值是因为它至少与平台**默认的**上限一致——
 * 比「等多久都不算超时」诚实，也比编一个数诚实。部署若把唤醒 TTL 配成别的值，
 * 这里应当一起给（面板会写明用的是哪个上限）。
 */
export const DEFAULT_WAIT_TTL_MS = 30 * 60_000

/**
 * 看板读的那一面：`/lumo/api/delegations` 的行（与协作图是同一批行，只是另一个切片）。
 *
 * 字段名照抄读面，**不做驼峰转换**：这一层的唯一用途是与服务端的行对齐，改名的收益只是
 * 好看，代价是每次对照响应体都要在脑子里翻译一遍——而这类翻译错误会静默生效。
 */
export interface ThreadFacts {
  id: string
  title?: string
  /** §23.3 业务态。`null` / 缺省 = 旧行（legacy），不伪造。 */
  business_state?: string | null
  /** 控制面任务态（ASSIGNED / QUEUED / RUNNING / …）——「有没有活跃 Run」在这一列上。 */
  state?: string
  assignee?: string
  node_id?: string
  last_error?: string
  /** 服务端记的最后一次变更时间。静默与等待时长都以它为基准（见本文件末尾的缺口说明）。 */
  updated_at?: string
  /** §8.4 控制态（`awaiting-approval` 等）。`undefined` = 这一行没带，不是「没有控制态」。 */
  control_state?: string | null
}

export interface ThreadBoardOptions {
  /** 判定静默 / 超时的基准时刻（毫秒）。由调用方给，纯函数里不读时钟。 */
  now: number
  stalledAfterMs?: number
  waitTtlMs?: number
  /**
   * 控制态读面是否接线。
   *
   * - `false`（缺省）：「待轻量答」这一格**读不到**。今天就是这一档——
   *   `/lumo/api/sessions/{ref}/control` 只按会话逐个读，没有列表读面，
   *   所以整片舰队里谁是「等一次点击」无从知道。这一格会说明缺什么，而不是空着。
   * - `true`：每一行都带 `control_state`。个别行没带时，该行会被单独标出来
   *   （一行读不到，这一格就不能声称「没有人在等」）。
   */
  controlState?: boolean
}

export interface ThreadBoardEntry {
  id: string
  title: string
  /** 谁在承担；缺了写「未分派」——空着读起来像数据缺失，而它是个明确的状态。 */
  owner: string
  /** 这行现在是什么态（业务态，缺则运行态）。原文交给面板本地化，这里不改写。 */
  state: string
  /** 为什么在这一格。已停格靠它做「分类」：失败、被驳回、还是等待超时。 */
  reason: string
  /** 进入当前状态以来的时长（ms）。时间戳缺失或不可解析时是 `undefined`——不猜。 */
  ageMs?: number
  /** 有活跃 Run 且已超静默阈值：面板显示成「执行中（静默 N 分钟）」。 */
  silent: boolean
  /** 从等待格挪过来的：等待超过上限。 */
  waitExpired: boolean
}

export interface ThreadBoardColumn {
  id: ThreadCellId
  label: string
  attention: string
  rule: string
  entries: ThreadBoardEntry[]
  /** 这一格读不到时的理由。**有它时 entries 必为空，且面板不得写「0 条」。** */
  unreadable?: string
}

/** 落在五格之外的行。**不丢**：设计只定义了五格，格外的行带着理由出现。 */
export interface OutsideThread {
  id: string
  title: string
  reason: string
}

export interface ThreadBoard {
  columns: ThreadBoardColumn[]
  outside: OutsideThread[]
  /** 落了格的行数（不含格外的）。 */
  placed: number
}

function normalise(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase()
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * 距 `now` 多久了。解析不了就返回 `undefined`。
 *
 * **不猜**：一个 `Invalid Date` 若被折成 0，看板会说这条线程「刚刚有动静」——
 * 而它可能已经静默了一小时。静默时长在这里是唯一的时间事实，错的方向必须是「不知道」。
 * 未来的时间戳（时钟漂移）按 0 处理：时长不会是负数，而负数在读面上无法解释。
 */
function elapsed(now: number, stamp: string | undefined): number | undefined {
  if (stamp === undefined) return undefined
  const at = Date.parse(stamp)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, now - at)
}

/** 一行的「格内状态」文案：业务态优先，旧行没有业务态时退回运行态。 */
function stateOf(thread: ThreadFacts): string {
  const business = normalise(thread.business_state)
  return business === '' ? normalise(thread.state) : business
}

interface BaseCell {
  cell: ThreadCellId | null
  reason: string
}

/**
 * 一行该落哪一格。**先命中先返回，顺序即优先级**：
 *
 * 1. **已停**：运行态 `FAILED` / `CANCELLED`，或业务态 `REJECTED`。终态事实优先——
 *    一个已经停下的线程不产生任何注意力格，而「Run 已经失败」比业务态更新。
 *    一个失败的 Run 没有什么可审的；把它画进「待深度审」会让人打开一个死掉的任务。
 * 2. **待轻量答**：控制态 `awaiting-approval`。它压过待深度审：卡在批准上的动作，
 *    打开来只是一句 yes / no——放进「待深度审」会让人以为要读产出物，于是这次点击
 *    被当成一次心流成本被推迟。
 * 3. **待深度审**：业务态 `IN_REVIEW`。
 * 4. **执行中**：业务态 `ASSIGNED` / `EXECUTING` / `VERIFYING`。
 * 5. **已完成**：业务态 `DONE` / `ARCHIVED`。
 *
 * 其余（`DRAFT` / `ROUTING`、业务态缺失的旧行、词表外的值）**不落格**——设计只定义了五格，
 * 不替它猜一格。它们带着理由进「格外」区：猜错一格比放在外面难发现得多。
 *
 * 只认 `awaiting-approval` 一档控制态：其余控制态（paused / stopped / aborted）不参与分格。
 * 控制面有它自己的状态机，看板不复制它——复制的那一刻就有两份会分叉的判据。
 */
function baseCell(business: string, state: string, control: string): BaseCell {
  if (state === 'FAILED' || state === 'CANCELLED') {
    return { cell: 'stopped', reason: state === 'FAILED' ? 'Run 失败，等处置' : 'Run 已取消，等处置' }
  }
  if (business === 'REJECTED') return { cell: 'stopped', reason: '评审驳回，等处置' }
  if (control === 'AWAITING-APPROVAL') return { cell: 'light-answer', reason: '只等一次批准' }
  if (business === 'IN_REVIEW') return { cell: 'deep-review', reason: '有产出物待裁决' }
  if (business === 'ASSIGNED' || business === 'EXECUTING' || business === 'VERIFYING') {
    // 有活跃 Run 才是「在跑」；只有 ASSIGNED 的那些还在等节点开跑。
    return {
      cell: 'executing',
      reason: state === 'RUNNING' ? 'Run 在跑，无需介入' : '已分派，等节点开跑',
    }
  }
  if (business === 'DONE' || business === 'ARCHIVED') return { cell: 'done', reason: '已交付' }
  return { cell: null, reason: outsideReason(business, state) }
}

/** 格外的那些行为什么在格外。原因要能读出来，否则「格外」会变成垃圾桶。 */
function outsideReason(business: string, state: string): string {
  if (business === '') return '旧行没有业务态（legacy 不回填），无法判定归属格'
  if (business === 'DRAFT') return '业务态 DRAFT：还没提交，不占任何人的注意力'
  if (business === 'ROUTING') return '业务态 ROUTING：还在路由，等系统分派'
  return `业务态 ${business}（运行态 ${state || '未知'}）不在 §23.3 闭集内：不替它猜一格`
}

/**
 * 格内顺序：**按处置紧迫度，不按到达顺序**。
 *
 * 同一批数据换个顺序请求，呈现必须不变——这是本仓库对所有列表的既有要求（见
 * `layoutTaskBoard`）。在它之上再加一层：等得最久的排最前（离上限最近），
 * 执行中格把静默的顶到前面（它们才是需要看一眼的那些），已完成格反过来（最近的在前）。
 * 时间戳缺失的行排在最后：它们的时长未知，不该压在已知很旧的行前面。
 */
function order(cell: ThreadCellId, entries: ThreadBoardEntry[]): ThreadBoardEntry[] {
  const ordered = [...entries]
  if (cell === 'done') {
    return ordered.sort((left, right) =>
      (left.ageMs ?? Number.MAX_SAFE_INTEGER) - (right.ageMs ?? Number.MAX_SAFE_INTEGER) || compareIds(left, right))
  }
  const oldestFirst = (left: ThreadBoardEntry, right: ThreadBoardEntry): number =>
    (right.ageMs ?? -1) - (left.ageMs ?? -1) || compareIds(left, right)
  if (cell === 'executing') {
    return ordered.sort((left, right) => Number(right.silent) - Number(left.silent) || oldestFirst(left, right))
  }
  return ordered.sort(oldestFirst)
}

function minutes(ageMs: number): number {
  // 向下取整并至少为 1：宁可少报一分钟，也不声称一段不存在的静默。
  return Math.max(1, Math.floor(ageMs / 60_000))
}

/**
 * 把线程行投成五格。
 *
 * 每一行**最多**落一格；落了格的行不会再出现在别处（看板不是「同一件事在两个地方各说一遍」）。
 */
export function deriveThreadBoard(threads: readonly ThreadFacts[], options: ThreadBoardOptions): ThreadBoard {
  const stalledAfterMs = options.stalledAfterMs ?? DEFAULT_STALLED_AFTER_MS
  const waitTtlMs = options.waitTtlMs ?? DEFAULT_WAIT_TTL_MS
  const buckets = new Map<ThreadCellId, ThreadBoardEntry[]>(THREAD_CELLS.map(cell => [cell.id, []]))
  const outside: OutsideThread[] = []
  // 控制态读面缺一块时，这一格就不能声称「没有人在等」。两种缺法都要记：
  //   - 整层没接线（options.controlState !== true）；
  //   - 个别行没带 control_state（undefined，与 null「已读到、没有控制行」不是一回事）。
  let controlMissingRows = 0

  for (const thread of threads) {
    const business = normalise(thread.business_state)
    const state = normalise(thread.state)
    const control = normalise(thread.control_state)
    if (options.controlState === true && thread.control_state === undefined) controlMissingRows += 1
    const ageMs = elapsed(options.now, thread.updated_at)
    const base = baseCell(business, state, control)
    if (base.cell === null) {
      outside.push({ id: thread.id, title: thread.title?.trim() || thread.id, reason: base.reason })
      continue
    }

    const entry: ThreadBoardEntry = {
      id: thread.id,
      title: thread.title?.trim() || thread.id,
      owner: thread.assignee?.trim() || thread.node_id?.trim() || '未分派',
      state: stateOf(thread),
      reason: base.reason,
      ...ageMs === undefined ? {} : { ageMs },
      // 静默只对「有活跃 Run」成立：业务态在执行中、且运行态是 RUNNING。
      // 只有 ASSIGNED 的那些还没开跑——它们不静默，它们只是还没轮到。
      silent: base.cell === 'executing' && state === 'RUNNING' && ageMs !== undefined && ageMs > stalledAfterMs,
      waitExpired: false,
    }

    // 等待上限（§8.1）：超出上限的等待从等待格挪进「已停」格。
    // 只对两格等待生效——执行中不是等待，静默再久也不改格（它确实在跑）。
    if ((base.cell === 'deep-review' || base.cell === 'light-answer') && ageMs !== undefined && ageMs > waitTtlMs) {
      entry.waitExpired = true
      entry.reason = `等待超过上限（${minutes(ageMs)} 分钟未裁决，按默认上限估算）——按 §8.1 进「已停」等处置`
      buckets.get('stopped')!.push(entry)
      continue
    }
    buckets.get(base.cell)!.push(entry)
  }

  let placed = 0
  const columns = THREAD_CELLS.map(cell => {
    const entries = order(cell.id, buckets.get(cell.id) ?? [])
    placed += entries.length
    const column: ThreadBoardColumn = {
      id: cell.id, label: cell.label, attention: cell.attention, rule: cell.rule, entries,
    }
    if (cell.id === 'light-answer') {
      if (options.controlState !== true) {
        column.unreadable = '控制态读面未接线：会话的 awaiting-approval 只在 /lumo/api/sessions/{ref}/control 上按会话逐个读，没有列表读面。这一格读不到——「读不到」不等于「没有人在等」。'
      } else if (controlMissingRows > 0) {
        column.unreadable = `有 ${controlMissingRows} 行没有带控制态，这一格读不到——「读不到」不等于「没有人在等」。`
      }
    }
    return column
  })

  return { columns, outside, placed }
}
