/**
 * 预算四态与预警去重（评审 B2 / 设计说明 §5）。
 *
 * B2 说「不补这些，配额首次上线就会被业务方要求回滚」。更准确的失效路径是：**只有
 * 硬停时，运维会把预算设成无穷大**——一个只会「放行」或「直接失败」的封顶，第一次
 * 误伤线上业务就会被调成 `budget = 9e18`，于是预算系统名义上存在、实际上不存在。
 * 软限额与透支不是锦上添花，它们是这个功能能不能不被绕过的分界线。
 *
 * 本模块是**纯策略**：只回答「这个用量处于哪个态」，不查库、不拒绝、不回收。判定与
 * 执法分开，是因为执法点有两个（`reserve` 的事前拦截、告警管道的事后通知）而判定只该
 * 有一份。
 */

/**
 * 四态。顺序即严重度序，`worseOf` 依赖它。
 *
 * - `within`   已用 < 软限额 → 放行
 * - `soft`     软限额 ≤ 已用 < 预算 → 放行 + 结构化预警
 * - `overdraft` 预算 ≤ 已用 < 预算 + 透支额度 → 放行 + 预警升级，透支量事后结算
 * - `hard`     已用 ≥ 预算 + 透支额度 → 拒绝
 */
export type BudgetState = 'within' | 'soft' | 'overdraft' | 'hard'

/** 严重度序。放在一处，`worseOf` 与告警升级判定共用——两份序必然漂移。 */
const SEVERITY: readonly BudgetState[] = ['within', 'soft', 'overdraft', 'hard']

export interface BudgetLimits {
  budget: number
  /**
   * 软限额。**缺省 = `budget`** → `soft` 区间为空集。
   *
   * 缺省值这样选是为了让既有部署行为不变：不配软限额时四态退化为今天的「预算内放行 /
   * 到点硬停」。默认值改变既有行为的功能，上线第一天就会被当成故障。
   */
  softLimit?: number
  /** 透支额度。**缺省 0** → `overdraft` 区间为空集。开启透支是显式决定，不默认继承。 */
  overdraft?: number
}

/**
 * 判态。
 *
 * 区间一律**左闭右开**：`used === softLimit` 已进 `soft`，`used === budget` 已进
 * `overdraft`，`used === budget + overdraft` 已进 `hard`。选左闭是因为「恰好用完预算」
 * 必须已经越界——若 `used === budget` 仍判放行，那么预算为 1000 的树实际能用到 1001。
 */
export function budgetState(used: number, limits: BudgetLimits): BudgetState {
  finite('used', used)
  const { budget, softLimit, overdraft } = resolveLimits(limits.budget, limits)

  if (used < softLimit) return 'within'
  if (used < budget) return 'soft'
  if (used < budget + overdraft) return 'overdraft'
  return 'hard'
}

/**
 * 并行双树取更严者（§5；与 N3 的「任一超限即拒」一致）。
 *
 * 满足交换律与幂等——两棵树的检查顺序不该影响结论。
 */
export function worseOf(a: BudgetState, b: BudgetState): BudgetState {
  return SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b
}

/** 该状态是否应当放行。`hard` 之外都放行——透支是「放行且记账」，不是「拒绝」。 */
export function isAllowed(state: BudgetState): boolean {
  return state !== 'hard'
}

/**
 * 校验并补齐预算配置（不含 `used`）——**配置写入与判态的同一份校验**（总额模型设计
 * 说明 §3）。
 *
 * `setBudget`/`adjustBudget` 把配置落库前必须用它预检：配置不自洽时**在写入处拒绝**，
 * 而不是让它延迟成 `reserve` 判态时的 run 时抛错——配置错误被延迟到线上才炸，比
 * 配置时拒绝坏得多。判态侧的校验与写入侧分开写两份必然漂移（与「幂等白名单两张表」
 * 同型），所以 `budgetState` 也走这里。
 *
 * 不自洽的另一种表现是「返回一个看起来合理的态」：`softLimit > budget` 时若放过，
 * `used=600 / budget=500 / softLimit=1000` 会被判成 `within` —— 已经超预算却显示预算
 * 内。一个错的态比抛错坏得多，因为它会被当成判据。
 */
export function resolveLimits(
  budget: number,
  opts?: Omit<BudgetLimits, 'budget'>,
): Required<BudgetLimits> {
  finite('budget', budget)

  const overdraft = opts?.overdraft ?? 0
  finite('overdraft', overdraft)

  // 缺省等于 budget：soft 区间为空 → 退化为今天的硬停
  const softLimit = opts?.softLimit ?? budget
  finite('softLimit', softLimit)
  if (softLimit > budget) {
    throw new Error(
      `softLimit(${softLimit}) 不得大于 budget(${budget})：` +
      `否则已超预算的用量会被判成 within，而一个错的态会被当成判据`,
    )
  }

  return { budget, softLimit, overdraft }
}

/** 有限非负校验。NaN 会让所有比较都为 false，从而静默落到最后一个分支。 */
function finite(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`${name} 必须是有限非负数，收到 ${v}`)
  }
}

/** 预警事件。字段齐全才能进告警规则与 CI 断言，缺一个就得靠正则解析文案。 */
export interface BudgetAlert {
  /** 计费周期标识（如 `2026-08`）。预算是周期内语义，跨周期重新开始。 */
  period: string
  /** 预算树标识（如 `user:u1` / `project:p1`）。 */
  tree: string
  state: BudgetState
  used: number
  budget: number
  softLimit: number
  overdraft: number
}

export interface BudgetAlerterOptions {
  onAlert?: (alert: BudgetAlert) => void
}

/**
 * 保留的周期数。
 *
 * 周期键只增不减，不淘汰的 `Map<period, …>` 就是一处漏内存——而且是「功能看着完全
 * 正常」所以最容易过 review 的那种。**同一个坑不防第二次**：闸 C 的 `warned` 集合
 * 已经踩过一次（随 turn 无界增长），这里照它的形状写。
 *
 * 4 个足够覆盖「上个月到这个月」的跨周期查询窗口。
 */
export const MAX_TRACKED_PERIODS = 4

/**
 * 预警去重器（形状复用闸 C 的 `TurnCallBudget`）。
 *
 * 同 (周期, 树, 状态) 只发一次：刷一百条相同预警等于埋掉信号。**状态升级要再发**
 * —— `soft` → `overdraft` 是新信息。
 */
export class BudgetAlerter {
  private readonly onAlert?: (alert: BudgetAlert) => void
  /** period → tree → 已告警过的最高状态。Map 插入序即淘汰序。 */
  private readonly seen = new Map<string, Map<string, BudgetState>>()

  constructor(options: BudgetAlerterOptions = {}) {
    this.onAlert = options.onAlert
  }

  /**
   * 记一次观测，必要时告警。返回**是否真的发了**告警。
   *
   * 返回布尔而不是 void，是为了让「去重生效了没有」可断言——否则只能去数回调次数，
   * 而那把去重逻辑和回调注册两件事绑在了一起。
   */
  notice(period: string, tree: string, used: number, limits: BudgetLimits): boolean {
    const state = budgetState(used, limits)
    // 预算内没有信号
    if (state === 'within') return false

    const perTree = this.touch(period)
    const previous = perTree.get(tree)
    // 同态或回落不重发：已用量单调不减，回落只可能来自提额，那不是新的坏消息
    if (previous !== undefined && SEVERITY.indexOf(state) <= SEVERITY.indexOf(previous)) {
      return false
    }
    perTree.set(tree, state)

    const { budget, softLimit, overdraft } = resolveLimits(limits.budget, limits)
    this.onAlert?.({ period, tree, state, used, budget, softLimit, overdraft })
    return true
  }

  /** 正在跟踪的周期数。给内存有界性一个可断言的表面。 */
  trackedPeriods(): number {
    return this.seen.size
  }

  private touch(period: string): Map<string, BudgetState> {
    const existing = this.seen.get(period)
    if (existing) return existing

    const fresh = new Map<string, BudgetState>()
    this.seen.set(period, fresh)
    // 淘汰最旧插入的周期
    while (this.seen.size > MAX_TRACKED_PERIODS) {
      const oldest = this.seen.keys().next()
      if (oldest.done) break
      this.seen.delete(oldest.value)
    }
    return fresh
  }
}
