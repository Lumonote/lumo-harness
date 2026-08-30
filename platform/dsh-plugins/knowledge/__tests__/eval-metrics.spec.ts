import { describe, expect, it } from 'vitest'

import { scoreRun } from '../eval/metrics.ts'

describe('scoreRun', () => {
  it('reports a perfect run when the expected doc is always first', () => {
    const m = scoreRun([
      { expected: ['a'], ranked: ['a', 'x', 'y'] },
      { expected: ['b'], ranked: ['b', 'x', 'y'] },
    ])

    expect(m.recallAt1).toBe(1)
    expect(m.mrr).toBe(1)
    expect(m.ndcgAt5).toBe(1)
  })

  it('scores zero when nothing relevant is retrieved', () => {
    const m = scoreRun([{ expected: ['a'], ranked: ['x', 'y', 'z'] }])

    expect(m.recallAt5).toBe(0)
    expect(m.mrr).toBe(0)
    expect(m.ndcgAt5).toBe(0)
  })

  it('separates recall at 1 from recall at 3 when the hit sits at rank 3', () => {
    const m = scoreRun([{ expected: ['a'], ranked: ['x', 'y', 'a'] }])

    expect(m.recallAt1).toBe(0)
    expect(m.recallAt3).toBe(1)
    // 第 3 位 → 1/3
    expect(m.mrr).toBeCloseTo(1 / 3, 10)
  })

  it('counts the fraction of expected docs when a case has several', () => {
    // 两个期望出处，前 3 条只命中一个 → recall@3 = 0.5
    const m = scoreRun([{ expected: ['a', 'b'], ranked: ['a', 'x', 'y', 'b'] }])

    expect(m.recallAt3).toBe(0.5)
    expect(m.recallAt5).toBe(1)
  })

  it('rewards ranking the relevant doc higher', () => {
    const first = scoreRun([{ expected: ['a'], ranked: ['a', 'x', 'y'] }])
    const third = scoreRun([{ expected: ['a'], ranked: ['x', 'y', 'a'] }])

    // 同样召回到，但排得靠前的 nDCG 更高 —— 这正是 rerank 要改善的量。
    expect(first.ndcgAt5).toBeGreaterThan(third.ndcgAt5)
  })

  it('averages across cases instead of reporting only the last one', () => {
    const m = scoreRun([
      { expected: ['a'], ranked: ['a'] },
      { expected: ['b'], ranked: ['x'] },
    ])

    expect(m.recallAt1).toBe(0.5)
    expect(m.mrr).toBe(0.5)
  })
})
