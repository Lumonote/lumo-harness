import { describe, expect, it } from 'vitest'
import {
  assertControlContract,
  type ControlAudit,
  type ControlDecision,
  type ControlPolicy,
  type ControlRequest,
  type ControlSeam,
} from '../control.ts'

/** 内存实现：策略函数由装配层注入（模拟 OPA 单点评估，§6.3）—— 契约断言 authorized 由测试注入 */
class MemoryControlSeam implements ControlSeam {
  policy: ControlPolicy
  seen = new Map<string, ControlAudit>()

  constructor(policy: ControlPolicy) {
    this.policy = policy
  }

  async dispatch(request: ControlRequest): Promise<ControlDecision> {
    // 幂等去重：同 correlationId 只评估生效一次（§8.3 至少一次投递按 id 去重）
    if (this.seen.has(request.correlationId)) {
      const first = this.seen.get(request.correlationId)!
      return { allowed: first.allowed }
    }
    const decision = await this.policy.evaluate(request)
    this.seen.set(request.correlationId, {
      requestId: request.correlationId,
      command: request.command,
      sessionRef: request.sessionRef,
      actor: request.actor,
      allowed: decision.allowed,
      decidedAt: 0,
    })
    return decision
  }

  async audit(sessionRef: string): Promise<ControlAudit[]> {
    return [...this.seen.values()].filter((e) => e.sessionRef === sessionRef)
  }
}

describe('control seam contract', () => {
  it('passes on the memory stub with policy injection', async () => {
    // 策略：viewer 角色无权，其余角色有权（模拟 OPA 决策）
    const policy: ControlPolicy = {
      evaluate: (req) =>
        req.role === 'viewer' ? { allowed: false, reason: 'not-authorized' } : { allowed: true },
    }
    const seam = new MemoryControlSeam(policy)
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertControlContract(seam, assert)
  })
})
