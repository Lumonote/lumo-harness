import { describe, expect, it } from 'vitest'

import {
  BudgetAlerter,
  MAX_TRACKED_PERIODS,
  budgetState,
  resolveLimits,
  worseOf,
  type BudgetAlert,
  type BudgetLimits,
  type BudgetState,
} from '../budget-policy.ts'

/**
 * 预算四态（设计说明 §5）。
 *
 * B2 说「不补这些，配额首次上线就会被业务方要求回滚」。更准确的失效路径是：**只有
 * 硬停时，运维会把预算设成无穷大**，于是预算系统名义上存在、实际上不存在。软限额
 * 不是锦上添花，它是这个功能「能不能不被绕过」的分界线。
 */
describe('budgetState —— 四态边界', () => {
  const limits: BudgetLimits = { budget: 1000, softLimit: 800, overdraft: 200 }

  it('区间中点各自落在正确的态', () => {
    expect(budgetState(0, limits)).toBe('within')
    expect(budgetState(500, limits)).toBe('within')
    expect(budgetState(900, limits)).toBe('soft')
    expect(budgetState(1100, limits)).toBe('overdraft')
    expect(budgetState(5000, limits)).toBe('hard')
  })

  /**
   * 三个「恰好相等」的点。
   *
   * 边界差一是这类纯函数唯一的真实缺陷来源——区间中点无论怎么写都对，只有闭开区间
   * 的那一侧会错。所以这三个点单独立一条，而不是混在上面那条里。
   */
  it('恰好等于 softLimit → 已进 soft（左闭）', () => {
    expect(budgetState(800, limits)).toBe('soft')
    expect(budgetState(799, limits)).toBe('within')
  })

  it('恰好等于 budget → 已进 overdraft（左闭）', () => {
    expect(budgetState(1000, limits)).toBe('overdraft')
    expect(budgetState(999, limits)).toBe('soft')
  })

  it('恰好等于 budget + overdraft → 已进 hard（左闭）', () => {
    expect(budgetState(1200, limits)).toBe('hard')
    expect(budgetState(1199, limits)).toBe('overdraft')
  })

  /**
   * 缺省 limits 必须退化成今天的行为。
   *
   * 既有部署不该因为本项而改变行为：软限额缺省等于预算、透支缺省 0 → soft 与
   * overdraft 两个区间都是空集，只剩 within / hard。这一条是「本项不改默认行为」这句
   * 承诺的可执行形式。
   */
  it('缺省 limits 只出现 within / hard —— 默认行为与今天一致', () => {
    const bare: BudgetLimits = { budget: 1000 }
    const seen = new Set<BudgetState>()
    for (const used of [0, 1, 500, 999, 1000, 1001, 99_999]) {
      seen.add(budgetState(used, bare))
    }
    expect([...seen].sort()).toEqual(['hard', 'within'])
    expect(budgetState(999, bare)).toBe('within')
    expect(budgetState(1000, bare)).toBe('hard')
  })

  it('只给 softLimit 不给 overdraft 时，预算处即硬停', () => {
    const l: BudgetLimits = { budget: 1000, softLimit: 800 }
    expect(budgetState(800, l)).toBe('soft')
    expect(budgetState(1000, l)).toBe('hard')
  })

  it('budget 为 0 时任何消耗都是 hard —— 不能因为除零之类的写法漏成 within', () => {
    expect(budgetState(0, { budget: 0 })).toBe('hard')
    expect(budgetState(1, { budget: 0 })).toBe('hard')
  })

  /**
   * 配置自身不自洽时抛错，而不是返回一个「看起来合理」的态。
   *
   * softLimit > budget 时若不报错，used=600/budget=500/softLimit=1000 会被判成
   * `within` —— 已经超预算却显示预算内。一个错的态比抛错坏得多：它会被当成判据。
   */
  it('softLimit > budget 抛错 —— 否则超预算会被判成 within', () => {
    expect(() => budgetState(0, { budget: 500, softLimit: 1000 })).toThrow(/softLimit/)
  })

  it('负数与非有限值抛错', () => {
    expect(() => budgetState(0, { budget: -1 })).toThrow()
    expect(() => budgetState(0, { budget: 100, overdraft: -1 })).toThrow()
    expect(() => budgetState(0, { budget: 100, softLimit: -1 })).toThrow()
    expect(() => budgetState(-1, { budget: 100 })).toThrow()
    expect(() => budgetState(Number.NaN, { budget: 100 })).toThrow()
    expect(() => budgetState(0, { budget: Number.NaN })).toThrow()
    expect(() => budgetState(Number.POSITIVE_INFINITY, { budget: 100 })).toThrow()
  })

  /**
   * 降额不追溯（设计说明 §5）。
   *
   * 追溯回收等于把过去的合法调用变成违规。这里能断言的是纯函数这一侧：同一个 used
   * 在换了 limits 后只改变**状态**，不改变 used 本身——`budgetState` 没有任何返回
   * 「应回收多少」的出口，回收动作在类型上就不存在。
   */
  it('降额只改状态不回收：used 不变，函数也没有回收出口', () => {
    const used = 500
    expect(budgetState(used, { budget: 1000 })).toBe('within')
    expect(budgetState(used, { budget: 100 })).toBe('hard')
    expect(used).toBe(500)
  })
})

/**
 * `resolveLimits` —— 配置校验的单一来源（总额模型设计说明 §3）。
 *
 * `setBudget`/`adjustBudget` 的写入校验与 `budgetState` 的判态校验是同一件事：配置
 * 不自洽时两个点都必须拒绝。分开写两份必然漂移（与「幂等白名单两张表」同型），所以
 * 抽出来。判态路径已在上面 22 个用例锁死，这里断言的是配置路径。
 */
describe('resolveLimits —— 校验并补齐缺省（写入与判态共用）', () => {
  it('缺省补齐：softLimit = budget、overdraft = 0 —— 与判态的一致', () => {
    expect(resolveLimits(1000)).toEqual({ budget: 1000, softLimit: 1000, overdraft: 0 })
  })

  it('透传显式配置', () => {
    expect(resolveLimits(1000, { softLimit: 800, overdraft: 200 }))
      .toEqual({ budget: 1000, softLimit: 800, overdraft: 200 })
  })

  it('softLimit > budget 抛错 —— 与判态同一条错误理由', () => {
    expect(() => resolveLimits(500, { softLimit: 1000 })).toThrow(/softLimit/)
  })

  it('负数与非有限值抛错 —— 三路各自报错', () => {
    expect(() => resolveLimits(-1)).toThrow()
    expect(() => resolveLimits(100, { overdraft: -1 })).toThrow()
    expect(() => resolveLimits(100, { softLimit: -1 })).toThrow()
    expect(() => resolveLimits(Number.NaN)).toThrow()
    expect(() => resolveLimits(100, { overdraft: Number.POSITIVE_INFINITY })).toThrow()
  })
})

describe('worseOf —— 并行双树取更严者', () => {
  const order: BudgetState[] = ['within', 'soft', 'overdraft', 'hard']

  it('取更严的那个（§5：user 在 soft、project 在 hard 时结果是 hard）', () => {
    expect(worseOf('soft', 'hard')).toBe('hard')
    expect(worseOf('within', 'soft')).toBe('soft')
    expect(worseOf('overdraft', 'soft')).toBe('overdraft')
    expect(worseOf('within', 'within')).toBe('within')
  })

  it('满足交换律 —— 两棵树的检查顺序不该影响结论', () => {
    for (const a of order) {
      for (const b of order) {
        expect(worseOf(a, b), `${a} vs ${b}`).toBe(worseOf(b, a))
      }
    }
  })

  it('幂等，且与严重度序一致', () => {
    for (let i = 0; i < order.length; i++) {
      expect(worseOf(order[i]!, order[i]!)).toBe(order[i]!)
      for (let j = 0; j < order.length; j++) {
        expect(worseOf(order[i]!, order[j]!)).toBe(order[Math.max(i, j)]!)
      }
    }
  })
})

/**
 * 预警去重（设计说明 §5）。
 *
 * 刷一百条相同预警等于埋掉信号——与闸 C 的告警去重同理，所以复用它的形状：
 * 「已告警集合 + 有界淘汰」。
 */
describe('BudgetAlerter —— 同 (周期, 树, 状态) 只警一次', () => {
  const limits: BudgetLimits = { budget: 1000, softLimit: 800, overdraft: 200 }

  function capture() {
    const alerts: BudgetAlert[] = []
    const alerter = new BudgetAlerter({ onAlert: (a) => alerts.push(a) })
    return { alerts, alerter }
  }

  it('同周期同树同状态重复触发只回调一次', () => {
    const { alerts, alerter } = capture()
    expect(alerter.notice('2026-08', 'user:u1', 850, limits)).toBe(true)
    expect(alerter.notice('2026-08', 'user:u1', 860, limits)).toBe(false)
    expect(alerter.notice('2026-08', 'user:u1', 870, limits)).toBe(false)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.state).toBe('soft')
    expect(alerts[0]!.tree).toBe('user:u1')
    expect(alerts[0]!.period).toBe('2026-08')
  })

  it('状态升级要再发一次 —— soft→overdraft 是新信息', () => {
    const { alerts, alerter } = capture()
    expect(alerter.notice('2026-08', 'user:u1', 850, limits)).toBe(true)
    expect(alerter.notice('2026-08', 'user:u1', 1050, limits)).toBe(true)
    expect(alerter.notice('2026-08', 'user:u1', 1300, limits)).toBe(true)
    expect(alerts.map((a) => a.state)).toEqual(['soft', 'overdraft', 'hard'])
  })

  /**
   * 状态回落不重发。
   *
   * 已用量单调不减，所以回落只可能来自提额。提额后又降回去会重发 —— 那是「预算被上调
   * 又用光了」，确实是新信息；但同一状态内的抖动不该重发。
   */
  it('状态回落后不重发更轻的告警', () => {
    const { alerts, alerter } = capture()
    alerter.notice('2026-08', 'user:u1', 1050, limits)   // overdraft
    expect(alerter.notice('2026-08', 'user:u1', 850, limits)).toBe(false)  // soft，更轻
    expect(alerts.map((a) => a.state)).toEqual(['overdraft'])
  })

  it('换周期重新开始 —— 预算是周期内语义', () => {
    const { alerts, alerter } = capture()
    expect(alerter.notice('2026-08', 'user:u1', 850, limits)).toBe(true)
    expect(alerter.notice('2026-09', 'user:u1', 850, limits)).toBe(true)
    expect(alerts.map((a) => a.period)).toEqual(['2026-08', '2026-09'])
  })

  it('不同树互不影响', () => {
    const { alerts, alerter } = capture()
    expect(alerter.notice('2026-08', 'user:u1', 850, limits)).toBe(true)
    expect(alerter.notice('2026-08', 'project:p1', 850, limits)).toBe(true)
    expect(alerts.map((a) => a.tree)).toEqual(['user:u1', 'project:p1'])
  })

  it('within 不告警 —— 预算内没有信号', () => {
    const { alerts, alerter } = capture()
    expect(alerter.notice('2026-08', 'user:u1', 10, limits)).toBe(false)
    expect(alerts).toHaveLength(0)
  })

  it('告警字段齐全 —— 缺一个就得靠正则解析文案', () => {
    const { alerts, alerter } = capture()
    alerter.notice('2026-08', 'user:u1', 1050, limits)
    expect(alerts[0]).toEqual({
      period: '2026-08', tree: 'user:u1', state: 'overdraft',
      used: 1050, budget: 1000, softLimit: 800, overdraft: 200,
    })
  })

  /**
   * 去重集合必须有界。
   *
   * 周期键只增不减，不淘汰的 `Map<period, …>` 就是一处漏内存，而且是「功能看着完全
   * 正常」所以最容易过 review 的那种漏。**同一个坑不该防第二次才想起来**——闸 C 已经
   * 踩过一次（`warned` 集合随 turn 无界增长），这里直接照它的形状写。
   */
  it('跟踪的周期数有界，最旧的被淘汰', () => {
    const { alerter } = capture()
    for (let i = 0; i < MAX_TRACKED_PERIODS + 5; i++) {
      alerter.notice(`p${i}`, 'user:u1', 850, limits)
    }
    expect(alerter.trackedPeriods()).toBe(MAX_TRACKED_PERIODS)
  })

  it('被淘汰的周期再来会重新告警（语义是「不再跟踪」，不是「警过了」）', () => {
    const { alerts, alerter } = capture()
    alerter.notice('old', 'user:u1', 850, limits)
    for (let i = 0; i < MAX_TRACKED_PERIODS; i++) {
      alerter.notice(`p${i}`, 'user:u1', 850, limits)
    }
    expect(alerter.notice('old', 'user:u1', 850, limits)).toBe(true)
    expect(alerts.filter((a) => a.period === 'old')).toHaveLength(2)
  })
})
