/**
 * 计量 seam 契约（§6.4）。
 * 并行预算树模型（评审 N3）：一次调用同时扣「用户树」与「项目树」，任一超限即拒。
 * 明细落 PG（强一致溯源），限流额度前置拦截；本契约不关心具体存储，只断言语义。
 */

export interface MeterContext {
  userId: string
  deptId: string
  role: string
  projectId: string
  agentId: string
  componentId: string
  feature: string
  sessionRef: string
}

export interface MeterResult {
  approved: boolean
  reason?: 'denied-user-budget' | 'denied-project-budget' | 'ok'
  /** 消费记录引用（后续溯源一行串起 request→session→user→project→feature，§6.4） */
  ledgerRef: string
}

export interface MeterRecord {
  context: MeterContext
  /** token 数（单位：tokens） */
  tokens: number
  model: string
  costType: string
  costUsd: number
}

export interface MeteringSeam {
  /** 前置拦截：预算检查 + 限流（两棵树都查，任一超限拒绝） */
  reserve(context: MeterContext): Promise<MeterResult>
  /** 实际消耗落账（reserve 通过后调用） */
  commit(record: MeterRecord): Promise<void>
  /** 预算树余额查询（维度: user/project） */
  balance(key: { kind: 'user' | 'project'; id: string }): Promise<number>
}

/** 意图：树扣减原子性由上层（RocketMQ 事务消息）保证；本 seam 不引分布式事务（铁律 5） */
export async function assertMeteringContract(
  seam: MeteringSeam,
  assert: (cond: boolean, msg: string) => void,
  resetBudgets: (user: number, project: number) => Promise<void>,
) {
  const ctx: MeterContext = {
    userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
    agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
  }

  // —— 场景 1：预算内通过 ——
  await resetBudgets(1000, 500)
  const ok = await seam.reserve(ctx)
  assert(ok.approved && ok.reason === 'ok', '预算内调用必须通过')

  // —— 场景 2：项目树超限拒绝（user 仍充足；并行树任一超限即拒，评审 N3）——
  // 一次调用同时扣两棵树（1000-600=400, 500-600=-100）→ user 尚足而项目已超
  await seam.commit({ context: ctx, tokens: 600, model: 'deepseek', costType: 'llm', costUsd: 0.6 })
  const projOver = await seam.reserve(ctx)
  assert(!projOver.approved && projOver.reason === 'denied-project-budget', '项目树超限必须拒绝')

  // —— 场景 3：用户树超限拒绝（项目树保持充足）——
  // 一次调用同时扣两棵树（user 100 超、project 10000 仍足）→ 应判用户树
  await resetBudgets(100, 10000)
  await seam.commit({ context: ctx, tokens: 5000, model: 'deepseek', costType: 'llm', costUsd: 5 })
  const userOver = await seam.reserve(ctx)
  assert(!userOver.approved && userOver.reason === 'denied-user-budget', '用户树超限必须拒绝')

  // 溯源记录可用（场景 3 后：project 已扣 5000 后余 5000，需仍可查询）
  const bal = await seam.balance({ kind: 'project', id: 'p1' })
  assert(typeof bal === 'number' && bal === 5000, '余额须可查询且数值正确')
}
