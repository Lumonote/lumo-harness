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
}

/** 依赖注入：llm 服务须先 mount（计量挂在 llm/stream 瀑布） */
export const inject = ['llm']

export function apply(ctx: Context, config: MeteringConfig): void {
  const meter = new PgMeteringSeam(config.connectionString)
  void meter.init().then(async () => {
    // 默认预算种子：幂等 upsert（仅当未显式配置 budget_trees 行时生效，§6.4 预算树）
    await meter.setBudget('user', config.userId, config.defaultBudget)
    await meter.setBudget('project', config.projectId, config.defaultBudget)
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
