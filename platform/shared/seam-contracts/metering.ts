/**
 * 计量 seam 契约（§6.4）。
 * 并行预算树模型（评审 N3）：一次调用同时扣「用户树」与「项目树」，任一超限即拒。
 * 明细落 PG（强一致溯源），限流额度前置拦截；本契约不关心具体存储，只断言语义。
 */
import type { BudgetLimits, BudgetState } from './budget-policy.ts'

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
  /**
   * 拒因是**闭集**，且每一项的处置不同——合成一个「预算不足」会让调用方无法决定该找谁。
   *
   * `denied-scope-budget` 与另外两项的区别不只是范围：用户树/项目树是**长期**额度，超了要
   * 去找管理员充值；而作用域上限是**单次工作**的封顶（例如一次受治理的执行），撞上它通常
   * 意味着「这次活干不完」，处置是收窄任务或调高那一次的上限。
   */
  reason?: 'denied-user-budget' | 'denied-project-budget' | 'denied-scope-budget' | 'ok'
  /** 消费记录引用（后续溯源一行串起 request→session→user→project→feature，§6.4） */
  ledgerRef: string
  /**
   * 双树中**更严**的那个态（§5，与 N3 的「任一超限即拒」一致）。
   *
   * 语义：**本次调用做完后**各树的投影状态，`used = (budget − balance) + need`，
   * 其中 `need = estimate ?? 1`（没有预估时按最小消费单位投影）。
   *
   * 与 `approved` 必须自洽：`approved === (state !== 'hard')`。透支是「放行且记账」，
   * 不是「拒绝」——把 `overdraft` 也判成拒绝就等于没实现透支。契约对两个实现都断言
   * 这条等价关系，否则 stub 与 PG 会各自漂移出一套「大致对」的语义。
   *
   * 为什么是投影而不是「当前余额的正负」：余额为正却判拒（余额 1、预估 100）的情形
   * 里，前者会说 `within` 而后者的正确措辞是 `hard`（连这次预估都放不下）——两条
   * 信息互相矛盾的 state 会被调用方当成「反正有个字段就对了」，比没有更糟。
   *
   * 未配置额度的树只可能出现 `within` / `hard`（见 `budget-policy.ts` 的缺省值），
   * 所以这个字段对既有部署不引入新行为。
   */
  state: BudgetState
}

export interface MeterRecord {
  context: MeterContext
  /** token 数（单位：tokens） */
  tokens: number
  model: string
  costType: string
  /**
   * 这次调用的成本（USD）。**省略 = 请记账方按费率算**（见下）。
   *
   * 区分「省略」与「0」是刻意的：前者是「发出方不知道价格」——节点侧的 agent 调用就是
   * 这一类，它拿不到上游账单，只能由记账方从 `llm_providers` 的费率推；后者是「知道，
   * 而且就是零元」（免费模型、缓存命中）。把两者合并成一个 0，会让一条**没人算过价的
   * 账**与一条**价格真的是零的账**在图上一模一样，而前者需要有人去补费率。
   */
  costUsd?: number
  /**
   * 输入 / 输出分开给，才能各按各的费率算。省略时退回「全部按输入价」的保守下界——
   * 输入价通常更低，所以那是**低估**而不是高估；宁可低估也不虚报。
   */
  inputTokens?: number
  outputTokens?: number
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
 * §6.4 已写明计量事件走 RocketMQ `usage-events-<cost_type>` 异步削峰（2026-08-26
 * 由真实 broker 联调修正：topic 点号非法，合法字符集 ^[%|a-zA-Z0-9_-]+$），那是目标形态；RocketMQ
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
  /**
   * 期初/重配：本期配额设为 `total`，剩余**重置为 total**（从头花）——周期开始、
   * 全量重配的入口。
   *
   * 预算三态（soft/overdraft）只在**有总额**的树上可达（见 `MeterResult.state` 的
   * 投影语义）；没有总额的树退化为两态（within/hard）。opts 不给时保留存储的
   * 软限额/透支（新行即缺省：softLimit=total、overdraft=0）。
   */
  setBudget(
    kind: 'user' | 'project', id: string, total: number,
    opts?: Omit<BudgetLimits, 'budget'>,
  ): Promise<void>
  /**
   * 期中调整：总额**平移**到 `newTotal`（remaining += newTotal − oldTotal），
   * 因此已用 `total − remaining` 不变——
   * - 降额不追溯：已发生的消费既不回收（used 不变）也不豁免（降额后下一次 reserve
   *   即按新总额判态，used ≥ total 即 hard）；
   * - 提额同样平移，已用不抹零。
   *
   * 旧行（无总额，两态语义）拒绝：先 `setBudget` 重配为总额模式——把「只有剩余」的
   * 旧行剩余当成总额去平移，结果是错的，不让它被隐式迁移。
   */
  adjustBudget(
    kind: 'user' | 'project', id: string, newTotal: number,
    opts?: Omit<BudgetLimits, 'budget'>,
  ): Promise<void>
}

/**
 * 作用域金额上限：给**一次工作**（目前是一次受治理的执行）封一个金额顶。
 *
 * # 为什么不复用 `budget_trees`
 *
 * 那一列的**单位是 token**（`commit` 扣的是 `record.tokens`，种子值
 * `LUMO_DEFAULT_BUDGET=1000000`）；而上限是**钱**（治理面存 `max_budget_cents`、前端标签
 * 「预算上限（分）」）。把两者塞进同一个 `budget` 列，就是本仓 E4/D6 已经吃过一次亏的那种
 * 设计——**一个字段承担两个语义**，reads 会按各自的理解解释同一个数。所以这里另起一张表，
 * 单位写在列名里。
 *
 * # 与 `reserve` 的关系
 *
 * `reserve` 会**一并**检查它（有行才查，没行 = 不限额，与「无预算记录时的隐性额度」同一条
 * 语义）。拒因是 `denied-scope-budget`，与另外两项分开——撞上它通常意味着「这次活干不完」，
 * 而不是「去找管理员充值」。
 *
 * # 语义是硬顶，没有三态
 *
 * 刻意不做软限额/透支：那三态是为**长期额度**设计的（超了还能继续跑，账记负数），而一次
 * 工作的封顶没有「下个周期」可言，透支了也没有地方还。简单反而诚实。
 */
export interface ScopeCapSeam {
  /** 设上限（同一 scope+id 重复设即覆盖，并把已花清零——它是**这次工作**的额度）。 */
  setCap(scope: string, id: string, capCents: number): Promise<void>
  /** 撤掉上限。撤掉之后不再拦截，已花的钱**不**回退（账是 append-only 的）。 */
  clearCap(scope: string, id: string): Promise<void>
  /** 本次工作已花的**分**；没有上限行时返回 `undefined`（不是 0——「没设过」与「花光了」不是一回事）。 */
  spentCents(scope: string, id: string): Promise<number | undefined>
}

/**
 * 受治理执行的上限所挂的 scope 名。
 *
 * 写成常量而不是各处散落字面量：它是**跨插件**的键（受治理执行写、计量截面读），
 * 两边拼错一个字母的症状是「上限设了但从来没生效」——而那与「本来就没超」长得一样。
 */
export const SCOPE_GOVERNED_RUN = 'governed-run'

/** 意图：树扣减原子性由上层（RocketMQ 事务消息）保证；本 seam 不引分布式事务（铁律 5） */
export async function assertMeteringContract(
  seam: MeteringSeam,
  assert: (cond: boolean, msg: string) => void,
  /**
   * `number` = 只设剩余（旧行两态语义，既有行为）；`BudgetLimits` = 期初重配为
   * 总额模式（remaining=budget、限额入列，**四态在契约里对两实现都验证**——不能学
   * 上个切片的残次品「四态只在 stub 上证明过」，那是「契约只跑 stub」的同形问题）。
   */
  resetBudgets: (user: number | BudgetLimits, project: number | BudgetLimits) => Promise<void>,
) {
  const ctx: MeterContext = {
    userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
    agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
  }

  /**
   * 每次 `reserve` 都查一遍 `approved ⟺ state !== 'hard'`。
   *
   * 放在契约里而不是各实现的测试里，是因为这正是本项开头修的那个元问题的形状：stub
   * 照契约写、PG 另外写，两者语义不一致而都「通过」。状态与放行判定分成两处表达时，
   * 最容易漂移的就是「透支到底放不放行」——把 `overdraft` 也判成拒绝等于没实现透支，
   * 而那个 bug 在两边各自的测试里都看不出来。
   */
  const check = (r: MeterResult, label: string): MeterResult => {
    assert(r.state !== undefined, `${label}：必须返回 state`)
    assert(
      r.approved === (r.state !== 'hard'),
      `${label}：approved(${r.approved}) 与 state(${r.state}) 不自洽` +
      ` —— 透支是「放行且记账」，不是「拒绝」`,
    )
    return r
  }

  // —— 场景 1：预算内通过 ——
  await resetBudgets(1000, 500)
  const ok = check(await seam.reserve(ctx), '场景1 预算内')
  assert(ok.approved && ok.reason === 'ok', '预算内调用必须通过')

  // —— 场景 2：项目树超限拒绝（user 仍充足；并行树任一超限即拒，评审 N3）——
  // 一次调用同时扣两棵树（1000-600=400, 500-600=-100）→ user 尚足而项目已超
  await seam.commit({ context: ctx, tokens: 600, model: 'deepseek', costType: 'llm', costUsd: 0.6 })
  const projOver = check(await seam.reserve(ctx), '场景2 项目树超限')
  assert(!projOver.approved && projOver.reason === 'denied-project-budget', '项目树超限必须拒绝')

  // —— 场景 3：用户树超限拒绝（项目树保持充足）——
  // 一次调用同时扣两棵树（user 100 超、project 10000 仍足）→ 应判用户树
  await resetBudgets(100, 10000)
  await seam.commit({ context: ctx, tokens: 5000, model: 'deepseek', costType: 'llm', costUsd: 5 })
  const userOver = check(await seam.reserve(ctx), '场景3 用户树超限')
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
  const afterOver = check(await seam.reserve(ctx), '场景4 透支后')
  assert(!afterOver.approved, '余额为负时必须拒绝')

  // —— 场景 5：reserve 判「够不够这一次」——
  //
  // 只判「余额 > 0」的话，剩 1 token 的用户可以发起任意大的调用：封顶在事前完全
  // 不起作用，只能靠事后扣成负数补救。
  await resetBudgets(1, 10000)
  const tooBig = check(await seam.reserve(ctx, 100), '场景5 预估过大')
  assert(!tooBig.approved, '余额 1 而预估 100 必须拒绝')

  await resetBudgets(1000, 10000)
  const fits = check(await seam.reserve(ctx, 100), '场景5 预估合适')
  assert(fits.approved, '余额 1000 而预估 100 必须通过')

  // 不传 estimate 时退回「余额是否还有」——既有调用方行为不变
  await resetBudgets(1, 10000)
  const noEstimate = check(await seam.reserve(ctx), '场景5 无预估')
  assert(noEstimate.approved, '不传 estimate 时余额为正即通过（保持既有调用方行为）')

  // —— 场景 6：四态投影 ——
  //
  // 上个切片的教训：四态只在 stub 上被证明过（stub 照契约写、PG 另外写，都「通过」），
  // 而 soft/overdraft 恰好是最可能写错的两态。这条正是把它拽回共享契约——两个实现
  // 被同一把尺子量，PG 没有总额模型也过不了这关。
  await resetBudgets({ budget: 1000, softLimit: 800, overdraft: 200 }, 10_000)
  await seam.commit({ context: ctx, tokens: 900, model: 'deepseek', costType: 'llm', costUsd: 0.9 })
  const sixSoft = check(await seam.reserve(ctx), '场景6 软限额')
  assert(sixSoft.approved && sixSoft.state === 'soft', 'used=901 落在 [800,1000) → soft 且放行')

  await seam.commit({ context: ctx, tokens: 200, model: 'deepseek', costType: 'llm', costUsd: 0.2 })
  const sixOver = check(await seam.reserve(ctx), '场景6 透支中')
  assert(sixOver.approved && sixOver.state === 'overdraft', 'used=1101 落在 [1000,1200) → overdraft 且放行')

  await seam.commit({ context: ctx, tokens: 200, model: 'deepseek', costType: 'llm', costUsd: 0.2 })
  const sixHard = check(await seam.reserve(ctx), '场景6 硬停')
  assert(!sixHard.approved && sixHard.state === 'hard', 'used=1301 ≥ 1200 → hard 且拒绝')

  // —— 场景 7：期中调整不追溯 ——
  //
  // 设计说明 §3：adjustBudget 的机制是「总额平移」，used = total − remaining 在调整前后
  // 不变。用 balance 的**精确值**断言：若实现错把降额当重配（remaining=新总额），
  // claimed used 会被抹零，这里立即红。
  await resetBudgets({ budget: 1000 }, 10_000)
  await seam.commit({ context: ctx, tokens: 900, model: 'deepseek', costType: 'llm', costUsd: 0.9 })
  const sevenBefore = check(await seam.reserve(ctx), '场景7 调整前')
  assert(sevenBefore.approved && sevenBefore.state === 'within', 'used=901 < 1000 → within 且放行')

  await seam.adjustBudget('user', 'u1', 500)   // 降额：Δ=−500，remaining 100 → −400
  assert(
    (await seam.balance({ kind: 'user', id: 'u1' })) === -400,
    '降额必须平移剩余（100 − 500 = −400），而不是把已用抹零',
  )
  const sevenLowered = check(await seam.reserve(ctx), '场景7 降额后')
  assert(!sevenLowered.approved && sevenLowered.state === 'hard', 'used=901 ≥ 500 → 立即 hard，不回收也不豁免')

  await seam.adjustBudget('user', 'u1', 2000)  // 提额：Δ=+1500，remaining −400 → 1100
  assert(
    (await seam.balance({ kind: 'user', id: 'u1' })) === 1100,
    '提额同样平移（−400 + 1500 = 1100），已用不因提额抹零',
  )
  const sevenRaised = check(await seam.reserve(ctx), '场景7 提额后')
  assert(sevenRaised.approved, '提额后放行（used 仍为 901 < 2000）')
}

/**
 * 台账管线不变式的共享尺子（设计说明 2026-08-26 §7）。
 *
 * 任何「事件 → 台账」搬运器——本地 outbox drain，以及将来把最后一步换成 RocketMQ
 * 消费侧的形态——都必须过同一套断言：防止「幂等只在 PG 直写下偶然成立」重演「四态
 * 只在 stub 上被证明过」。属性不在共享契约里，每个实现就会各写各的。
 *
 * 上层不变式（预算场景）由 {@link assertMeteringContract} 管；这里是**搬运输**的尺子。
 */
export interface DrainEnv {
  sink: CostEventSink
  /** 搬运一批，返回条数。测试内直接调用；生产由调度器轮询。 */
  drainOnce(): Promise<number>
  /** 台账行数（`usage_ledger`）。 */
  ledgerRows(): Promise<number>
  /** 模拟至少一次投递：所有事件的投影标记被撤掉，事件将被重新搬运。 */
  redeliverAll(): Promise<void>
}

export async function assertCostEventDrainContract(
  env: DrainEnv,
  events: Array<import('./cost-events.ts').CostEvent>,
  assert: (cond: boolean, msg: string) => void,
): Promise<void> {
  // —— D1 事件先入管线、drain 后入账 ——
  // 「写穿即见」已不是语义：emit 返回时行在事件管线（outbox/消息流），不在台账
  // （设计说明 §4：有界最终一致，事件时刻保真——延迟影响看到多晚，不改账单日期）。
  for (const e of events) await env.sink.emit(e)
  assert(
    (await env.ledgerRows()) === 0,
    'D1：emit 后台账必须是 0 行——写穿即见已不是语义，行先入管线',
  )
  assert(
    (await env.drainOnce()) === events.length,
    'D1：drain 条数必须等于事件数',
  )
  assert(
    (await env.ledgerRows()) === events.length,
    'D1：drain 后台账行数必须等于事件数',
  )

  // —— D2 重放幂等：至少一次投递下重放不重复入账 ——
  await env.redeliverAll()
  await env.drainOnce()
  assert(
    (await env.ledgerRows()) === events.length,
    'D2：重放后台账行数不变——一次事件一账（event_key 去重）',
  )
}
