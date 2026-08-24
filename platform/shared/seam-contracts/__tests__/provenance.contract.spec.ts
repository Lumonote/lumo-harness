import { describe, expect, it } from 'vitest'
import {
  PROVENANCE_RANK,
  adjudicateCall,
  maxProvenance,
  type Provenance,
  type TaintState,
} from '../provenance.ts'

const clean: TaintState = { turn: 1, level: 'user', sources: [] }
const tainted: TaintState = { turn: 1, level: 'external', sources: ['knowledge_query'] }

describe('maxProvenance —— 单调取高，不可降级', () => {
  it('取秩更高者', () => {
    expect(maxProvenance('user', 'external')).toBe('external')
    expect(maxProvenance('external', 'internal')).toBe('external')
    expect(maxProvenance('system', 'user')).toBe('user')
  })

  it('external 之后任何来源都不能把等级降回去（规格 §6 场景 8）', () => {
    let level: Provenance = 'external'
    for (const next of ['system', 'user', 'internal'] as Provenance[]) {
      level = maxProvenance(level, next)
    }
    expect(level).toBe('external')
  })

  it('秩表覆盖全部四档且严格递增', () => {
    expect(Object.keys(PROVENANCE_RANK).sort()).toEqual(
      ['external', 'internal', 'system', 'user'],
    )
    expect(PROVENANCE_RANK.system).toBeLessThan(PROVENANCE_RANK.user)
    expect(PROVENANCE_RANK.user).toBeLessThan(PROVENANCE_RANK.internal)
    expect(PROVENANCE_RANK.internal).toBeLessThan(PROVENANCE_RANK.external)
  })
})

describe('adjudicateCall —— 判决矩阵（规格 §4）', () => {
  it('场景 1：干净 turn 调外部写 → 放行（不误伤正常路径）', () => {
    expect(adjudicateCall(clean, 'write-external', false).action).toBe('allow')
  })

  it('场景 2：受污染 turn 调外部写 → 转 HITL，非静默执行', () => {
    const verdict = adjudicateCall(tainted, 'write-external', false)
    expect(verdict.action).toBe('require-confirmation')
    // 判据必须带上污点来源 —— 只说「是否允许」会加速审批疲劳（规格 §4）
    expect(verdict.reason).toContain('knowledge_query')
  })

  it('场景 7：受污染 turn 内只读放行、本地写放行但留审计', () => {
    expect(adjudicateCall(tainted, 'read', false).action).toBe('allow')
    expect(adjudicateCall(tainted, 'write-local', false).action).toBe('allow-audited')
  })

  it('人工确认后放行', () => {
    expect(adjudicateCall(tainted, 'write-external', true).action).toBe('allow')
  })

  it('干净 turn 的本地写不需要审计噪声', () => {
    expect(adjudicateCall(clean, 'write-local', false).action).toBe('allow')
  })
})
