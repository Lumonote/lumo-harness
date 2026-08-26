/**
 * @lumo/metering —— 计量单截面插件（§6.4 + 评审 N3 并行预算树）。
 *
 * 挂接点：llm/stream 瀑布（必须 next()，观察流并累计 usage）；
 * 归因：user/dept/role/project 由装配层配置（agent/request baggage 注入为 P2）；
 * 预算：PG 双树（user/project），reserve 前置拦截；明细入 usage_ledger。
 *
 * 采用 dsh 原生 ctx.tokenMeter（TokenUsageProjection 口径）作为 token 核算底座，
 * 本插件负责「归因 + 预算 + 台账」，不重复实现 token 估算。
 */
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import { Context } from '@deepseek-ai/cordis'

import { PgMeteringSeam } from './pg-meter.ts'

export interface MeteringConfig {
  connectionString: string
  /** 归因上下文（单节点装配层注入；P2 后改从 agent/request baggage 派生） */
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

  const drainIntervalMs = Math.max(config.drainIntervalMs ?? 1000, 100)
  const drainBatchSize = config.drainBatchSize ?? 100

  // 计量事件从请求路径拿掉后的后台搬运（设计说明 2026-08-26 §5）：
  // outbox → usage_ledger 轮询。失败只 warn 不抛——outbox 未标记 projected_at，
  // 下一轮自然重放（同 knowledge 投影器）。unref 不阻塞进程退出。
  ctx.effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false
    // 幂等初始化（建表/迁移）；失败即加载失败（响亮失败，§15）。
    // 种子与轮询必须等建表完成再起，否则前几轮全是「表不存在」噪音。
    void meter.init().then(async () => {
      // 默认预算种子：**仅当无行时插入**（§6.4 预算树）。
      // 此处曾调用 setBudget——那是一年期初重配语义（remaining=total），每次插件重启都会
      // 把运维配置的总额/硬停冲回 defaultBudget（1e9）；且哪怕旧语义也覆盖了运维在
      // budget_trees 上的显式配置（注释写「仅当未显式配置时生效」，实现却是无条件 upsert，
      // 注释与实现不符）。seedDefaultBudget 用 DO NOTHING + 旧模式行，两者都对齐。
      await meter.seedDefaultBudget('user', config.userId, config.defaultBudget)
      await meter.seedDefaultBudget('project', config.projectId, config.defaultBudget)
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
    const stream = next()
    const sessionRef = (options as { session?: { id?: string } }).session?.id ?? 'system'
    const sessCtx = { ...context, sessionRef }
    let tokens = 0
    let model = (options as { model?: string }).model ?? 'unknown'
    const delegatingStream = (async function* () {
      // 前置拦截：首 token 发出前预检双树预算（§6.4 限流前置语义）
      const approval = await meter.reserve(sessCtx)
      if (!approval.approved) {
        throw new Error(`metering: 预算拒绝 —— ${approval.reason}（feature=${config.feature}）`)
      }
      for await (const chunk of stream) {
        const usage = (chunk as { usage?: Record<string, unknown> }).usage
        if (usage) {
          const u = usage as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
          tokens = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.output_tokens ?? u.completion_tokens ?? 0)
        }
        yield chunk
      }
      // 流结束：扣账（明细 + 双树扣减）
      if (tokens > 0) {
        void meter.commit({
          context: sessCtx, tokens, model, costType: 'llm', costUsd: 0,
        })
      }
    })()
    return delegatingStream
  })

  // 由 control/计量核算单元完成实际记扣（token-meter 的 tokenUsage 口径），此处残余项留 P2
  ctx.effect(() => () => {
    void meter.close()
  })
}

export default apply
