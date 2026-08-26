import { describe, expect, it } from 'vitest'

import { PgMeteringSeam } from '../src/pg-meter.ts'
import { schemaDsn } from './pg-schema.ts'
import { unitFor, type CostEvent, type CostType } from '../../../shared/seam-contracts/cost-events.ts'
import type { MeterContext } from '../../../shared/seam-contracts/metering.ts'

/**
 * CostEventSink 对**真 PG** 跑。
 *
 * 这些断言全是关于「列里到底存了什么」的：`tokens` 列有没有被非 token 类型写脏、
 * `qty`/`unit` 有没有真的落盘、未知类型有没有在写之前就被拦住。用 stub 验证不了
 * 任何一条 —— stub 里没有列。这与 `pg-contract.spec.ts` 是同一个理由。
 *
 * 无 DSN 时 skip 且 **skip 可见**：静默 return 会让报告显示「通过」。
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
    traceId: 'tr-sink',
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

/**
 * 每个用例独占一个 seam，跑完即关；表用 TRUNCATE 清而不 DROP（并行用例还要用表）。
 *
 * 走本文件专属的 schema：与 `pg-contract.spec.ts` 共用一个 schema 时，两边的
 * TRUNCATE 会互相抹掉对方跑到一半的数据，红的原因与被测代码无关。
 */
async function withSeam(fn: (seam: PgMeteringSeam) => Promise<void>): Promise<void> {
  const seam = new PgMeteringSeam(await schemaDsn(DSN!, 'metering_sink_test'))
  try {
    await seam.init()
    await seam.raw(`TRUNCATE usage_ledger, budget_trees, usage_event_outbox`)
    await fn(seam)
  } finally {
    await seam.close()
  }
}

/** 写穿即见已是有界最终一致（设计说明 2026-08-26 §4）：台账由 drainOnce 搬入。 */
async function drained(seam: PgMeteringSeam): Promise<void> {
  await seam.drainOnce()
}

interface Row {
  cost_type: string; qty: string | null; unit: string | null
  tokens: number | null; model: string | null
  trace_id: string | null; emitter: string | null
  user_id: string; dept_id: string; role: string; project_id: string
  agent_id: string; component_id: string; feature: string; session_ref: string
  cost_usd: string
}

const ALL_TYPES: CostType[] = [
  'llm.tokens', 'connector.call', 'seam.query',
  'job.compute', 'storage.bytes', 'inference.gpu',
]

/**
 * 断言夹具的插入序**不等于**任何单列排序的结果。
 *
 * 顺序测试只有在「插入序是一个别的排序都产生不出来的序」时才有鉴别力。否则一个
 * `ORDER BY 错列` 的实现会恰好回吐正确答案，测试全绿而 bug 在线上。
 *
 * 做成断言而不是注释，是因为这个坑已经踩了两次：第一次 qty 严格递减（= qty DESC），
 * 第二次 cost_type 排成了字典序（= cost_type ASC）。两次的注释都声称覆盖了。夹具的
 * 性质必须由机器验，人读注释验不出来——夹具一改，注释不会跟着报警。
 *
 * 抓不住的仍然是「完全没有 ORDER BY」：小表顺序扫描通常恰好回吐插入序，不假装覆盖。
 */
function assertNoSingleColumnOrderMatches(rows: Array<[CostType, number]>): void {
  const asInserted = JSON.stringify(rows)
  const keys: Array<[string, (r: [CostType, number]) => string | number]> = [
    ['cost_type', (r) => r[0]],
    ['qty', (r) => r[1]],
    // emitter 是 `emitter:${costType}`，与 cost_type 同序，故不单列
  ]
  for (const [name, key] of keys) {
    for (const dir of ['ASC', 'DESC'] as const) {
      const sorted = [...rows].sort((a, b) => {
        const [x, y] = [key(a), key(b)]
        const c = x < y ? -1 : x > y ? 1 : 0
        return dir === 'ASC' ? c : -c
      })
      if (JSON.stringify(sorted) === asInserted) {
        throw new Error(
          `夹具无鉴别力：插入序恰好等于 ORDER BY ${name} ${dir}，` +
          `「按 ${name} 排」的实现会蒙对。请换 qty / cost_type 的组合。`,
        )
      }
    }
  }
}

describe(`CostEventSink 落库 —— 对真 PG（需 METERING_TEST_DSN，当前${suffix}）`, () => {
  t('六类事件各落一行，归因字段完整', async () => {
    await withSeam(async (seam) => {
      for (const type of ALL_TYPES) await seam.emit(eventOf(type))
      await drained(seam)

      const rows = await seam.raw<Row>(`SELECT * FROM usage_ledger ORDER BY id ASC`)
      expect(rows.map((r) => r.cost_type)).toEqual(ALL_TYPES)

      for (const r of rows) {
        // 归因链：缺任一维度，「这笔钱是谁花的」就只能靠时间戳猜
        expect(r.user_id, r.cost_type).toBe('u1')
        expect(r.dept_id, r.cost_type).toBe('d1')
        expect(r.role, r.cost_type).toBe('viewer')
        expect(r.project_id, r.cost_type).toBe('p1')
        expect(r.agent_id, r.cost_type).toBe('a1')
        expect(r.component_id, r.cost_type).toBe('c1')
        expect(r.feature, r.cost_type).toBe('kb:qa')
        expect(r.session_ref, r.cost_type).toBe('s1')
        expect(r.trace_id, r.cost_type).toBe('tr-sink')
        expect(r.emitter, r.cost_type).toBe(`emitter:${r.cost_type}`)
        // qty/unit 必须真的落盘：这两列是「非 token 成本」的唯一量纲载体
        expect(Number(r.qty), r.cost_type).toBe(12)
        expect(r.unit, r.cost_type).toBe(unitFor(r.cost_type as CostType))
        expect(Number(r.cost_usd), r.cost_type).toBe(0.5)
      }
    })
  })

  t('llm.tokens 仍写 tokens 列 —— 既有 SUM(tokens) 报表不能被本项改动破坏', async () => {
    await withSeam(async (seam) => {
      await seam.emit(eventOf('llm.tokens', { qty: 600 }))
      await drained(seam)
      const [row] = await seam.raw<Row>(`SELECT * FROM usage_ledger`)
      expect(row!.tokens).toBe(600)
      expect(row!.model).toBe('deepseek')
      expect(Number(row!.qty)).toBe(600)
    })
  })

  t('非 llm.tokens 的 tokens 列为 0 而非 NULL —— NULL 会让 SUM(tokens) 静默变 NULL', async () => {
    await withSeam(async (seam) => {
      await seam.emit(eventOf('llm.tokens', { qty: 600 }))
      await seam.emit(eventOf('job.compute', { qty: 30 }))
      await seam.emit(eventOf('storage.bytes', { qty: 1024 }))
      await drained(seam)

      const rows = await seam.raw<Row>(
        `SELECT * FROM usage_ledger WHERE cost_type <> 'llm.tokens'`,
      )
      expect(rows).toHaveLength(2)
      for (const r of rows) {
        expect(r.tokens, r.cost_type).toBe(0)
        expect(r.model, r.cost_type).toBeNull()
      }

      // 关键回归：混入非 token 成本后，token 报表读到的数不变
      const [sum] = await seam.raw<{ total: string | null }>(
        `SELECT SUM(tokens)::text AS total FROM usage_ledger`,
      )
      expect(sum!.total).toBe('600')
    })
  })

  t('同 traceId 可按 trace 取回，顺序稳定', async () => {
    await withSeam(async (seam) => {
      // 插入序刻意与「任何单列排序」都不同，这样「按错列排」的实现会被抓住。
      //
      // 夹具的这个性质由下面的 assertNoSingleColumnOrderMatches 断言，**不靠注释**。
      // 原先那版正是注释与数据不符：注释说 qty 递减能抓住按 qty 排，而严格递减的
      // 插入序与 `ORDER BY qty DESC` 恰好完全一致，换了排序列测试照样通过。修的时候
      // 又把 cost_type 顺手排成了字典序，于是 `ORDER BY cost_type` 接着漏。两次都是
      // 同一个形状：人读注释以为覆盖了，数据却没有。所以改成让测试自己算。
      const chain: Array<[CostType, number]> = [
        ['seam.query', 500],
        ['connector.call', 900],
        ['llm.tokens', 100],
      ]
      assertNoSingleColumnOrderMatches(chain)

      for (const [type, qty] of chain) {
        await seam.emit(eventOf(type, { traceId: 'tr-chain', qty }))
      }
      // 另一条链，不得混入
      await seam.emit(eventOf('job.compute', { traceId: 'tr-other', qty: 7 }))
      await drained(seam)

      const got = await seam.byTrace('tr-chain')
      expect(got.map((e) => e.costType)).toEqual(chain.map(([t]) => t))
      expect(got.map((e) => e.qty)).toEqual(chain.map(([, q]) => q))
      // 读两次结果一致（「这次尖峰的构成」不能每次读都不同）
      const again = await seam.byTrace('tr-chain')
      expect(again.map((e) => e.costType)).toEqual(got.map((e) => e.costType))

      const other = await seam.byTrace('tr-other')
      expect(other.map((e) => e.costType)).toEqual(['job.compute'])
    })
  })

  t('取回的事件与写入的等价 —— 往返不丢字段', async () => {
    await withSeam(async (seam) => {
      const written = eventOf('inference.gpu', { traceId: 'tr-rt', qty: 42.5, costUsd: 1.25 })
      await seam.emit(written)
      await drained(seam)
      const [read] = await seam.byTrace('tr-rt')
      expect(read).toEqual(written)
    })
  })

  t('未知 cost_type 在 sink 层就被拒，且不落任何行 —— append-only 台账里的脏行删不掉', async () => {
    await withSeam(async (seam) => {
      const bad = { ...eventOf('job.compute'), costType: 'made.up' as CostType }
      await expect(seam.emit(bad)).rejects.toThrow(/made\.up/)

      const [{ n }] = await seam.raw<{ n: string }>(`SELECT count(*)::text AS n FROM usage_ledger`)
      expect(n, '校验必须在写库之前').toBe('0')
      const [{ o }] = await seam.raw<{ o: string }>(
        `SELECT count(*)::text AS o FROM usage_event_outbox`,
      )
      expect(o, '坏事件也不得进入 outbox——outbox 不是绕过校验的通道').toBe('0')
    })
  })

  t('单位与类型不一致的事件被拒，且不落行', async () => {
    await withSeam(async (seam) => {
      await expect(seam.emit(eventOf('job.compute', { unit: 'rows' }))).rejects.toThrow(/second/)
      const [{ n }] = await seam.raw<{ n: string }>(`SELECT count(*)::text AS n FROM usage_ledger`)
      expect(n).toBe('0')
      const [{ o }] = await seam.raw<{ o: string }>(
        `SELECT count(*)::text AS o FROM usage_event_outbox`,
      )
      expect(o).toBe('0')
    })
  })

  t('读到闭集外的 cost_type 时报错而不是当成合法值 —— 那是有人绕过了 sink', async () => {
    await withSeam(async (seam) => {
      // 直写表模拟「绕过 sink 的写入方」或本项上线前的历史行
      await seam.raw(
        `INSERT INTO usage_ledger
           (user_id, dept_id, role, project_id, agent_id, component_id, feature,
            session_ref, tokens, cost_type, cost_usd, trace_id, emitter, qty, unit)
         VALUES ('u1','d1','viewer','p1','a1','c1','kb:qa','s1',0,'legacy.thing',0,'tr-legacy','x',1,'call')`,
      )
      await expect(seam.byTrace('tr-legacy')).rejects.toThrow(/legacy\.thing/)
    })
  })

  t('commit() 走同一个写入方法 —— LLM 截面也带上 trace/emitter/qty', async () => {
    await withSeam(async (seam) => {
      await seam.setBudget('user', 'u1', 10_000)
      await seam.setBudget('project', 'p1', 10_000)
      await seam.commit({
        context: ctx, tokens: 700, model: 'deepseek', costType: 'llm', costUsd: 0.7,
      })
      await drained(seam)

      const [row] = await seam.raw<Row>(`SELECT * FROM usage_ledger`)
      // costType 落的是闭集取值 'llm.tokens'，而不是调用方传的自由文本 'llm'
      expect(row!.cost_type).toBe('llm.tokens')
      expect(row!.tokens).toBe(700)
      expect(Number(row!.qty)).toBe(700)
      expect(row!.unit).toBe('tokens')
      expect(row!.emitter).toBe('metering:llm-cross-section')
      // 显式哨兵而非空串：空串会和「发出方忘了填」混在一起，而这两件事处理方式不同
      expect(row!.trace_id).toBe('legacy-llm-cross-section')
    })
  })

  t('commit() 带 traceId 时用调用方的，不用哨兵', async () => {
    await withSeam(async (seam) => {
      await seam.setBudget('user', 'u1', 10_000)
      await seam.setBudget('project', 'p1', 10_000)
      await seam.commit({
        context: ctx, tokens: 700, model: 'deepseek', costType: 'llm',
        costUsd: 0.7, traceId: 'tr-wired',
      })
      await drained(seam)
      const chain = await seam.byTrace('tr-wired')
      expect(chain.map((e) => e.costType)).toEqual(['llm.tokens'])
      expect(chain[0]!.tokens).toBe(700)
    })
  })
})
