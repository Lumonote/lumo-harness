import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { integrationVerdict, reviewerEligibility, type ReviewerFacts } from '../coordinator.ts'

const path = new URL('./fixtures/coordinator-review-matrix.json', import.meta.url)
const pairs = [[undefined, undefined], ['same', 'same'], ['a', 'b'], ['a', undefined], ['', 'b'], [' ', 'b']] as const

function matrix() {
  const review = []
  for (const preset of pairs) for (const model of pairs) for (const node of pairs) {
    for (const affectedArtifacts of [-1, 0, 2, 3, 4]) for (const self of [false, true]) {
      const facts: ReviewerFacts = { dispatcher: 'dispatcher', reviewer: self ? 'dispatcher' : 'reviewer', affectedArtifacts,
        dispatcherPreset: preset[0], reviewerPreset: preset[1], dispatcherModel: model[0], reviewerModel: model[1],
        dispatcherNode: node[0], reviewerNode: node[1] }
      review.push({ facts, verdict: reviewerEligibility(facts) })
    }
  }
  for (const facts of [
    { dispatcher: '', reviewer: 'r', affectedArtifacts: 0 },
    { dispatcher: 'd', reviewer: ' ', affectedArtifacts: 0 },
    { dispatcher: 'd', reviewer: 'r', affectedArtifacts: Number.MAX_SAFE_INTEGER },
    { dispatcher: 'd', reviewer: 'r', affectedArtifacts: Number.MAX_SAFE_INTEGER + 1 },
  ]) review.push({ facts, verdict: reviewerEligibility(facts) })
  const integration = [false, true].flatMap(contractTestsPass => [false, true].map(smokePass => {
    const facts = { contractTestsPass, smokePass }
    return { facts, verdict: integrationVerdict(facts) }
  }))
  return { source: 'platform/shared/seam-contracts/__tests__/coordinator-matrix.spec.ts', review, integration }
}

it('§24.7/§24.8 跨语言矩阵覆盖缺省、空白、三维异构、主体和影响面边界，不允许陈旧真值', () => {
  const current = matrix()
  expect(current.review).toHaveLength(6 ** 3 * 5 * 2 + 4)
  expect(current.integration).toHaveLength(4)
  const serialized = JSON.stringify(current) + '\n'
  if (process.env.UPDATE_COORDINATOR_MATRIX === '1') writeFileSync(path, serialized)
  expect(readFileSync(path, 'utf8')).toBe(serialized)
})
