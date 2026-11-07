/**
 * @lumo/metering —— 计量单截面插件（§6.4 + 评审 N3 并行预算树）。
 *
 * 挂接点：llm/stream 瀑布（必须 next()，观察流并累计 usage）；
 * 归因：装配层配置为默认，受治理执行按可信 session 绑定 owner/project/agent/run；
 * 预算：PG 双树（user/project），reserve 前置拦截；明细入 usage_ledger。
 *
 * 采用 dsh 原生 ctx.tokenMeter（TokenUsageProjection 口径）作为 token 核算底座，
 * 本插件负责「归因 + 预算 + 台账」，不重复实现 token 估算。
 */
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import { Context } from '@deepseek-ai/cordis'

import { PgMeteringSeam } from './pg-meter.ts'
import type { MeterContext, MeterRecord } from '../../../shared/seam-contracts/metering.ts'
import { SessionMeterRegistry } from '../../../shared/seam-contracts/meter-attribution.ts'
import { quotedModelCost, type SessionModelBillingRoute } from '../../../shared/seam-contracts/model-billing.ts'

export interface MeteringConfig {
  connectionString: string
  /** 未显式绑定执行身份时的节点归因上下文。 */
  userId: string
  deptId: string
  role: string
  projectId: string
  agentId: string
  componentId: string
  /** feature 标签（如 kb:qa / flow:<id>），计量溯源维度（§6.4） */
  feature: string
  /** 无预算记录时的隐性额度：缺省 1e9（即视为不限额）；启用额度管理需预置 budget_trees 行 */
  defaultBudget: number
  /** 台账搬运轮询间隔 ms（缺省 1000；outbox → usage_ledger，设计说明 2026-08-26 §5） */
  drainIntervalMs?: number
  /** 单轮搬运条数上限（缺省 100） */
  drainBatchSize?: number
  /**
   * 台账搬运装配形态（设计说明 2026-08-26 §2 互斥装配，缺省 'local'）：
   * - 'local'：本插件 drainOnce 轮询直搬（Local-lite，无 RocketMQ）；
   * - 'rmq'：搬运交给 usage-ledger Go 服务（outbox → RocketMQ → usage_ledger），
   *   本插件只写 outbox 与扣预算——两条路径**绝不并存**（台账单一写入者）。
   * 误配双开不是数据错误（幂等键兜底）而是双重搬运的资源浪费与指标假象，
   * 因此互斥在装配层裁决，不靠运维自觉。
   */
  ledgerTransport?: 'local' | 'rmq'
}

/** 依赖注入：llm 服务须先 mount（计量挂在 llm/stream 瀑布） */
export const inject = ['llm']

/** 装配裁决（导出为纯函数供装配测试）：仅 local 形态由本插件起 drain 轮询。 */
export function shouldRunLocalDrain(config: MeteringConfig): boolean {
  return (config.ledgerTransport ?? 'local') === 'local'
}

export function apply(ctx: Context, config: MeteringConfig): void {
  const meter = new PgMeteringSeam(config.connectionString)

  // 作用域金额上限的写入口（`ScopeCapSeam`）。**为什么要 provide**：设上限的是**调用方**
  // ——受治理执行在开跑前给它那一次执行封顶——而配额本身由这里执法。没有这个服务，调用方
  // 唯一的办法是直连 PG 写本插件的表，那就等于把 schema 复制一份出去（本仓明确反对：
  // 「各自直连 PG 写台账就会有 N 份 schema 副本，必然漂移」）。
  const scopes = new SessionMeterRegistry()
  ctx.provide('meteringScope', scopes)
  // Admission and accounting both await the same initialization, including failures.
  const ready = meter.init().then(async () => {
    await meter.seedDefaultBudget('user', config.userId, config.defaultBudget)
    await meter.seedDefaultBudget('project', config.projectId, config.defaultBudget)
  })
  ctx.provide('sessionModelBilling', { quote: async (route: SessionModelBillingRoute) => { await ready; return meter.quoteModel(route) } })
  ctx.provide('meteringCaps', {
    setCap: async (...args: Parameters<typeof meter.setCap>) => { await ready; return meter.setCap(...args) },
    clearCap: async (...args: Parameters<typeof meter.clearCap>) => { await ready; return meter.clearCap(...args) },
    spentCents: async (...args: Parameters<typeof meter.spentCents>) => { await ready; return meter.spentCents(...args) },
  })
  ctx.provide('projectBudgets', {
    readProjectBudget: async (...args: Parameters<typeof meter.readProjectBudget>) => { await ready; return meter.readProjectBudget(...args) },
    configureProjectBudget: async (...args: Parameters<typeof meter.configureProjectBudget>) => { await ready; return meter.configureProjectBudget(...args) },
  })

  const drainIntervalMs = Math.max(config.drainIntervalMs ?? 1000, 100)
  const drainBatchSize = config.drainBatchSize ?? 100

  // 计量事件从请求路径拿掉后的后台搬运（设计说明 2026-08-26 §5）：
  // outbox → usage_ledger 轮询。失败只 warn 不抛——outbox 未标记 projected_at，
  // 下一轮自然重放（同 knowledge 投影器）。unref 不阻塞进程退出。
  ctx.effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false
    // 种子、准入和轮询共用 ready；初始化失败时模型准入也拒绝。
    void ready.then(() => {
      if (disposed) return
      // 互斥装配（设计说明 §2）：rmq 形态下 drain 轮询不起——台账搬运归
      // usage-ledger Go 服务（publisher/consumer）。此处继续留着的 init/种子
      // 与预算扣减在两种形态下都需要（outbox 写入路径不变）。
      if (!shouldRunLocalDrain(config)) {
        ctx.logger.info('metering: ledgerTransport=rmq —— 台账搬运由 usage-ledger Go 服务负责，本插件不起 drain 轮询')
        return
      }
      timer = setInterval(() => {
        meter.drainOnce(drainBatchSize).catch((e: unknown) => {
          ctx.logger.warn('metering: 台账搬运失败（将在下一轮重放）: %s', e)
        })
      }, drainIntervalMs)
      timer.unref?.()
    }).catch((e: unknown) => {
      ctx.logger.error('metering: 初始化失败，台账搬运未启动: %s', e)
    })
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
    }
  })

  const context = {
    userId: config.userId, deptId: config.deptId, role: config.role,
    projectId: config.projectId, agentId: config.agentId,
    componentId: config.componentId, feature: config.feature, sessionRef: '',
  }

  // 计量单截面：llm/stream 瀑布观察（必须 next() —— §8.3/事件瀑布规则；next 同步返回 AsyncIterable）
  ctx.on('llm/stream', function (options, next) {
    // 单截面计量：所有模型调用流经 ctx.llm.stream —— 此处为唯一计费截面（§6.4）
    const sessionRef = options.sessionId ?? (options as { session?: { id?: string } }).session?.id ?? 'system'
    const attribution = scopes.resolve(sessionRef)
    const sessCtx = { ...context, ...attribution?.context, sessionRef }
    // 输入 / 输出**分开累计**：费率表给的是两个价（每百万 token），合并成一个数就没法
    // 按各自的价格算。这里少记一个变量，下游就得拿「较高的那个价」去兜（见 pg-meter 的
    // costOf），而兜出来的数比真实成本高——账是 append-only 的，写进去就改不回来了。
    let inputTokens = 0
    let outputTokens = 0
    const model = options.model
    const delegatingStream = (async function* () {
      await ready
      const route = attribution?.modelRoutes?.find(route => route.provider === options.provider && route.model === options.model)
      if (attribution?.modelRoutes && !route) throw new Error('metering: native model route is not approved for this Session')
      const quote = route === undefined ? undefined : await meter.quoteModel(route)
      // 前置拦截：首 token 发出前预检双树预算（§6.4 限流前置语义）
      const approval = await meter.reserve(sessCtx)
      if (!approval.approved) {
        throw new Error(`metering: 预算拒绝 —— ${approval.reason}（feature=${config.feature}）`)
      }
      try {
        for await (const chunk of next()) {
          // Current DSH normalizes usage to camelCase; keep old adapter counters readable.
          const usage = (chunk as { usage?: Record<string, unknown> }).usage
          if (usage) {
            const u = usage as { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
            inputTokens = u.inputTokens ?? u.input_tokens ?? u.prompt_tokens ?? inputTokens
            outputTokens = u.outputTokens ?? u.output_tokens ?? u.completion_tokens ?? outputTokens
          }
          yield chunk
        }
      } finally {
        // Await accounting before another turn can reserve. Preserve reported usage
        // on adapter errors and consumer cancellation; never invent missing usage.
        if (inputTokens + outputTokens > 0) {
          await meter.commit({ ...meterRecordOf(sessCtx, inputTokens, outputTokens, model),
            ...(quote === undefined ? {} : { costUsd: quotedModelCost(quote, inputTokens, outputTokens) }),
            ...attribution === undefined ? {} : { traceId: attribution.traceId } })
        }
      }
    })()
    return delegatingStream
  })

  ctx.effect(() => () => ready.catch(() => {}).then(() => meter.close()))
}

/**
 * 组装一次 LLM 调用的记账记录。
 *
 * **导出是为了能单独钉住「不带 `costUsd`」这一条**——它正是最容易悄悄改回去的一行：
 * 这里此前写的是 `costUsd: 0`，于是 agent 发起的调用在台账里完全没有成本。而这条改动
 * 的失败形态是**静默的**（台账照样一行行入账，只是成本列恒为 0），所以它值得一条断言，
 * 而不是靠读代码时注意到。
 *
 * 调用方（hook）只知道 token 数，不知道价格——那正是**省略**而非填 0 的理由：省略 =
 * 「请记账方按费率推」，0 = 「知道，而且就是零元」。两者在台账里是同一个数字、不同的
 * 事实，而只有前者需要有人去补费率。
 */
export function meterRecordOf(
  context: MeterContext,
  inputTokens: number,
  outputTokens: number,
  model: string,
): MeterRecord {
  return {
    context,
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    model,
    costType: 'llm',
  }
}

export default apply
