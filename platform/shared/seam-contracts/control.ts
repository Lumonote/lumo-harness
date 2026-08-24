/**
 * 共享执行控制 seam 契约（§8.4）。
 * 控制指令（pause/resume/stop/abort/approve/reject/replay/degrade）是一等审计事件：
 * 必须全部经策略点评估、带 actor+reason 落入日志；终端只发指令不实现状态机（铁律 18）。
 *
 * 授权评估在 Provider 内部完成（策略函数由装配层注入 —— OPA 单点评估，§6.3），
 * 不在契约调用方。
 */

export type ControlCommand =
  | 'pause' | 'resume' | 'stop' | 'abort'
  | 'approve' | 'reject' | 'replay' | 'degrade'

export interface ControlPolicy {
  /** 返回 allowed=false + 具体失败原因（策略点由装配层注入，区别于实现细节） */
  evaluate(req: { command: ControlCommand; actor: string; role: string; realm: string; sessionRef: string }): ControlDecision
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
  allowed: boolean
  reason?: 'not-authorized' | 'policy-denied'
}

export interface ControlAudit {
  requestId: string
  command: ControlCommand
  sessionRef: string
  actor: string
  allowed: boolean
  decidedAt: number
}

export interface ControlSeam {
  /** 指令经策略评估并作为事件落日志；同 correlationId 幂等（至少一次投递按 id 去重，§8.3） */
  dispatch(request: ControlRequest): Promise<ControlDecision>
  /** 审计查询 —— 含被拒尝试在内的全部指令可回溯 */
  audit(sessionRef: string): Promise<ControlAudit[]>
}

/**
 * 契约断言：任何真实 Provider 实现都必须通过。
 * provider 由测试方构造（策略函数由测试注入以模拟有权/无权场景）。
 */
export async function assertControlContract(
  seam: ControlSeam,
  assert: (cond: boolean, msg: string) => void,
) {
  const req: ControlRequest = {
    command: 'pause', sessionRef: 's1', actor: 'alice',
    role: 'operator', realm: 'r1', reason: '临时停线', correlationId: 'c1',
  }

  // 有权分发通过
  const yes = await seam.dispatch(req)
  assert(yes.allowed, '有权者指令必须通过')

  // 无权者被拒且留审计
  const no = await seam.dispatch({ ...req, actor: 'bob', role: 'viewer', correlationId: 'c2' })
  assert(!no.allowed && no.reason === 'not-authorized', '无权者必须被拒')

  // 同 correlationId 幂等：重放不产生第二次动作（审计只记一条，§8.4）
  const dup = await seam.dispatch(req)
  assert(dup.allowed, '幂等重放不得拒绝')

  // 审计全量可回溯：c1（授权）、c2（拒绝）各一条，无重复
  const log = await seam.audit('s1')
  assert(log.length === 2, '幂等去重：同 correlationId 仅一条审计（得 ' + log.length + '）')
  // 按 correlationId 过滤，不能按 command 过滤：bob 那条被拒记录的 command
  // 同样是 'pause'（它是 {...req} 只覆写了 actor/role/correlationId）。
  assert(log.filter((e) => e.requestId === 'c1').length === 1, '同指令重放仅一次生效')
  assert(log.some((e) => e.actor === 'bob' && !e.allowed), '被拒尝试也必须入审计')
}
