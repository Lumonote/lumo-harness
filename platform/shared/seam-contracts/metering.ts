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
  /** 归因链：把一次 request 内跨成本类型的多行串起来。缺省时落哨兵值。 */
  traceId?: string
}

/**
 * 成本事件汇入口（评审 B2 的并行成本流）。
 *
 * **`usage_ledger` 只有一个写入者。** 发出方跨语言（连接器网关是 Go，seam Provider
 * 与 jobs 是 TS 插件），各自直连 PG 写台账就会有 N 份 schema 副本，必然漂移——这与
 * 「幂等白名单两张表」是同一类错误。发出方产出事件，由实现本接口的那一个写入者落库。
 *
 * §6.4 已写明计量事件走 RocketMQ `usage.event.*` 异步削峰，那是目标形态；RocketMQ
 * 尚未进部署拓扑（与 Nacos 同因），因此本期是进程内直写。接口留在这一层就是为了
 * 换传输时不动发出方。
 */
export interface CostEventSink {
  emit(event: import('./cost-events.ts').CostEvent): Promise<void>
  /** 按 trace 取回一条因果链，顺序稳定。 */
  byTrace(traceId: string): Promise<Array<import('./cost-events.ts').CostEvent>>
}

export interface MeteringSeam {
  /**
   * 前置拦截：预算检查 + 限流（两棵树都查，任一超限拒绝）。
   *
   * `estimate` 是本次调用的预估消耗量：给了就判「余额够不够这一次」，不给只判
   * 「余额是否还有」。**刻意做成可选**——`llm/stream` 在首 token 发出前拿不到准确
   * 预估，硬性要求会逼调用方编一个数字，而假预估比没预估更坏：它看起来像个判据。
   */
  reserve(context: MeterContext, estimate?: number): Promise<MeterResult>
  /** 实际消耗落账（reserve 通过后调用） */
  commit(record: MeterRecord): Promise<void>
  /** 预算树余额查询（维度: user/project）。**可为负数**——负数即透支量。 */
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

  // —— 场景 4：扣减必须无条件执行，允许负数 ——
  //
  // 这一条是补回一个真实缺陷：PG 实现曾在 UPDATE 上带 `AND budget >= $2`，于是
  // 「余额 500、消耗 600」时 0 行被更新、无报错，余额**冻结在 500**，而台账照记。
  // 下一次 reserve 读到 500 > 0 继续放行 —— 一旦「余额 < 单次调用量」，封顶就永久
  // 失效，方向朝着无限消费。
  //
  // 允许负数不是放松封顶，恰恰是让封顶可判：余额永远非负时，「已透支多少」这个量
  // 根本不存在，也就无法区分「刚好用完」与「超了三倍」。
  await resetBudgets(500, 500)
  await seam.commit({ context: ctx, tokens: 600, model: 'deepseek', costType: 'llm', costUsd: 0.6 })
  const over = await seam.balance({ kind: 'user', id: 'u1' })
  assert(over === -100, `超限扣减必须落到负数（得到 ${over}）—— 冻结在正数上等于封顶失效`)

  // 透支后必须拒（默认透支额度为 0）
  const afterOver = await seam.reserve(ctx)
  assert(!afterOver.approved, '余额为负时必须拒绝')

  // —— 场景 5：reserve 判「够不够这一次」——
  //
  // 只判「余额 > 0」的话，剩 1 token 的用户可以发起任意大的调用：封顶在事前完全
  // 不起作用，只能靠事后扣成负数补救。
  await resetBudgets(1, 10000)
  const tooBig = await seam.reserve(ctx, 100)
  assert(!tooBig.approved, '余额 1 而预估 100 必须拒绝')

  await resetBudgets(1000, 10000)
  const fits = await seam.reserve(ctx, 100)
  assert(fits.approved, '余额 1000 而预估 100 必须通过')

  // 不传 estimate 时退回「余额是否还有」——既有调用方行为不变
  await resetBudgets(1, 10000)
  const noEstimate = await seam.reserve(ctx)
  assert(noEstimate.approved, '不传 estimate 时余额为正即通过（保持既有调用方行为）')
}
