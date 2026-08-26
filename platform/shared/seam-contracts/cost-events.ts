/**
 * 成本事件（评审 B2）。
 *
 * §6.4 的「所有 token 消耗只在 `ctx.llm` 这一道截面被计量」对 **token 记账**是正确
 * 设计，B2 也明确要求保留。但把它当**成本模型**就成了过度推广：token 成本 ≠ 总成本。
 * 连接器出向调用费、图/OLAP 查询算力、后台 job 算力、存储增长、非 LLM 的 GPU 时间
 * 全都不在那道截面上。
 *
 * **成本归因的失败模式不是「算少了」，是「解释不了」。** 账单低 20% 是定价问题；
 * 账单里有一个解释不清的尖峰是信誉问题，而信誉只死一次。所以本模块的设计目标不是
 * 「捕获全部成本」（不可能），而是：每一行都能归因到原因，且**未捕获的成本被显式
 * 命名**而不是静默缺席。未命名的缺口会让读账单的人以为账上就是全部。
 */
import type { MeterContext } from './metering.ts'
import costTypesManifest from '../manifests/cost-types.manifest.json' with { type: 'json' }

/**
 * 成本类型闭集。
 *
 * **为什么是闭集而不是自由文本**：B2 的核心诉求是「解释一次成本尖峰」，而没人能枚举
 * 一个自由文本列的取值，也就无法按类型下钻。未知取值**拒绝入账**，不记成 `unknown`
 * —— `unknown` 桶会稳定增长到没人敢动它。
 *
 * `unit` 是该类型的**唯一合法单位**。把量塞进错误的单位列会让口径不可读，而口径不可
 * 读的账单等于没有账单。
 *
 * **数值单一真相源**：闭集数值出自 `shared/manifests/cost-types.manifest.json`
 * （2026-08-26 单源化）；Go 消费侧（usage-ledger）embed 同一文件做校验。新增类型 =
 * 改 manifest + 两侧锁测试先红，语义注释只在此处。
 */
export const COST_TYPES = costTypesManifest.costTypes as {
  /** 唯一的 **token** 截面（`ctx.llm`）。B2 明确要求保留单截面规则。 */
  'llm.tokens': { unit: 'tokens' },
  /** 连接器网关出向调用：SaaS 按次计费。 */
  'connector.call': { unit: 'call' },
  /**
   * Seam Provider 自报的查询执行代价。
   *
   * 口径必须是**扫描行数**而非墙钟耗时：墙钟含排队与邻居干扰，按它计费会让用户为
   * 别人的负载付钱。§5.3.4 把「LLM 生成的坏查询」当安全问题（能不能跑，布尔判定），
   * 这里同时当成本问题（跑了记谁的账，连续量）。两侧不合并。
   */
  'seam.query': { unit: 'rows' },
  /** `ctx.jobs` 后台算力。 */
  'job.compute': { unit: 'second' },
  /** 复制日志 / 对象存储的存储增长。 */
  'storage.bytes': { unit: 'byte-day' },
  /** 非 LLM 推理的 GPU 时间。 */
  'inference.gpu': { unit: 'second' },
}

export type CostType = keyof typeof COST_TYPES

export interface CostEvent {
  /** 归因维度，与 `usage_ledger` 现有列一致。 */
  context: MeterContext
  costType: CostType
  /** 量，单位见 {@link unit}。允许 0（一次没扫到行的查询仍是一次发生过的调用）。 */
  qty: number
  /**
   * 单位。可从 `costType` 推出，**冗余是刻意的**：入库的行要能独立解读，不必回查
   * 代码里的映射表。但 {@link assertCostEvent} 必须校验两者一致，否则这份冗余就
   * 变成了第二个真相源。
   */
  unit: string
  /** 把一次 request 内跨语言、跨成本类型的多行串成一条因果链。 */
  traceId: string
  /** 发出方标识（具体网关/Provider/job）。出账争议要能定位到组件而非组件类别。 */
  emitter: string
  /** Provider 自报。本项不做费率表——费率、汇率、折扣属计费系统。 */
  costUsd: number
  /** 仅 `llm.tokens` 有意义；保留以不破坏现有查询。 */
  tokens?: number
  model?: string
}

/** 类型是否在闭集内。用 hasOwnProperty，否则 `constructor` / `toString` 会被判合法。 */
export function isCostType(t: string): t is CostType {
  return Object.prototype.hasOwnProperty.call(COST_TYPES, t)
}

/** 取该类型的合法单位。未知即抛，且错误信息列出全部合法取值。 */
export function unitFor(t: string): string {
  if (!isCostType(t)) {
    throw new Error(
      `未知成本类型 ${t}，拒绝入账。合法取值：${Object.keys(COST_TYPES).join(' / ')}`,
    )
  }
  return COST_TYPES[t].unit
}

/**
 * 入账前校验。失败即抛——**在写库之前**，不能先写再校验。
 *
 * 「先写再校验」在这里等于没有校验：一行脏数据一旦进了 append-only 台账就不能删，
 * 删了就破坏了 §6.4 的 append-only 承诺。
 */
export function assertCostEvent(e: CostEvent): void {
  const expected = unitFor(e.costType)
  if (e.unit !== expected) {
    throw new Error(
      `成本类型 ${e.costType} 的单位必须是 ${expected}，收到 ${e.unit}`,
    )
  }

  if (!Number.isFinite(e.qty) || e.qty < 0) {
    throw new Error(`${e.costType} 的 qty 必须是有限非负数，收到 ${e.qty}`)
  }
  // 负成本是记账错误，不是退款：退款是计费系统的冲正单据，不该伪装成一条负数消费
  if (!Number.isFinite(e.costUsd) || e.costUsd < 0) {
    throw new Error(`${e.costType} 的 costUsd 必须是有限非负数，收到 ${e.costUsd}`)
  }

  if (!e.traceId) throw new Error(`${e.costType} 缺 traceId：没有它，「这次尖峰是哪个请求引起的」只能靠时间戳猜`)
  if (!e.emitter) throw new Error(`${e.costType} 缺 emitter：出账争议时要能定位到具体组件`)

  for (const key of ['userId', 'deptId', 'role', 'projectId', 'agentId', 'componentId', 'feature', 'sessionRef'] as const) {
    if (!e.context[key]) throw new Error(`${e.costType} 的归因上下文缺 ${key}`)
  }

  if (e.costType === 'llm.tokens') {
    if (e.tokens === undefined || !e.model) {
      throw new Error('llm.tokens 必须带 tokens 与 model —— 它是唯一的 token 截面')
    }
    // 两个数不等说明口径已经分叉，此时无法判断哪个是真的
    if (e.tokens !== e.qty) {
      throw new Error(`llm.tokens 的 qty(${e.qty}) 必须等于 tokens(${e.tokens})`)
    }
  } else if (e.tokens !== undefined) {
    throw new Error(`${e.costType} 不得带 tokens —— 带了说明发出方把量塞错了列，应当用 qty/${expected}`)
  }
}
