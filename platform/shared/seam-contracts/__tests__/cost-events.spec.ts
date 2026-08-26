import { describe, expect, it } from 'vitest'

import {
  COST_TYPES,
  assertCostEvent,
  isCostType,
  unitFor,
  type CostEvent,
  type CostType,
} from '../cost-events.ts'
import type { MeterContext } from '../metering.ts'

const ctx: MeterContext = {
  userId: 'u1', deptId: 'd1', role: 'viewer', projectId: 'p1',
  agentId: 'a1', componentId: 'c1', feature: 'kb:qa', sessionRef: 's1',
}

const event = (over: Partial<CostEvent> = {}): CostEvent => ({
  context: ctx,
  costType: 'seam.query',
  qty: 1200,
  unit: 'rows',
  traceId: 'tr-1',
  emitter: 'knowledge-provider',
  costUsd: 0.002,
  ...over,
})

describe('cost_type 是闭集 —— 自由文本列撑不起「解释一次尖峰」', () => {
  it('六类成本类型齐备', () => {
    expect(Object.keys(COST_TYPES).sort()).toEqual([
      'connector.call', 'inference.gpu', 'job.compute',
      'llm.tokens', 'seam.query', 'storage.bytes',
    ])
  })

  it('闭集锁：COST_TYPES 与 manifests/cost-types.manifest.json 逐项一致（单源不漂移）', async () => {
    // 2026-08-26 单源化：数值真相源在 manifest（Go 消费侧 embed 同一文件）。
    // 本断言保证 TS 侧派生没有漏改——只改 manifest 此处即红，提醒显式同步两语言。
    const manifest = await import('../../manifests/cost-types.manifest.json', { with: { type: 'json' } })
    const m = manifest.default.costTypes as Record<string, { unit: string }>
    expect(Object.keys(m).sort()).toEqual(Object.keys(COST_TYPES).sort())
    for (const t of Object.keys(COST_TYPES) as CostType[]) {
      expect(COST_TYPES[t].unit, `${t} 单位漂移`).toBe(m[t]!.unit)
    }
  })

  it('每类都能构造出合法事件', () => {
    for (const t of Object.keys(COST_TYPES) as CostType[]) {
      // llm.tokens 额外要求 tokens/model（它是唯一的 token 截面）
      const extra = t === 'llm.tokens' ? { tokens: 1200, model: 'deepseek' } : {}
      expect(() => assertCostEvent(event({ costType: t, unit: unitFor(t), ...extra })),
        `${t} 应当合法`).not.toThrow()
    }
  })

  it('未知类型被拒，且错误信息列出合法取值 —— 读得到取值才省得翻代码', () => {
    let msg = ''
    try { unitFor('llm.magic') } catch (e) { msg = String(e) }
    expect(msg).toContain('llm.magic')
    for (const t of Object.keys(COST_TYPES)) expect(msg).toContain(t)
  })

  it('未知类型的事件在校验层就被拒 —— 不记成 unknown', () => {
    const bad = event({ costType: 'made.up' as CostType })
    expect(() => assertCostEvent(bad)).toThrow()
  })

  it('isCostType 只对闭集内为真', () => {
    expect(isCostType('llm.tokens')).toBe(true)
    expect(isCostType('made.up')).toBe(false)
    // 原型链上的键不得被当成合法类型
    expect(isCostType('constructor')).toBe(false)
    expect(isCostType('toString')).toBe(false)
  })
})

describe('单位必须与类型自洽 —— 冗余是刻意的，但不能成为第二个真相源', () => {
  it('每类的 unit 是它该有的那个', () => {
    expect(unitFor('llm.tokens')).toBe('tokens')
    expect(unitFor('connector.call')).toBe('call')
    expect(unitFor('seam.query')).toBe('rows')
    expect(unitFor('job.compute')).toBe('second')
    expect(unitFor('storage.bytes')).toBe('byte-day')
    expect(unitFor('inference.gpu')).toBe('second')
  })

  it('unit 与 costType 不一致时拒 —— 否则入库行与代码映射表会各说一套', () => {
    let msg = ''
    try { assertCostEvent(event({ costType: 'job.compute', unit: 'rows' })) } catch (e) { msg = String(e) }
    expect(msg).toContain('job.compute')
    expect(msg).toContain('second')
    expect(msg).toContain('rows')
  })
})

describe('量的合法性 —— 负成本是记账错误，不是退款', () => {
  it('qty 为负被拒', () => {
    expect(() => assertCostEvent(event({ qty: -1 }))).toThrow()
  })

  it('qty 为 NaN / Infinity 被拒', () => {
    expect(() => assertCostEvent(event({ qty: Number.NaN }))).toThrow()
    expect(() => assertCostEvent(event({ qty: Number.POSITIVE_INFINITY }))).toThrow()
  })

  it('qty 为 0 合法 —— 一次没扫到行的查询仍是一次发生过的调用', () => {
    expect(() => assertCostEvent(event({ qty: 0 }))).not.toThrow()
  })

  it('costUsd 为负被拒', () => {
    expect(() => assertCostEvent(event({ costUsd: -0.5 }))).toThrow()
  })
})

describe('归因链字段必填 —— 缺了就只能靠时间戳猜是哪个请求', () => {
  it('traceId 为空被拒', () => {
    expect(() => assertCostEvent(event({ traceId: '' }))).toThrow()
  })

  it('emitter 为空被拒 —— 出账争议要能定位到具体组件而非组件类别', () => {
    expect(() => assertCostEvent(event({ emitter: '' }))).toThrow()
  })

  it('归因上下文缺字段被拒', () => {
    const bad = event()
    bad.context = { ...ctx, userId: '' }
    expect(() => assertCostEvent(bad)).toThrow()
  })
})

describe('llm.tokens 的特殊约定', () => {
  it('llm.tokens 必须带 tokens 与 model —— 它是唯一的 token 截面', () => {
    expect(() => assertCostEvent(event({
      costType: 'llm.tokens', unit: 'tokens', qty: 600,
    }))).toThrow()
    expect(() => assertCostEvent(event({
      costType: 'llm.tokens', unit: 'tokens', qty: 600, tokens: 600, model: 'deepseek',
    }))).not.toThrow()
  })

  it('llm.tokens 的 qty 必须等于 tokens —— 两个数不等说明口径已经分叉', () => {
    expect(() => assertCostEvent(event({
      costType: 'llm.tokens', unit: 'tokens', qty: 600, tokens: 500, model: 'deepseek',
    }))).toThrow()
  })

  it('非 llm.tokens 不得带 tokens —— 带了说明发出方把量塞错了列', () => {
    expect(() => assertCostEvent(event({
      costType: 'job.compute', unit: 'second', qty: 12, tokens: 12,
    }))).toThrow()
  })
})
