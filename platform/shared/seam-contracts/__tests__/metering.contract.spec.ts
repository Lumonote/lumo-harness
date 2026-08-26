import { describe, expect, it } from 'vitest'
import { assertMeteringContract, type MeterResult, type MeteringSeam } from '../metering.ts'
import { budgetState, worseOf, type BudgetLimits, type BudgetState } from '../budget-policy.ts'

/** 内存实现：契约测试专用 stub（真实实现：PG 明细 + Redis 限流 + RocketMQ 事务双树扣减） */
class MemoryMeteringSeam implements MeteringSeam {
  userBudget = 0
  projectBudget = 0
  commitCount = 0
  /**
   * 额度配置。**stub 与 PG 都必须能表达四态**，否则契约里的
   * 「approved ⟺ state !== 'hard'」只在退化的两态上被验证过，而 soft/overdraft 恰好是
   * 本项新增、最可能写错的那两态。
   *
   * 缺省 `limitTotal` 为 undefined = 未配置额度 → 只可能 within / hard，与既有行为一致。
   */
  limits: { user?: BudgetLimits; project?: BudgetLimits } = {}

  async reserve(
    ctx: Parameters<MeteringSeam['reserve']>[0],
    estimate?: number,
  ): Promise<MeterResult> {
    // 并行预算树：任一超限即拒（评审 N3）
    // 判据是「够不够这一次」：给了 estimate 就按它判，否则退回「余额是否还有」
    const need = estimate ?? 1
    const userState = this.stateOf('user', this.userBudget, need)
    const projState = this.stateOf('project', this.projectBudget, need)

    const availOf = async (kind: 'user' | 'project') =>
      (await this.balance({ kind, id: kind === 'user' ? ctx.userId : ctx.projectId })) +
      (this.limits[kind]?.overdraft ?? 0)

    if (ctx.projectId === 'p1' && (await availOf('project')) < need) {
      return { approved: false, reason: 'denied-project-budget', ledgerRef: '', state: 'hard' }
    }
    if ((await availOf('user')) < need) {
      return { approved: false, reason: 'denied-user-budget', ledgerRef: '', state: 'hard' }
    }
    return {
      approved: true, reason: 'ok', ledgerRef: `ledger-${++this.commitCount}`,
      state: worseOf(userState, projState),
    }
  }

  /**
   * 该树的投影状态：`used = (budget − balance) + need`（契约里定义的语义）。
   *
   * 未配置额度的树无法算「已用」，只能以降额口径投影：`balance < need` 即 hard
   * （这个梯度恰好等于 `used = (budget − balance) + need` 在
   * `limits = { budget: balance }` 下的取值——按**当前余额**当成额度），否则 within。
   */
  private stateOf(kind: 'user' | 'project', remaining: number, need: number): BudgetState {
    const limits = this.limits[kind]
    if (!limits) {
      return remaining < need ? 'hard' as const : 'within' as const
    }
    return budgetState((limits.budget - remaining) + need, limits)
  }

  async commit(record: Parameters<MeteringSeam['commit']>[0]): Promise<void> {
    this.userBudget -= record.tokens
    if (record.context.projectId === 'p1') this.projectBudget -= record.tokens
  }

  async balance(key: { kind: 'user' | 'project'; id: string }): Promise<number> {
    return key.kind === 'user' ? this.userBudget : this.projectBudget
  }
}

describe('metering seam contract', () => {
  it('passes on the memory stub (parallel budget tree semantics)', async () => {
    const seam = new MemoryMeteringSeam()
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertMeteringContract(seam, assert, async (user, project) => {
      seam.userBudget = user
      seam.projectBudget = project
    })
  })

  /**
   * 透支必须是「放行且记账」。
   *
   * 这条单独立在 stub 侧，因为共享契约的 `resetBudgets` 只设余额、不设额度，四态里的
   * soft/overdraft 在那里到不了。而「把 overdraft 也判成拒绝」正是最容易犯的错——它让
   * 透支功能在名义上存在、实际上等于硬停。
   */
  it('配置了透支额度时，超预算仍放行且状态为 overdraft', async () => {
    const seam = new MemoryMeteringSeam()
    seam.limits = {
      user: { budget: 1000, softLimit: 800, overdraft: 200 },
      project: { budget: 10_000 },
    }
    seam.userBudget = 1000
    seam.projectBudget = 10_000

    // 用掉 900 → 已用 900 落在 [softLimit=800, budget=1000) → soft，放行
    await seam.commit({
      context: {
        userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
        agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
      },
      tokens: 900, model: 'deepseek', costType: 'llm', costUsd: 0.9,
    })
    const soft = await seam.reserve({
      userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
      agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
    })
    expect(soft.state).toBe('soft')
    expect(soft.approved).toBe(true)

    // 再用 200 → 已用 1100 落在 [1000, 1200) → overdraft，仍放行
    await seam.commit({
      context: {
        userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
        agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
      },
      tokens: 200, model: 'deepseek', costType: 'llm', costUsd: 0.2,
    })
    const over = await seam.reserve({
      userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
      agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
    })
    expect(over.state).toBe('overdraft')
    expect(over.approved, '透支是放行且记账，不是拒绝').toBe(true)

    // 再用 200 → 已用 1300 ≥ 1200 → hard，拒绝
    await seam.commit({
      context: {
        userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
        agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
      },
      tokens: 200, model: 'deepseek', costType: 'llm', costUsd: 0.2,
    })
    const hard = await seam.reserve({
      userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
      agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
    })
    expect(hard.state).toBe('hard')
    expect(hard.approved).toBe(false)
  })
})
