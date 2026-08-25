import { describe, expect, it } from 'vitest'
import { assertMeteringContract, type MeterResult, type MeteringSeam } from '../metering.ts'

/** 内存实现：契约测试专用 stub（真实实现：PG 明细 + Redis 限流 + RocketMQ 事务双树扣减） */
class MemoryMeteringSeam implements MeteringSeam {
  userBudget = 0
  projectBudget = 0
  commitCount = 0

  async reserve(
    ctx: Parameters<MeteringSeam['reserve']>[0],
    estimate?: number,
  ): Promise<MeterResult> {
    // 并行预算树：任一超限即拒（评审 N3）
    // 判据是「够不够这一次」：给了 estimate 就按它判，否则退回「余额是否还有」
    const need = estimate ?? 1
    if (ctx.projectId === 'p1' && this.projectBudget < need) {
      return { approved: false, reason: 'denied-project-budget', ledgerRef: '' }
    }
    if (this.userBudget < need) {
      return { approved: false, reason: 'denied-user-budget', ledgerRef: '' }
    }
    return { approved: true, reason: 'ok', ledgerRef: `ledger-${++this.commitCount}` }
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
})
