import { describe, expect, it, vi } from 'vitest'

import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import type { MeterContext } from '../../../shared/seam-contracts/metering.ts'

/**
 * 节点侧截面的**成本计价**（对真 PG）。
 *
 * 这一组存在的理由：截面此前把 `costUsd` 写死成 0，于是 **agent 发起的调用在台账里完全
 * 没有成本**——`usage_ledger.cost_usd` 恒为 0，而分析读面是 `SUM(cost_usd)`。网关侧那条
 * 路（南北向入口）自己按费率算，不受影响；受影响的是平台里真正跑 agent 的那条路，而它
 * 恰恰是主要的那条。
 *
 * 断言落在**台账里那一行**而不是函数的返回值：返回值对而写进去的是另一个数，正是这类
 * 改动最容易留下的形态。
 */
const DSN = process.env['METERING_TEST_DSN']
const dsn = () => schemaDsn(DSN!, 'metering_cost_test')

const ctx: MeterContext = {
  userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
  agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
}

/**
 * `llm_providers` 的最小形状，**手抄**自 llm-gateway 的建表语句。
 *
 * 表不是本插件的，`init()` 也不建它——但计价要读它。跨模块没法共用一份声明，所以这里
 * 有一条漂移风险；**它被测试自己兜住**：列名对不上时查询失败 → 计价返回 0 → 下面第一条
 * 用例立刻红，而不是静默地一直记 0。
 */
const providersDDL = `
CREATE TABLE IF NOT EXISTS llm_providers (
  model              TEXT PRIMARY KEY,
  upstream_base_url  TEXT NOT NULL DEFAULT '',
  api_key            TEXT NOT NULL DEFAULT '',
  price_in_per_mtok  NUMERIC(20,6) NOT NULL DEFAULT 0,
  price_out_per_mtok NUMERIC(20,6) NOT NULL DEFAULT 0,
  enabled            BOOLEAN NOT NULL DEFAULT true
)`

async function freshSeam(): Promise<PgMeteringSeam> {
  const seam = new PgMeteringSeam(await dsn())
  await seam.init()
  await seam.raw(providersDDL)
  await seam.raw(`TRUNCATE budget_trees, usage_ledger, usage_event_outbox, llm_providers`)
  // 预算树给足，免得 reserve/扣减那一侧把用例绊倒——本文件测的是成本，不是预算。
  await seam.raw(`INSERT INTO budget_trees (kind, id, budget) VALUES ('user','u1',1000000), ('project','p1',1000000)`)
  return seam
}

async function seedRate(seam: PgMeteringSeam, model: string, priceIn: number, priceOut: number): Promise<void> {
  await seam.raw(`INSERT INTO llm_providers (model, price_in_per_mtok, price_out_per_mtok) VALUES ($1,$2,$3)`,
    [model, priceIn, priceOut])
}

/** 读出这次 commit 落到 outbox 的那条成本事件。 */
async function lastEvent(seam: PgMeteringSeam): Promise<Record<string, unknown>> {
  const rows = await seam.raw<{ payload: unknown }>(
    `SELECT payload FROM usage_event_outbox LIMIT 1`)
  const row = rows[0]
  if (!row) throw new Error('outbox 里没有事件')
  // jsonb 由 pg 解析成对象（不是文本）；写成 JSON.parse 会在「对象不是 JSON 字符串」上炸。
  return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>
}

describe('截面成本计价 —— 对真 PG', () => {
  const t = DSN ? it : it.skip
  const title = (s: string) => s + (DSN ? '' : '（需 METERING_TEST_DSN → 跳过，非通过）')

  t(title('省略 costUsd 时按 llm_providers 的费率算出来，并落进台账'), async () => {
    const seam = await freshSeam()
    try {
      // 每百万 token：输入 3 美元、输出 15 美元（量级与真实模型相当）。
      await seedRate(seam, 'model-a', 3, 15)
      await seam.commit({ context: ctx, tokens: 1100, inputTokens: 1000, outputTokens: 100, model: 'model-a', costType: 'llm' })

      // (1000*3 + 100*15) / 1e6 = 4500/1e6 = 0.0045
      const event = await lastEvent(seam)
      expect(event['costUsd']).toBeCloseTo(0.0045, 9)
      expect(event['qty']).toBe(1100)

      // commit 只写**意图**（outbox），台账行由 drain 器搬入——所以这里要走完整条路，
      // 而不是只看 outbox 就算数：成本算对了但搬丢了，症状与分析读面看到的完全一样。
      await seam.drainOnce()
      const ledger = await seam.raw<{ cost_usd: string }>(`SELECT cost_usd FROM usage_ledger`)
      // 台账行是同一个数——这正是本用例要钉的：算出来是 0.0045、写进去是别的，才是真的坏。
      expect(Number(ledger[0]?.cost_usd ?? 0)).toBeCloseTo(0.0045, 9)
    } finally { await seam.close() }
  })

  t(title('显式给的 costUsd 原样保留（网关侧那条路不受影响）'), async () => {
    const seam = await freshSeam()
    try {
      // 表里故意放一个**不同**的费率：若实现把显式值丢掉改按费率算，这条立刻红。
      await seedRate(seam, 'model-b', 3, 15)
      await seam.commit({ context: ctx, tokens: 1000, model: 'model-b', costType: 'llm', costUsd: 0.99 })
      expect((await lastEvent(seam))['costUsd']).toBeCloseTo(0.99, 9)
    } finally { await seam.close() }
  })

  t(title('显式给 0 就是 0：免费模型与「没人算过价」不是一回事'), async () => {
    const seam = await freshSeam()
    try {
      await seedRate(seam, 'free-model', 0, 0)
      // 费率真的是 0 → 落 0；这与「表里没这个模型」落 0 是**同一个数字、不同的原因**，
      // 区别由下面那条 warn 承担（未知模型会抱怨，费率是 0 的不会）。
      await seam.commit({ context: ctx, tokens: 1000, model: 'free-model', costType: 'llm' })
      expect((await lastEvent(seam))['costUsd']).toBe(0)
    } finally { await seam.close() }
  })

  t(title('表里没有该模型时记 0 且不抛错，但要抱怨一次'), async () => {
    const seam = await freshSeam()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await seam.commit({ context: ctx, tokens: 1000, model: 'unknown-model', costType: 'llm' })
      expect((await lastEvent(seam))['costUsd']).toBe(0)
      // 「查不到费率」是一条需要有人去补费率的真实信号，不能静默；但也只该说一次——
      // 每次调用都刷屏会把真正的异常淹掉。
      expect(warn.mock.calls.filter(call => String(call[0]).includes('unknown-model')).length).toBe(1)
      await seam.commit({ context: ctx, tokens: 1000, model: 'unknown-model', costType: 'llm' })
      expect(warn.mock.calls.filter(call => String(call[0]).includes('unknown-model')).length).toBe(1)
    } finally {
      warn.mockRestore()
      await seam.close()
    }
  })

  t(title('只知道总数、不知道拆分时按两价中较高者计（保守方向）'), async () => {
    const seam = await freshSeam()
    try {
      await seedRate(seam, 'model-c', 3, 15)
      // 只给 tokens：全部按 15 计 = 1000*15/1e6 = 0.015。
      // 这不是「更准」，而是**方向选择**：低估会让金额上限晚响（超支已经发生），高估只是
      // 让账更保守，而金额上限是这个数唯一的执法用途。真正的修法是调用方把输入输出分开。
      await seam.commit({ context: ctx, tokens: 1000, model: 'model-c', costType: 'llm' })
      expect((await lastEvent(seam))['costUsd']).toBeCloseTo(0.015, 9)
    } finally { await seam.close() }
  })
})

/**
 * hook 组装出来的那条记录**不带 `costUsd`**——这是「成本恒为 0」那个缺陷的正面钉子。
 *
 * 纯函数、不需要库，所以恒跑。它值得单独存在，是因为这行代码的失败形态是**静默的**：
 * 填 0 之后台账照样一行行入账，只是成本列恒为 0，而没有任何报错会指向这里。
 */
describe('meterRecordOf', () => {
  it('省略 costUsd（不是填 0），并把输入输出分开带上', async () => {
    const { meterRecordOf } = await import('../src/index.ts')
    const record = meterRecordOf(ctx, 1000, 100, 'model-x')
    expect(record).toEqual({
      context: ctx, tokens: 1100, inputTokens: 1000, outputTokens: 100,
      model: 'model-x', costType: 'llm',
    })
    // **必须是不存在，而不是等于 0**：`costUsd: 0` 会被记账方当成「免费调用」照收，
    // 于是「没人算过价」与「价格真的是零」在台账里变成同一个数字。
    expect('costUsd' in record).toBe(false)
  })
})
