import { describe, expect, it } from 'vitest'

import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import { unitFor, type CostEvent, type CostType } from '../../../shared/seam-contracts/cost-events.ts'
import type { MeterContext } from '../../../shared/seam-contracts/metering.ts'

/**
 * usage_event_outbox（设计说明 2026-08-26）对真 PG 的写入口与搬运属性测试。
 *
 * 与 sink.spec 的分工：sink.spec 断言「台账里列存了啥」；这里断言「事件怎么进的管线」
 * ——透写断开、重放幂等、事件时刻保真、搬运输序、批量上限。这些属性随后要进共享契约
 * （assertCostEventDrainContract），将来 RocketMQ 消费侧也跑同一套。
 *
 * 无 DSN 时 skip 且 skip 可见：静默 return 会让报告显示「通过」。
 */
const DSN = process.env['METERING_TEST_DSN']
const t = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'

const ctx: MeterContext = {
  userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
  agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
}

/** 构造一个该类型下合法的事件（`llm.tokens` 额外要求 tokens/model）。 */
function eventOf(costType: CostType, over: Partial<CostEvent> = {}): CostEvent {
  const qty = over.qty ?? 12
  const base: CostEvent = {
    context: ctx,
    costType,
    qty,
    unit: unitFor(costType),
    traceId: 'tr-outbox',
    emitter: `emitter:${costType}`,
    costUsd: 0.5,
    ...over,
  }
  if (costType === 'llm.tokens') {
    base.tokens = base.qty
    base.model = base.model ?? 'deepseek'
  }
  return base
}

/** 本文件专属 schema，TRUNCATE 三表（与 sink/pg-budget 隔离，理由见 pg-schema.ts 注释）。 */
async function withSeam(fn: (seam: PgMeteringSeam) => Promise<void>): Promise<void> {
  const seam = new PgMeteringSeam(await schemaDsn(DSN!, 'metering_outbox_test'))
  try {
    await seam.init()
    await seam.raw(`TRUNCATE usage_ledger, budget_trees, usage_event_outbox`)
    await fn(seam)
  } finally {
    await seam.close()
  }
}

async function count(seam: PgMeteringSeam, table: string): Promise<number> {
  const [row] = await seam.raw<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
  return Number(row!.n)
}

describe(`事件先入 usage_event_outbox —— 对真 PG（需 METERING_TEST_DSN，当前${suffix}）`, () => {
  t('commit/emit 不再直写台账——仅事件入 outbox，扣减预算照旧', async () => {
    await withSeam(async (seam) => {
      await seam.setBudget('user', 'u1', 10_000)
      await seam.setBudget('project', 'p1', 10_000)
      await seam.commit({
        context: ctx, tokens: 700, model: 'deepseek', costType: 'llm', costUsd: 0.7,
      })

      // 判据 1：写穿即见已是旧语义——返回时行在 outbox，不在台账
      expect(await count(seam, 'usage_ledger')).toBe(0)
      expect(await count(seam, 'usage_event_outbox')).toBe(1)
      // 事件内容完整进 payload（成本类型是 outbox 里的样子，不是调用方的自由文本 'llm'）
      const [row] = await seam.raw<{ payload: CostEvent }>(
        `SELECT payload FROM usage_event_outbox WHERE seq = (SELECT max(seq) FROM usage_event_outbox)`,
      )
      expect(row!.payload.costType).toBe('llm.tokens')
      expect(row!.payload.qty).toBe(700)
      // 预算扣减仍在请求路径（事件与扣减同事务，见设计说明 §3 不变式④）
      expect(await seam.balance({ kind: 'user', id: 'u1' })).toBe(10_000 - 700)

      await seam.emit(eventOf('job.compute'))
      expect(await count(seam, 'usage_ledger')).toBe(0)
      expect(await count(seam, 'usage_event_outbox')).toBe(2)
    })
  })

  t('坏事件既不入台账也不入 outbox——outbox 不是绕过校验的通道', async () => {
    await withSeam(async (seam) => {
      const bad = { ...eventOf('job.compute'), costType: 'made.up' as CostType }
      await expect(seam.emit(bad)).rejects.toThrow(/made\.up/)

      expect(await count(seam, 'usage_ledger')).toBe(0)
      expect(await count(seam, 'usage_event_outbox')).toBe(0)
    })
  })
})
