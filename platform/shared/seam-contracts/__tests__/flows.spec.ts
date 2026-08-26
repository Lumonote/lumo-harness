import { describe, expect, it } from 'vitest'

import {
  FLOW_EVENTS,
  FLOW_STATUSES,
  VISIBILITIES,
  audienceMatches,
  transitionFlow,
  validateFlowDefinition,
} from '../flows.ts'

/**
 * 第五类制品契约（§11 后半，设计说明 2026-08-26 §3）。
 *
 * 状态机逐转移断言（不是抽样）；防环是硬护栏——环在入库前拦比 FlowEngine 运行时炸
 * 便宜一个数量级；audience 空集恒假（targeted 但无 audience 是配置错误，宁可不可见）。
 */

describe('闭集', () => {
  it('状态：draft → … → deprecated 五态', () => {
    expect(FLOW_STATUSES).toEqual(['draft', 'submitted', 'published', 'targeted', 'deprecated'])
  })

  it('事件五项 / 可见性三档', () => {
    expect(FLOW_EVENTS).toEqual(['submit', 'approve', 'reject', 'target', 'deprecate'])
    expect(VISIBILITIES).toEqual(['private', 'targeted', 'global'])
  })
})

describe('transitionFlow 状态机', () => {
  const legal: Array<[string, string, string]> = [
    ['draft', 'submit', 'submitted'],
    ['draft', 'deprecate', 'deprecated'],
    ['submitted', 'approve', 'published'],
    ['submitted', 'reject', 'draft'],
    ['published', 'target', 'targeted'],
    ['published', 'deprecate', 'deprecated'],
    // targeted 重定 audience：幂等转移
    ['targeted', 'target', 'targeted'],
    ['targeted', 'deprecate', 'deprecated'],
  ]

  it('合法转移逐条', () => {
    for (const [from, event, to] of legal) {
      expect(transitionFlow(from as never, event as never), `${from} --${event}-->`).toBe(to)
    }
  })

  it('非法转移拒绝（含 deprecated 终态与状态机外动作）', () => {
    const illegal: Array<[string, string]> = [
      ['draft', 'approve'],      // 未提交不能直接审过
      ['draft', 'target'],       // 未发布不能定向
      ['submitted', 'submit'],   // 重复提交
      ['submitted', 'target'],
      ['published', 'submit'],
      ['published', 'approve'],  // 已发布不能再审
      ['published', 'reject'],
      ['targeted', 'submit'],
      ['targeted', 'approve'],
      ['targeted', 'reject'],
      // deprecated 是终态：复活必须走版本回滚（重指快照），不是状态机转移
      ['deprecated', 'submit'],
      ['deprecated', 'target'],
      ['deprecated', 'deprecate'],
    ]
    for (const [from, event] of illegal) {
      expect(() => transitionFlow(from as never, event as never), `${from} --${event}-->`).toThrow()
    }
  })

  it('闭集外状态/事件即抛', () => {
    expect(() => transitionFlow('live' as never, 'submit' as never)).toThrow(/状态/)
    expect(() => transitionFlow('draft', 'publish' as never)).toThrow(/事件/)
  })
})

describe('validateFlowDefinition 防环护栏（§9.2 入库前）', () => {
  const dag = (nodes: Array<{ id: string; operator?: string }>, edges: Array<[string, string]>) => ({
    nodes: nodes.map((n) => ({ id: n.id, operator: n.operator ?? 'kb.query' })),
    edges: edges.map(([from, to]) => ({ from, to })),
  })

  it('合法 DAG（含分叉与汇合）通过', () => {
    expect(validateFlowDefinition(dag(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
    ))).toBe(true)
  })

  it('空节点集拒绝——空流程没有定义语义', () => {
    expect(() => validateFlowDefinition(dag([], []))).toThrow(/节点/)
  })

  it('重复节点 id 拒绝', () => {
    expect(() => validateFlowDefinition(dag([{ id: 'a' }, { id: 'a' }], []))).toThrow(/唯一/)
  })

  it('缺 operator 拒绝——空算子是未完成的定义', () => {
    expect(() => validateFlowDefinition({
      nodes: [{ id: 'a', operator: '' }],
      edges: [],
    } as never)).toThrow(/算子/)
  })

  it('悬边拒绝（引用不存在的节点）', () => {
    expect(() => validateFlowDefinition(dag([{ id: 'a' }], [['a', 'ghost']]))).toThrow(/不存在/)
  })

  it('环拒绝——自环、二元环、间接环（Kahn 拓扑）', () => {
    expect(() => validateFlowDefinition(dag([{ id: 'a' }], [['a', 'a']]))).toThrow(/环/)
    expect(() => validateFlowDefinition(dag(
      [{ id: 'a' }, { id: 'b' }], [['a', 'b'], ['b', 'a']],
    ))).toThrow(/环/)
    expect(() => validateFlowDefinition(dag(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'd']],
    ))).toThrow(/环/)
  })

  it('非对象定义拒绝', () => {
    expect(() => validateFlowDefinition('hello' as never)).toThrow(/形状/)
  })
})

describe('audienceMatches 定向可见性', () => {
  const audience = { roles: ['analyst'], depts: ['d2'], users: ['carol'] }

  it('role / dept / user 任一命中即真', () => {
    expect(audienceMatches(audience, { roles: ['analyst'], depts: [], user: 'x', dept: '' })).toBe(true)
    expect(audienceMatches(audience, { roles: [], depts: [], user: 'carol', dept: 'd2' })).toBe(true)
    expect(audienceMatches(audience, { roles: [], depts: [], user: 'y', dept: 'd2' })).toBe(true)
  })

  it('未命中为假；空 audience 恒假（配置错误宁可不可见）', () => {
    expect(audienceMatches(audience, { roles: ['viewer'], depts: [], user: 'z', dept: 'd9' })).toBe(false)
    expect(audienceMatches({}, { roles: ['admin'], depts: ['d2'], user: 'carol', dept: 'd2' })).toBe(false)
    expect(audienceMatches(null as never, { roles: ['admin'], depts: [], user: 'x', dept: '' })).toBe(false)
  })
})
