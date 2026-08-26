import { describe, expect, it } from 'vitest'

import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import { assertCostEventDrainContract } from '../../../shared/seam-contracts/metering.ts'
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

describe(`drainOnce 批量入账 —— 对真 PG（需 METERING_TEST_DSN，当前${suffix}）`, () => {
  t('共享契约 D1/D2 —— 管线形态与重放幂等，对真 PG 跑', async () => {
    await withSeam(async (seam) => {
      const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
      await assertCostEventDrainContract(
        {
          sink: seam,
          drainOnce: () => seam.drainOnce(),
          ledgerRows: () => count(seam, 'usage_ledger'),
          redeliverAll: () => seam.raw(`UPDATE usage_event_outbox SET projected_at = NULL`),
        },
        [eventOf('job.compute'), eventOf('seam.query')],
        assert,
      )
    })
  })

  t('空批 drainOnce 返回 0；已投影行不回收（部分索引只扫未投影尾）', async () => {
    await withSeam(async (seam) => {
      expect(await seam.drainOnce()).toBe(0)
      await seam.emit(eventOf('job.compute'))
      await seam.drainOnce()
      expect(await count(seam, 'usage_event_outbox')).toBe(1)
    })
  })

  t('批量上限生效——drainOnce(n) 至多搬 n 条', async () => {
    await withSeam(async (seam) => {
      for (let i = 0; i < 5; i++) await seam.emit(eventOf('job.compute', { qty: i }))

      expect(await seam.drainOnce(2)).toBe(2)
      expect(await count(seam, 'usage_ledger')).toBe(2)
      expect(await seam.drainOnce(10)).toBe(3)
      expect(await count(seam, 'usage_ledger')).toBe(5)
      expect(await seam.drainOnce(10)).toBe(0)
    })
  })

  t('事件时刻保真——ledger.ts = outbox.ts（事件时刻），非投影时刻', async () => {
    await withSeam(async (seam) => {
      await seam.emit(eventOf('job.compute'))
      // 事件发生在 23:59:58、投影在 00:00:02：账单周期门按事件时刻判——
      // 若搬运把 now() 写进账，跨期消费会被划进下一周期
      await seam.raw(
        `UPDATE usage_event_outbox SET ts = '2026-01-06 23:59:58+00'`,
      )
      await seam.drainOnce()
      const [row] = await seam.raw<{ eq: boolean }>(
        `SELECT ts = '2026-01-06 23:59:58+00'::timestamptz AS eq FROM usage_ledger`,
      )
      expect(row!.eq).toBe(true)
    })
  })

  t('顺序稳定——同一时刻的两事件按 seq 破平，(ts,id) 顺着插入序', async () => {
    await withSeam(async (seam) => {
      await seam.emit(eventOf('seam.query', { qty: 500, traceId: 'tr-ord' }))
      await seam.emit(eventOf('llm.tokens', { qty: 900, traceId: 'tr-ord' }))
      // 两事件同刻：若搬运乱序，(ts, id) 破平会归到错误的一方
      await seam.raw(`UPDATE usage_event_outbox SET ts = '2026-01-06 12:00:00+00'`)
      await seam.drainOnce()

      const got = await seam.byTrace('tr-ord')
      expect(got.map((e) => e.costType)).toEqual(['seam.query', 'llm.tokens'])
    })
  })

})
