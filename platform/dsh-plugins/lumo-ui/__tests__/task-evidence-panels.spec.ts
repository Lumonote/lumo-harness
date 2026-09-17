import { describe, expect, it } from 'vitest'

import { readTaskOutput } from '../src/client/cluster-panels.tsx'

// 证据面板渲染结果全文时，「有没有交付物」与「交付物长什么样」是两件事。
// 这里只钉第一件：判空必须用 null/undefined，不能借真值判断。
//
// 为什么值得单独钉：治理面把 output 存成 json.RawMessage，`0`、`false`、`""`
// 都是合法的交付物。真值判断会把它们显示成「没有产出」，而面板的措辞又恰好是
// 一句确定的话——操作者不会怀疑，只会以为执行真的没交付东西。
describe('readTaskOutput', () => {
  it('reports absent output only for null and undefined', () => {
    expect(readTaskOutput(undefined)).toEqual({ present: false, text: '' })
    expect(readTaskOutput(null)).toEqual({ present: false, text: '' })
  })

  it('keeps falsy but real deliverables', () => {
    expect(readTaskOutput(0)).toEqual({ present: true, text: '0' })
    expect(readTaskOutput(false)).toEqual({ present: true, text: 'false' })
    // 空字符串是「交付了一个空交付物」，与「没有 output 字段」不同：
    // 前者 present=true，面板会说交付物是空字符串。
    expect(readTaskOutput('')).toEqual({ present: true, text: '' })
  })

  it('keeps text verbatim and pretty-prints structured output', () => {
    expect(readTaskOutput('已复核 12 份合同')).toEqual({ present: true, text: '已复核 12 份合同' })
    expect(readTaskOutput({ risk: 0, clauses: ['A', 'B'] })).toEqual({
      present: true,
      text: '{\n  "risk": 0,\n  "clauses": [\n    "A",\n    "B"\n  ]\n}',
    })
    expect(readTaskOutput([])).toEqual({ present: true, text: '[]' })
  })
})
