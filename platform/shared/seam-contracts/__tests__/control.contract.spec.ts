import { describe, expect, it } from 'vitest'
import {
  assertControlContract,
  ControlCommandRoutingError,
  EFFECTIVE_OUTCOMES,
  type ControlAudit,
  type ControlDecision,
  type ControlOutcome,
  type ControlPolicy,
  type ControlRequest,
  type ControlSeam,
  type SessionControlState,
} from '../control.ts'

/**
 * 内存实现（**合法形态 b**：本实例没接控制面）。
 *
 * 它刻意**不写状态**：§8.4 的状态与审计归 Go 控制面所有，本层只做前置与读。
 * 有权时抛 {@link ControlCommandRoutingError} —— 接线之后这不再是唯一合法行为，
 * 而是「本实例没配控制面地址」那一路。
 */
class MemoryControlSeam implements ControlSeam {
  policy: ControlPolicy
  readonly seen: ControlAudit[] = []
  readonly states = new Map<string, SessionControlState>()

  constructor(policy: ControlPolicy) {
    this.policy = policy
  }

  async dispatch(request: ControlRequest): Promise<ControlDecision> {
    const decision = await this.policy.evaluate(request)
    if (!decision.allowed) return decision
    throw new ControlCommandRoutingError(request.command, request.sessionRef)
  }

  async state(sessionRef: string): Promise<SessionControlState> {
    return this.states.get(sessionRef) ?? 'running'
  }

  async audit(sessionRef: string): Promise<ControlAudit[]> {
    return this.seen.filter((e) => e.sessionRef === sessionRef)
  }
}

/**
 * 内存实现（**合法形态 a**：本实例接了控制面）。返回控制面给的结论，
 * 由测试注入 outcome —— 用来证明契约对两路都通过，而不是只认「抛错」那一路。
 */
class ForwardingControlSeam extends MemoryControlSeam {
  constructor(policy: ControlPolicy, private readonly outcome: ControlOutcome) {
    super(policy)
  }

  override async dispatch(request: ControlRequest): Promise<ControlDecision> {
    const decision = await this.policy.evaluate(request)
    if (!decision.allowed) return decision
    return {
      allowed: EFFECTIVE_OUTCOMES.includes(this.outcome),
      outcome: this.outcome,
      detail: '来自假控制面的结论',
      toState: 'paused',
      revision: 7,
      correlationId: request.correlationId,
    }
  }
}

const rolePolicy: ControlPolicy = {
  evaluate: (req) => (req.role === 'viewer' ? { allowed: false, reason: 'not-authorized' } : { allowed: true }),
}

describe('control seam contract', () => {
  it('passes on the routing stub (no control plane configured)', async () => {
    const seam = new MemoryControlSeam(rolePolicy)
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertControlContract(seam, assert)
  })

  it('passes on a forwarding stub (control plane answered)', async () => {
    // 接线之后新增的合法路径：有权者真把请求交给控制面并带回结论。
    // 没有这一条，契约就只是在约束「必须抛错」——那会把接好线的实现判成违规。
    const seam = new ForwardingControlSeam(rolePolicy, 'applied')
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertControlContract(seam, assert)
  })

  it('passes when the control plane answers with a refusal', async () => {
    // 「控制面拒绝」也是拿到了结论（allowed=false + outcome），契约必须接受。
    const seam = new ForwardingControlSeam(rolePolicy, 'policy_denied')
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertControlContract(seam, assert)
  })

  it('rejects a provider that silently reports a successful dispatch', async () => {
    // 反向用例：把「有权 → 假装生效」的实现喂给契约，必须被抓住。没有这一条，
    // 上面的通过就只是「实现和断言碰巧都没说话」。
    //
    // 桩必须**先正确拒掉无权者**：否则契约会在第 4 条就红，这条用例就测不到第 5 条
    // ——「抓到了违规」与「抓到了这条违规」不是一回事。
    class PretendsToApply extends MemoryControlSeam {
      override async dispatch(request: ControlRequest): Promise<ControlDecision> {
        const decision = await this.policy.evaluate(request)
        if (!decision.allowed) return decision
        return { allowed: true }
      }
    }
    const seam = new PretendsToApply(rolePolicy)
    let caught = ''
    try {
      await assertControlContract(seam, (cond, msg) => {
        if (!cond) throw new Error(msg)
      })
    } catch (error) {
      caught = error instanceof Error ? error.message : String(error)
    }
    expect(caught, '假装已生效的实现必须被契约抓住').toContain('不得在本层直接声称生效')
  })

  it('rejects a provider whose allowed contradicts the outcome it reports', async () => {
    // 反向用例：带着控制面结论、但 allowed 与结论方向相反的实现。
    // 调用方**只**看 allowed 决定「生效了吗」，所以这种不一致会把一条被拒的指令
    // 报成成功——比不带 outcome 更难发现（看起来证据齐全）。
    class ContradictsOutcome extends MemoryControlSeam {
      override async dispatch(request: ControlRequest): Promise<ControlDecision> {
        const decision = await this.policy.evaluate(request)
        if (!decision.allowed) return decision
        return { allowed: true, outcome: 'state_rejected' }
      }
    }
    const seam = new ContradictsOutcome(rolePolicy)
    let caught = ''
    try {
      await assertControlContract(seam, (cond, msg) => {
        if (!cond) throw new Error(msg)
      })
    } catch (error) {
      caught = error instanceof Error ? error.message : String(error)
    }
    expect(caught, 'allowed 与 outcome 矛盾的实现必须被契约抓住').toContain('不一致')
  })
})
