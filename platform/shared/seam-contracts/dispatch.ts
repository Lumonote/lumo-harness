/**
 * 统一 Worker 派单契约（业务控制面 §23.2）。
 *
 * 这个文件是派单分数的跨语言真相源：Go 治理服务与桌面/插件读面都必须遵守
 * 同一组五维输入、闭集分档和 Human 成本维降级规则。
 */

export type DispatchWorkerKind = 'human' | 'agent'

export interface DispatchWeights {
  match: number
  confidence: number
  load: number
  quality: number
  cost: number
}

export const DISPATCH_WEIGHTS: Readonly<DispatchWeights> = Object.freeze({
  match: 0.35,
  confidence: 0.10,
  load: 0.20,
  quality: 0.25,
  cost: 0.10,
})

export const CONFIDENCE_BANDS = Object.freeze({ AUTO: 90, SUGGESTED: 70 })
export type ConfidenceBand = 'AUTO' | 'SUGGESTED' | 'MANUAL'

export const DISPATCH_OUTCOMES = ['ACCEPTED', 'REASSIGNED', 'REWORKED', 'REJECTED', 'FIRST_PASS'] as const
export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number]

export const REASSIGN_REASONS = ['SKILL_MISMATCH', 'OVERLOADED', 'ERROR', 'OTHER'] as const
export type ReassignReason = (typeof REASSIGN_REASONS)[number]

export interface DispatchScoreInput {
  workerKind: DispatchWorkerKind
  /** M：任务所需技能与 Worker 有效技能的熟练度加权匹配度。 */
  match: number
  /** C：技能证据置信度；冷启动为 0。 */
  confidence: number
  /** L：负载比例；越低越好。 */
  load: number
  /** Q：历史质量；冷启动先验为 0.5。 */
  quality: number
  /** 成本归一化；Human 不参与该维，Agent 缺省为 0。 */
  costNorm?: number
}

export interface DispatchScoreBreakdown {
  match: number
  confidence: number
  load: number
  quality: number
  costNorm: number
  effectiveWeights: DispatchWeights
  contributions: DispatchWeights
  weightedTotal: number
}

export interface DispatchScore {
  score: number
  band: ConfidenceBand
  breakdown: DispatchScoreBreakdown
  weights: DispatchWeights
}

function unit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`dispatch: ${name} 必须在 [0,1] 内，收到 ${value}`)
  }
  return value
}

/** 五维归一化打分；Human 分支剔除 cost 后按剩余权重重归一化。 */
export function scoreCandidate(input: DispatchScoreInput, weights: DispatchWeights = DISPATCH_WEIGHTS): DispatchScore {
  if (input.workerKind !== 'human' && input.workerKind !== 'agent') {
    throw new RangeError(`dispatch: workerKind 必须是 human 或 agent，收到 ${String(input.workerKind)}`)
  }
  const match = unit(input.match, 'match')
  const confidence = unit(input.confidence, 'confidence')
  const load = unit(input.load, 'load')
  const quality = unit(input.quality, 'quality')
  const costNorm = unit(input.costNorm ?? 0, 'costNorm')
  const weightValues = [weights.match, weights.confidence, weights.load, weights.quality, weights.cost]
  const sum = weightValues.reduce((total, value) => total + value, 0)
  if (weightValues.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(sum - 1) > 1e-9 || weights.cost >= 1) {
    throw new RangeError('dispatch: 权重必须是非负且总和为 1 的闭集')
  }

  const denominator = input.workerKind === 'human' ? sum - weights.cost : sum
  const effectiveWeights: DispatchWeights = {
    match: weights.match / denominator,
    confidence: weights.confidence / denominator,
    load: weights.load / denominator,
    quality: weights.quality / denominator,
    cost: input.workerKind === 'human' ? 0 : weights.cost / denominator,
  }
  const dimensions = {
    match,
    confidence: match * confidence,
    load: 1 - load,
    quality,
  }
  const costDimension = 1 - costNorm
  const contributions: DispatchWeights = {
    match: effectiveWeights.match * dimensions.match,
    confidence: effectiveWeights.confidence * dimensions.confidence,
    load: effectiveWeights.load * dimensions.load,
    quality: effectiveWeights.quality * dimensions.quality,
    cost: effectiveWeights.cost * costDimension,
  }
  const weightedTotal = Object.values(contributions).reduce((total, value) => total + value, 0)
  const score = Math.round(Math.max(0, Math.min(100, weightedTotal * 100)))
  return {
    score,
    band: bandOf(score),
    breakdown: { ...dimensions, costNorm, effectiveWeights, contributions, weightedTotal },
    weights: { ...weights },
  }
}

export function bandOf(score: number): ConfidenceBand {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError(`dispatch: score 必须在 [0,100] 内，收到 ${score}`)
  }
  if (score >= CONFIDENCE_BANDS.AUTO) return 'AUTO'
  if (score >= CONFIDENCE_BANDS.SUGGESTED) return 'SUGGESTED'
  return 'MANUAL'
}
