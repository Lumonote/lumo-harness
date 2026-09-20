import { describe, expect, it } from 'vitest'

import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import { SCOPE_GOVERNED_RUN, type MeterContext } from '../../../shared/seam-contracts/metering.ts'

/**
 * 作用域金额上限（一次工作的封顶，对真 PG）。
 *
 * 它**刻意不复用 `budget_trees`**：那张表的 `budget` 列是 **token**，而上限是**钱**。
 * 本文件既测行为，也测那个区分——第三条用例专门钉住「扣的是分不是 token」，因为把两者
 * 混起来的失败形态是**静默的**（数字照样在动，只是动错了量级）。
 */
const DSN = process.env['METERING_TEST_DSN']
const dsn = () => schemaDsn(DSN!, 'metering_scope_cap_test')

const ctx: MeterContext = {
  userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
  agentId: 'a1', componentId: 'c1', feature: 'governed', sessionRef: 'run-1',
}

const providersDDL = `
CREATE TABLE IF NOT EXISTS llm_providers (
  model TEXT PRIMARY KEY, upstream_base_url TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '',
  price_in_per_mtok NUMERIC(20,6) NOT NULL DEFAULT 0, price_out_per_mtok NUMERIC(20,6) NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true
)`

async function freshSeam(): Promise<PgMeteringSeam> {
  const seam = new PgMeteringSeam(await dsn())
  await seam.init()
  await seam.raw(providersDDL)
  await seam.raw(`TRUNCATE budget_trees, usage_ledger, usage_event_outbox, llm_providers, budget_scope_caps`)
  await seam.raw(`INSERT INTO budget_trees (kind, id, budget) VALUES ('user','u1',100000000), ('project','p1',100000000)`)
  // 每百万 token 100 美元 = 10000 分，于是 1000 token 恰好 0.1 美元 = 10 分，便于断言。
  await seam.raw(`INSERT INTO llm_providers (model, price_in_per_mtok, price_out_per_mtok) VALUES ('m', 100, 100)`)
  return seam
}

describe('作用域金额上限 —— 对真 PG', () => {
  const t = DSN ? it : it.skip
  const title = (s: string) => s + (DSN ? '' : '（需 METERING_TEST_DSN → 跳过，非通过）')

  t(title('没设过上限就不拦：不限额不是「上限 0」'), async () => {
    const seam = await freshSeam()
    try {
      // 这是本机制最容易写错的一处：把「查不到行」当成「额度是 0」会把**每一条没设过
      // 上限的执行**全部拒掉，而症状是「受治理执行一启动就报预算不足」——看起来像额度
      // 用完了，实际是这条路径根本不认识「没设过」与「设成零」的区别。
      const res = await seam.reserve(ctx)
      expect(res.approved).toBe(true)
      expect(await seam.spentCents(SCOPE_GOVERNED_RUN, 'run-1')).toBeUndefined()
    } finally { await seam.close() }
  })

  t(title('扣减按**分**计：1000 token × 100 美元/百万 = 10 分'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 1000)
      await seam.commit({ context: ctx, tokens: 1000, inputTokens: 1000, outputTokens: 0, model: 'm', costType: 'llm' })
      // 若实现误把 token 当分扣，这里会是 1000 而不是 10——而 reserve 会因为「已花 1000
      // ≥ 上限 1000」立刻开始拦，表现为「上限动不动就被顶满」，且量级差 100 倍。
      expect(await seam.spentCents(SCOPE_GOVERNED_RUN, 'run-1')).toBeCloseTo(10, 6)
    } finally { await seam.close() }
  })

  t(title('花超之后被拦，拒因与另外两项预算分开'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 5)   // 上限 5 分
      await seam.commit({ context: ctx, tokens: 1000, inputTokens: 1000, outputTokens: 0, model: 'm', costType: 'llm' }) // 花 10 分
      const res = await seam.reserve(ctx)
      expect(res.approved).toBe(false)
      // 拒因必须与 denied-user-budget / denied-project-budget 分得开：撞上这一条通常意味着
      // 「这次活干不完」，而不是「去找管理员充值」。
      expect(res.reason).toBe('denied-scope-budget')
      // 与 approved 自洽（契约里的不变式是 approved ⟺ state !== 'hard'）。
      expect(res.state).toBe('hard')
    } finally { await seam.close() }
  })

  t(title('判据是「已经花超」：允许一次越界，之后每次都拦'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 5)
      // 第一次调用时已花是 0 < 5 → 放行（它自己就把上限顶穿了）。
      expect((await seam.reserve(ctx)).approved).toBe(true)
      await seam.commit({ context: ctx, tokens: 1000, inputTokens: 1000, outputTokens: 0, model: 'm', costType: 'llm' })
      // 之后每次都拦。这一次越界是**拿不到预估时的诚实做法**：预计量是 token、上限是钱，
      // 这条路径上没法换算，编一个换算率反而会让上限看起来在精确执法。
      expect((await seam.reserve(ctx)).approved).toBe(false)
    } finally { await seam.close() }
  })

  t(title('上限只管自己的作用域 id：别的会话不受影响'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 5)
      await seam.commit({ context: ctx, tokens: 1000, inputTokens: 1000, outputTokens: 0, model: 'm', costType: 'llm' })
      const other = { ...ctx, sessionRef: 'run-2' }
      expect((await seam.reserve(other)).approved).toBe(true)
      // 而且别的会话的花费**不会**记到 run-1 的账上——记错了会让一个正常执行的额度被
      // 邻居吃掉，排查时看不出任何联系。
      expect(await seam.spentCents(SCOPE_GOVERNED_RUN, 'run-2')).toBeUndefined()
      expect(await seam.spentCents(SCOPE_GOVERNED_RUN, 'run-1')).toBeCloseTo(10, 6)
    } finally { await seam.close() }
  })

  t(title('重设上限会把已花清零；撤销后不再拦'), async () => {
    const seam = await freshSeam()
    try {
      await seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 5)
      await seam.commit({ context: ctx, tokens: 1000, inputTokens: 1000, outputTokens: 0, model: 'm', costType: 'llm' })
      expect((await seam.reserve(ctx)).approved).toBe(false)

      // 重设 = 「这次工作的额度」。不清零会得到一个很隐蔽的形态：重跑一次同样的执行，
      // 上限还没开始就被上一轮的账顶满了。
      await seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 1000)
      expect(await seam.spentCents(SCOPE_GOVERNED_RUN, 'run-1')).toBe(0)
      expect((await seam.reserve(ctx)).approved).toBe(true)

      await seam.clearCap(SCOPE_GOVERNED_RUN, 'run-1')
      expect(await seam.spentCents(SCOPE_GOVERNED_RUN, 'run-1')).toBeUndefined()
      expect((await seam.reserve(ctx)).approved).toBe(true)
    } finally { await seam.close() }
  })

  t(title('非法的上限值当场拒绝（负数、非整数）'), async () => {
    const seam = await freshSeam()
    try {
      await expect(seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', -1)).rejects.toThrow(RangeError)
      await expect(seam.setCap(SCOPE_GOVERNED_RUN, 'run-1', 1.5)).rejects.toThrow(RangeError)
    } finally { await seam.close() }
  })
})
