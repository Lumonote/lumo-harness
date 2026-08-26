import { describe, expect, it } from 'vitest'

import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import type { MeterContext } from '../../../shared/seam-contracts/metering.ts'

/**
 * PG 预算总额模型（设计说明 `2026-08-26-budget-total-model-design.md`）。
 *
 * 两种模式两种边界，用 `budget_total` 是否为 NULL 显式区分：
 * - 旧模式（NULL）：只认剩余，仅 within/hard，`remaining === need` 仍放行（既有行为）；
 * - 总额模式：四态、左闭右开，`used = (total − remaining) + need`。
 *
 * 「旧模式边界不变」与本文件同生：若实现把两态也改成左闭，下面第一条即红——那个
 * 渗透是「默认行为不变」承诺最常见的破法。
 */
const DSN = process.env['METERING_TEST_DSN']
const dsn = () => schemaDsn(DSN!, 'metering_budget_test')

const ctx: MeterContext = {
  userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
  agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
}

async function freshSeam(): Promise<PgMeteringSeam> {
  const seam = new PgMeteringSeam(await dsn())
  await seam.init()
  await seam.raw(`TRUNCATE budget_trees, usage_ledger, usage_event_outbox`)
  return seam
}

/** 直插**旧模式**行（budget_total 缺省 NULL）。reserve 走两态路径。 */
async function seedLegacy(
  seam: PgMeteringSeam,
  kind: 'user' | 'project', id: string, remaining: number,
): Promise<void> {
  await seam.raw(
    `INSERT INTO budget_trees (kind, id, budget) VALUES ($1,$2,$3)
     ON CONFLICT (kind, id) DO UPDATE SET budget = EXCLUDED.budget`,
    [kind, id, remaining],
  )
}

describe('预算总额模型 —— 对真 PG', () => {
  const t = DSN ? it : it.skip
  const title = (s: string) => s + (DSN ? '' : '（需 METERING_TEST_DSN → 跳过，非通过）')

  t(title('旧模式行（budget_total NULL）行为与今天一致，边界未被左闭渗透'), async () => {
    const seam = await freshSeam()
    try {
      await seedLegacy(seam, 'user', 'u1', 1)
      await seedLegacy(seam, 'project', 'p1', 1000)
      // 旧边界：remaining === need 仍放行（新模式的左闭在这里是 hard——若渗透即红）
      const exact = await seam.reserve(ctx)
      expect(exact.approved).toBe(true)
      expect(exact.state).toBe('within')

      const over = await seam.reserve(ctx, 100)
      expect(over.approved).toBe(false)
      expect(over.state).toBe('hard')
    } finally {
      await seam.close()
    }
  })

  t(title('总额模式四态齐全，边界精确（左闭：=softLimit→soft、=total→overdraft、=total+od→hard）'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setBudget('user', 'u1', 1000, { softLimit: 800, overdraft: 200 })
      await seam.setBudget('project', 'p1', 10000)
      // commit 799 → remaining 201；reserve(need=1) → used=800 == softLimit
      await seam.commit({ context: ctx, tokens: 799, model: 'deepseek', costType: 'llm', costUsd: 0.8 })
      const soft = await seam.reserve(ctx, 1)
      expect(soft.state).toBe('soft')
      expect(soft.approved).toBe(true)

      // commit 200 → remaining 1；used=1000 == total
      await seam.commit({ context: ctx, tokens: 200, model: 'deepseek', costType: 'llm', costUsd: 0.2 })
      const over = await seam.reserve(ctx, 1)
      expect(over.state).toBe('overdraft')
      expect(over.approved).toBe(true)

      // commit 200 → remaining −199；used=1200 == total + overdraft
      await seam.commit({ context: ctx, tokens: 200, model: 'deepseek', costType: 'llm', costUsd: 0.2 })
      const hard = await seam.reserve(ctx, 1)
      expect(hard.state).toBe('hard')
      expect(hard.approved).toBe(false)
    } finally {
      await seam.close()
    }
  })

  t(title('setBudget 期初重配：remaining 重置为 total；opts 更新限额、不给则保留存储值'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setBudget('user', 'u1', 1000, { softLimit: 800, overdraft: 200 })
      await seam.commit({ context: ctx, tokens: 300, model: 'deepseek', costType: 'llm', costUsd: 0.3 })
      expect(await seam.balance({ kind: 'user', id: 'u1' })).toBe(700)

      // 不给 opts：只重配总额，保留已存的 800/200
      await seam.setBudget('user', 'u1', 1000)
      expect(await seam.balance({ kind: 'user', id: 'u1' })).toBe(1000)
      const stored = await seam.raw<{ soft_limit: number; overdraft: number }>(
        `SELECT soft_limit, overdraft FROM budget_trees WHERE kind='user' AND id='u1'`,
      )
      expect(Number(stored[0]!.soft_limit)).toBe(800)
      expect(Number(stored[0]!.overdraft)).toBe(200)

      // 给 opts：对应列被替换；给一部分则另一列保留
      await seam.setBudget('user', 'u1', 1500, { softLimit: 900 })
      const updated = await seam.raw<{ soft_limit: number; overdraft: number }>(
        `SELECT soft_limit, overdraft FROM budget_trees WHERE kind='user' AND id='u1'`,
      )
      expect(Number(updated[0]!.soft_limit)).toBe(900)
      expect(Number(updated[0]!.overdraft)).toBe(200)
    } finally {
      await seam.close()
    }
  })

  t(title('adjustBudget 总额平移：used 不变，降额不追溯、提额不抹零'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setBudget('user', 'u1', 1000, { softLimit: 800, overdraft: 200 })
      await seam.setBudget('project', 'p1', 10000)
      await seam.commit({ context: ctx, tokens: 900, model: 'deepseek', costType: 'llm', costUsd: 0.9 })
      expect(await seam.balance({ kind: 'user', id: 'u1' })).toBe(100)
      // used = (1000 − 100) + need(1) = 901 → 落在 [800, 1000) → soft，放行
      expect((await seam.reserve(ctx)).state).toBe('soft')

      // 降额到 500：Δ=−500 → remaining 100−500=−400；used 仍 = 900（不追溯）。
      // 软限额必须一并下调（800 > 500 在配置处 fail closed，见「配置写入即校验」用例）
      await seam.adjustBudget('user', 'u1', 500, { softLimit: 400 })
      expect(await seam.balance({ kind: 'user', id: 'u1' })).toBe(-400)
      // used = (500 − (−400)) + 1 = 901 ≥ 500 + 200 → hard，且立即拒绝
      expect(await seam.reserve(ctx)).toMatchObject({ approved: false, state: 'hard' })

      // 提额到 2000：Δ=+1500 → remaining 1100；used 仍 = 900（不抹零）
      await seam.adjustBudget('user', 'u1', 2000, { softLimit: 1800 })
      expect(await seam.balance({ kind: 'user', id: 'u1' })).toBe(1100)
      // used = (2000 − 1100) + 1 = 901 < 1800 → within；若提额把 used 抹成 0 会假放行
      expect(await seam.reserve(ctx)).toMatchObject({ approved: true, state: 'within' })
    } finally {
      await seam.close()
    }
  })

  t(title('adjustBudget 拒收旧模式行与不存在的树——修复指引在错误里'), async () => {
    const seam = await freshSeam()
    try {
      await seedLegacy(seam, 'user', 'u1', 500)
      await expect(seam.adjustBudget('user', 'u1', 1000)).rejects.toThrow(/setBudget/)
      await expect(seam.adjustBudget('project', 'p1', 1000)).rejects.toThrow(/setBudget|不存在/)
    } finally {
      await seam.close()
    }
  })

  t(title('配置写入即校验：负值/NaN/softLimit>total 拒绝，不让它延迟成 reserve 抛错'), async () => {
    const seam = await freshSeam()
    try {
      await expect(seam.setBudget('user', 'u1', -1)).rejects.toThrow()
      await expect(seam.setBudget('user', 'u1', Number.NaN)).rejects.toThrow()
      await expect(seam.setBudget('user', 'u1', 100, { softLimit: 101 })).rejects.toThrow(/softLimit/)
      await seam.setBudget('user', 'u1', 1000, { softLimit: 800 })
      // 存量 softLimit=800 在降额到 500 时不匹配 → 配置处拒绝
      await expect(seam.adjustBudget('user', 'u1', 500)).rejects.toThrow(/softLimit/)
    } finally {
      await seam.close()
    }
  })

  t(title('DDL：三列存在且 init 幂等（既有库上 ALTER 是常态）'), async () => {
    const seam = await freshSeam()
    try {
      await seam.init()
      // 列存在即可——若只改了 CREATE 而既有库走 ALTER 失败，这里要么报错要么列缺失
      await seam.raw(`SELECT budget_total, soft_limit, overdraft FROM budget_trees LIMIT 0`)
    } finally {
      await seam.close()
    }
  })

  t(title('seedDefaultBudget 只在无行时插入旧模式行（装配层种子不覆盖运维配置）'), async () => {
    const seam = await freshSeam()
    try {
      // 无行 → 种子行：budget_total NULL（旧模式），remaining = defaultBudget
      await seam.seedDefaultBudget('user', 'u1', 1_000_000_000)
      let row = await seam.raw<{ budget_total: number | null; budget: number }>(
        `SELECT budget_total, budget FROM budget_trees WHERE kind='user' AND id='u1'`,
      )
      expect(row).toHaveLength(1)
      expect(row[0]!.budget_total).toBeNull()
      expect(Number(row[0]!.budget)).toBe(1_000_000_000)

      // 已配置为总额模式 → 种子不得触碰
      await seam.setBudget('user', 'u1', 1000, { softLimit: 800, overdraft: 200 })
      await seam.commit({ context: ctx, tokens: 300, model: 'deepseek', costType: 'llm', costUsd: 0.3 })
      await seam.seedDefaultBudget('user', 'u1', 1_000_000_000)
      row = await seam.raw<{ budget_total: number | null; budget: number }>(
        `SELECT budget_total, budget FROM budget_trees WHERE kind='user' AND id='u1'`,
      )
      expect(Number(row[0]!.budget_total)).toBe(1000)   // 不被冲回 1e9
      expect(Number(row[0]!.budget)).toBe(700)          // remaining 不动
    } finally {
      await seam.close()
    }
  })
})
