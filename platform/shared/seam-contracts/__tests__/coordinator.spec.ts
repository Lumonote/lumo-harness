import { describe, expect, it } from 'vitest'

import {
  DENIED_STREAK_LIMIT,
  DENIED_TOTAL_LIMIT,
  HIGH_IMPACT_ARTIFACTS,
  classifyAction,
  fallbackVerdict,
  integrationVerdict,
  reviewerEligibility,
  type ActionFacts,
} from '../coordinator.ts'

/**
 * §24.5 / §24.7 / §24.8 判据源的契约测试。
 *
 * 这个文件测的是**不变量**，不是分支覆盖率：每条 describe 对应文档里一条硬约束，
 * 而每条约束的写法都是「无论别的字段怎么变，X 恒为 Y」——所以用全组合而不是逐例。
 * 逐例会随字段增加而腐烂（新增一个字段时没人回来补 2^n 个用例），全组合不会。
 */

/** 一个「最难判」的基例：有副作用、可逆、同 realm、不碰凭证、OPA 放行、分类器可用。 */
const BASELINE: ActionFacts = {
  sideEffect: true,
  reversible: true,
  crossRealm: false,
  touchesCredentials: false,
  opaAllowed: true,
  classifierAvailable: true,
  classifierVerdict: 'review',
}

/**
 * 对布尔字段做全组合，其余沿用覆盖值。
 *
 * **覆盖过的字段必须从组合维度里剔除**——否则它会被重新翻转回来，
 * 于是「opaAllowed 恒 false」这类断言实际上在混着一半 true 的集合上跑。
 * 这个坑在本文件写下时真踩过一次：失败信息是「expected DENY, got AUTO」，
 * 而问题在用例的生成器而不在被测函数。
 */
function allFacts(overrides: Partial<ActionFacts> = {}): ActionFacts[] {
  const flags = ([
    'sideEffect', 'reversible', 'crossRealm',
    'touchesCredentials', 'opaAllowed', 'classifierAvailable',
  ] as const).filter(flag => !(flag in overrides))
  let out: ActionFacts[] = [{ ...BASELINE, ...overrides }]
  for (const flag of flags) {
    out = out.flatMap(facts => [facts, { ...facts, [flag]: !facts[flag] }])
  }
  return out
}

describe('§24.5 classifyAction —— 分类器只收窄，不放宽', () => {
  it('opaAllowed=false 时恒 DENY，且理由恒为 opa-denied', () => {
    for (const facts of allFacts({ opaAllowed: false })) {
      const decision = classifyAction(facts)
      expect(decision).toEqual({ band: 'DENY', reason: 'opa-denied' })
    }
  })

  it('OPA 判否时分类器的意见不产生任何影响', () => {
    const denied = allFacts({ opaAllowed: false })
    const verdicts = ['allow', 'review', undefined] as const
    for (const verdict of verdicts) {
      const bands = denied.map(f => classifyAction({ ...f, classifierVerdict: verdict }).band)
      expect(new Set(bands)).toEqual(new Set(['DENY']))
    }
  })

  it('跨 realm 与触达凭证恒 DENY，且在 OPA 放行时给出各自可聚合的理由', () => {
    // 必须钉住 opaAllowed：不钉住的话集合里混着「OPA 本就判否」的组合，
    // 它们的理由合法地是 opa-denied（规则 1 优先级更高），断言会假红。
    for (const facts of allFacts({ crossRealm: true, opaAllowed: true })) {
      expect(classifyAction(facts)).toEqual({ band: 'DENY', reason: 'cross-realm' })
    }
    for (const facts of allFacts({
      touchesCredentials: true, crossRealm: false, opaAllowed: true,
    })) {
      expect(classifyAction(facts)).toEqual({ band: 'DENY', reason: 'credentials' })
    }
  })

  it('不可逆的动作被摘下判定域：无论分类器怎么说都是 DENY', () => {
    for (const facts of allFacts({ reversible: false })) {
      expect(classifyAction(facts).band).toBe('DENY')
      expect(classifyAction({ ...facts, classifierVerdict: 'allow' }).band).toBe('DENY')
    }
  })

  it('只读动作不受分类器可用性影响', () => {
    // 这是本模块最容易写错的边界：把只读也推进人审队列，正是文章批评的
    // 97% 批准率场景（审批退化成反射性点击，既不安全也不快）。
    // 写成「翻转 classifierAvailable 不改变结论」而不是「恒为 AUTO」，
    // 因为不可逆/跨 realm/OPA 判否这三条更高优先级的规则仍然应该赢。
    for (const facts of allFacts({ sideEffect: false })) {
      expect(classifyAction({ ...facts, classifierAvailable: false }))
        .toEqual(classifyAction({ ...facts, classifierAvailable: true }))
    }
  })

  it('只读动作在无更高优先级拒绝理由时恒 AUTO', () => {
    const clean = {
      sideEffect: false, opaAllowed: true, reversible: true,
      crossRealm: false, touchesCredentials: false,
    }
    for (const facts of allFacts(clean)) {
      expect(classifyAction(facts)).toEqual({ band: 'AUTO', reason: 'read-only' })
    }
  })

  it('分类器不可用时：有副作用的动作绝不 AUTO，且理由恒为 classifier-unavailable', () => {
    // 全组合上的不变量：只要分类器不可用，AUTO 就只可能来自「只读」这一条路径。
    for (const facts of allFacts({ classifierAvailable: false })) {
      const decision = classifyAction(facts)
      if (decision.band === 'AUTO') {
        expect(facts.sideEffect).toBe(false)
        expect(decision.reason).toBe('read-only')
      }
    }
    // 判定域内的那一条（其余四条拒绝规则都不适用）必须落在 REVIEW。
    for (const facts of allFacts({
      classifierAvailable: false, opaAllowed: true, sideEffect: true,
      reversible: true, crossRealm: false, touchesCredentials: false,
    })) {
      expect(classifyAction(facts)).toEqual({ band: 'REVIEW', reason: 'classifier-unavailable' })
    }
  })

  it('分类器「没说话」不等于「同意」', () => {
    expect(classifyAction({ ...BASELINE, classifierVerdict: undefined }))
      .toEqual({ band: 'REVIEW', reason: 'classifier-review' })
  })

  it('分类器放行是唯一能产出 AUTO 的路径（只读除外）', () => {
    const autos = allFacts({ classifierVerdict: 'allow' })
      .map(f => classifyAction(f))
      .filter(d => d.band === 'AUTO')
    // 所有 AUTO 都必须来自 read-only 或 classifier-allow，不存在第三条路径。
    for (const decision of autos) {
      expect(['read-only', 'classifier-allow']).toContain(decision.reason)
    }
  })
})

describe('§24.5 fallbackVerdict —— 兜底防自旋', () => {
  it('边界值：2/19 不触发，3/20 触发', () => {
    expect(fallbackVerdict({ deniedStreak: 2, deniedTotal: 19 })).toBe('keep')
    expect(fallbackVerdict({ deniedStreak: 3, deniedTotal: 0 })).toBe('fallback-to-manual')
    expect(fallbackVerdict({ deniedStreak: 0, deniedTotal: 20 })).toBe('fallback-to-manual')
  })

  it('两个计数任一达标即回落', () => {
    expect(fallbackVerdict({ deniedStreak: DENIED_STREAK_LIMIT, deniedTotal: 1 }))
      .toBe('fallback-to-manual')
    expect(fallbackVerdict({ deniedStreak: 1, deniedTotal: DENIED_TOTAL_LIMIT }))
      .toBe('fallback-to-manual')
    expect(fallbackVerdict({ deniedStreak: 2, deniedTotal: 19 })).toBe('keep')
  })

  it('非负安全整数以外的计数一律抛 invalid，不静默当成 0', () => {
    // 静默当成 0 会让兜底失效：NaN >= 3 是 false，于是永远不回落。
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => fallbackVerdict({ deniedStreak: bad, deniedTotal: 0 })).toThrow()
      expect(() => fallbackVerdict({ deniedStreak: 0, deniedTotal: bad })).toThrow()
    }
  })

  it('计数为 0 时保持不回落（正常路径）', () => {
    expect(fallbackVerdict({ deniedStreak: 0, deniedTotal: 0 })).toBe('keep')
  })
})

describe('§24.7 integrationVerdict —— 批级判定', () => {
  it('两项都过才 pass', () => {
    expect(integrationVerdict({ contractTestsPass: true, smokePass: true })).toBe('pass')
  })

  it('任一不过即整批打回（不是逐 Run 打回）', () => {
    expect(integrationVerdict({ contractTestsPass: false, smokePass: true })).toBe('reject-batch')
    expect(integrationVerdict({ contractTestsPass: true, smokePass: false })).toBe('reject-batch')
    expect(integrationVerdict({ contractTestsPass: false, smokePass: false })).toBe('reject-batch')
  })

  it('返回值是闭集，调用方无需解释自由文本', () => {
    const verdicts = [true, false].flatMap(contractTestsPass =>
      [true, false].map(smokePass => integrationVerdict({ contractTestsPass, smokePass })))
    for (const verdict of verdicts) expect(['pass', 'reject-batch']).toContain(verdict)
  })
})

describe('§24.8 reviewerEligibility —— 异构审查者', () => {
  const base = {
    dispatcher: 'coordinator:1',
    reviewer: 'reviewer:1',
    dispatcherPreset: 'impl-a',
    reviewerPreset: 'impl-b',
    dispatcherModel: 'model-a',
    reviewerModel: 'model-b',
    dispatcherNode: 'node-a',
    reviewerNode: 'node-b',
    affectedArtifacts: 1,
  }

  it('派发者不验收自己的活（与异构无关的职责分离）', () => {
    expect(reviewerEligibility({ ...base, reviewer: base.dispatcher }))
      .toEqual({ eligible: false, reason: 'self-review' })
  })

  it('三个维度都不可证不同 → homogeneous', () => {
    expect(reviewerEligibility({
      dispatcher: 'a', reviewer: 'b', affectedArtifacts: 1,
    })).toEqual({ eligible: false, reason: 'homogeneous' })
  })

  it('缺省不视为「不同」：只有一侧给了值不算异构', () => {
    // 与 remotability.ts「未定级 = 拒绝」同一条纪律：判不出差别时按没差别处理。
    expect(reviewerEligibility({
      dispatcher: 'a', reviewer: 'b',
      dispatcherModel: 'model-a', affectedArtifacts: 1,
    })).toEqual({ eligible: false, reason: 'homogeneous' })
  })

  it('任一维度可证不同即合格', () => {
    expect(reviewerEligibility({
      dispatcher: 'a', reviewer: 'b',
      dispatcherNode: 'node-a', reviewerNode: 'node-b',
      affectedArtifacts: 1,
    })).toEqual({ eligible: true })
  })

  it('影响面 ≥3 时「换了节点」不构成多样性，需要模型或 preset 不同', () => {
    const nodeOnly = {
      dispatcher: 'a', reviewer: 'b',
      dispatcherNode: 'node-a', reviewerNode: 'node-b',
      affectedArtifacts: HIGH_IMPACT_ARTIFACTS,
    }
    expect(reviewerEligibility(nodeOnly))
      .toEqual({ eligible: false, reason: 'high-impact-needs-model-diversity' })

    // 边界：2 个产出物时仍接受仅节点异构。
    expect(reviewerEligibility({ ...nodeOnly, affectedArtifacts: HIGH_IMPACT_ARTIFACTS - 1 }))
      .toEqual({ eligible: true })

    // 模型不同则合格。
    expect(reviewerEligibility({
      ...nodeOnly,
      dispatcherModel: 'model-a', reviewerModel: 'model-b',
    })).toEqual({ eligible: true })
  })

  it('非法 affectedArtifacts 判不合格，不抛异常', () => {
    // 这一条与其余校验刻意不同：本函数的返回值就是「合不合格」，
    // 抛异常会让调用方把「数据坏了」与「审查者不合格」混成一件事。
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(reviewerEligibility({ ...base, affectedArtifacts: bad }))
        .toEqual({ eligible: false, reason: 'invalid-input' })
    }
  })

  it('合法输入下 eligible 恒为 true，且不返回自由文本', () => {
    for (const artifacts of [0, 1, 2, 3, 10]) {
      const result = reviewerEligibility({ ...base, affectedArtifacts: artifacts })
      expect(result).toEqual({ eligible: true })
    }
  })
})
