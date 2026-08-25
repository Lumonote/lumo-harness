import { describe, expect, it } from 'vitest'

import { TurnCallBudget, type BudgetViolation } from '../turn-budget.ts'

const collect = (): { seen: BudgetViolation[]; onViolation: (v: BudgetViolation) => void } => {
  const seen: BudgetViolation[] = []
  return { seen, onViolation: (v) => { seen.push(v) } }
}

// knowledge 的预算是 8 次/turn（分级表），下面所有数字都对着它
const BUDGET = 8

describe('闸 C —— 每 turn 调用预算', () => {
  it('预算内不触发回调', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't1')
    expect(seen).toEqual([])
  })

  it('warn 模式第 budget+1 次触发回调，且 record 不抛', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't1')
    expect(() => b.record('knowledge', 't1')).not.toThrow()
    expect(seen.length).toBe(1)
  })

  it('违规回调字段完整 —— 结构化才能进 CI 断言', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i <= BUDGET; i++) b.record('knowledge', 't1')
    expect(seen[0]).toEqual({
      seam: 'knowledge',
      turn: 't1',
      count: BUDGET + 1,
      budget: BUDGET,
    })
  })

  it('enforce 模式第 budget+1 次抛，消息含 seam/count/budget 三个数', () => {
    const b = new TurnCallBudget({ mode: 'enforce' })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't1')
    let msg = ''
    try { b.record('knowledge', 't1') } catch (e) { msg = String(e) }
    expect(msg).toContain('knowledge')
    expect(msg).toContain(String(BUDGET + 1))
    expect(msg).toContain(String(BUDGET))
  })

  it('enforce 模式抛之前也回调 —— 拒绝了同样要留下结构化证据', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'enforce', onViolation })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't1')
    expect(() => b.record('knowledge', 't1')).toThrow()
    expect(seen.length).toBe(1)
  })

  it('只在第一次越界时回调一次 —— 否则写得碎的组件会刷上百条相同告警', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i < BUDGET + 50; i++) b.record('knowledge', 't1')
    expect(seen.length).toBe(1)
    // 计数继续走：告警去重不等于统计失真
    expect(seen[0]!.count).toBe(BUDGET + 1)
    expect(b.countOf('knowledge', 't1')).toBe(BUDGET + 50)
  })

  it('不同 turn 各自计数（换 turn 归零）', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't1')
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't2')
    expect(seen).toEqual([])
    expect(b.countOf('knowledge', 't2')).toBe(BUDGET)
  })

  it('不同 seam 各自计数', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 't1')
    for (let i = 0; i < BUDGET; i++) b.record('knowledgeGraph', 't1')
    expect(seen).toEqual([])
  })

  it('无预算声明的 seam 不计数不抛 —— 闸 A 已拦，这里不重复执法', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'enforce', onViolation })
    for (let i = 0; i < 1000; i++) {
      expect(() => b.record('made-up-seam', 't1')).not.toThrow()
    }
    expect(seen).toEqual([])
    expect(b.countOf('made-up-seam', 't1')).toBe(0)
  })

  it('缺省 mode 是 warn —— 超预算是性能回归不是安全事故', () => {
    const b = new TurnCallBudget({})
    for (let i = 0; i < BUDGET + 5; i++) {
      expect(() => b.record('knowledge', 't1')).not.toThrow()
    }
  })
})

describe('内存有界 —— turn 只增不减，无界 Map 是长会话里的漏内存', () => {
  it('只保留最近 8 个 turn，更旧的被淘汰', () => {
    const b = new TurnCallBudget({ mode: 'warn' })
    for (let t = 0; t < 12; t++) b.record('knowledge', `t${t}`)
    expect(b.trackedTurns()).toBe(8)
    // 最旧的 4 个已淘汰：再问计数是 0（而不是保留着）
    expect(b.countOf('knowledge', 't0')).toBe(0)
    expect(b.countOf('knowledge', 't11')).toBe(1)
  })

  it('被淘汰的 turn 再次出现时从零开始 —— 迟到的调用不该继承旧计数', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i < BUDGET; i++) b.record('knowledge', 'old')
    for (let t = 0; t < 8; t++) b.record('knowledge', `t${t}`)
    b.record('knowledge', 'old')
    expect(seen).toEqual([])
    expect(b.countOf('knowledge', 'old')).toBe(1)
  })

  it('重复 record 同一个 turn 不会让它被自己挤掉', () => {
    const b = new TurnCallBudget({ mode: 'warn' })
    for (let i = 0; i < 100; i++) b.record('knowledge', 't1')
    expect(b.trackedTurns()).toBe(1)
    expect(b.countOf('knowledge', 't1')).toBe(100)
  })

  it('哨兵 turn 与普通 turn 一样计数 —— 没有 turn 不该成为绕过预算的办法', () => {
    const { seen, onViolation } = collect()
    const b = new TurnCallBudget({ mode: 'warn', onViolation })
    for (let i = 0; i <= BUDGET; i++) b.record('knowledge', 'no-turn')
    expect(seen.length).toBe(1)
    expect(seen[0]!.turn).toBe('no-turn')
  })

  it('哨兵 turn 不参与淘汰 —— 否则单机脚本的计数会被自己的 turn 流冲掉', () => {
    const b = new TurnCallBudget({ mode: 'warn' })
    b.record('knowledge', 'no-turn')
    for (let t = 0; t < 20; t++) b.record('knowledge', `t${t}`)
    expect(b.countOf('knowledge', 'no-turn')).toBe(1)
  })
})
