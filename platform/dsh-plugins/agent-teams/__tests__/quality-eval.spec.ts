import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactDigest, canonicalJSON, parseResults, parseSuite, publicTasks, suiteDigest, type QualityResults, type QualityRun, type Submission } from '../eval/schema.ts'
import { distribution, scoreResults } from '../eval/metrics.ts'
import { evaluateCLI, readJSON } from '../eval/run-eval.ts'

const suite = parseSuite(JSON.parse(readFileSync(new URL('../eval/golden.zh.json', import.meta.url), 'utf8')))
const base = Date.parse('2026-11-07T00:00:00.000Z')
const at = (ms: number) => new Date(base + ms).toISOString()
let serial = 0
function submission(artifact: Submission['artifact'], decision: 'approve' | 'reject' | 'unavailable' | null = 'approve', attempt = 1): Submission {
  const digest = artifactDigest(artifact)
  return { attempt, run_id: `run-${++serial}`, submitted_at: at(attempt * 10), artifact, artifact_digest: digest,
    review: decision === null ? null : { decision, artifact_digest: digest, decided_at: at(attempt * 10 + 1), provider: 'test-review-provider', model: 'test-review-model', evidence_refs: [`fixture:review/${serial}`] } }
}
function run(patch: Partial<QualityRun> = {}): QualityRun {
  return { case_id: suite.cases[0]!.id, trial_id: `trial-${++serial}`, source: 'fixture',
    configuration: { id: 'baseline', topology: 'planner-worker', members: [{ role: 'worker', provider: 'test-provider', model: 'test-model', preset_revision: 1 }, { role: 'reviewer', provider: 'test-review-provider', model: 'test-review-model', preset_revision: 1 }] },
    execution: { state: 'completed', started_at: at(0), finished_at: at(100), evidence_refs: ['fixture:execution'] },
    submissions: [submission(suite.cases[0]!.expected)], cost: { microusd: 100, evidence_refs: ['fixture:ledger'] }, ...patch }
}
function results(runs: QualityRun[]): QualityResults {
  return { schema_version: 'lumo-team-quality-results/v1', suite_id: suite.id, suite_revision: suite.revision, suite_digest: suiteDigest(suite), runs }
}
function score(runs: QualityRun[]) { return scoreResults(suite, results(runs)).groups[0]!.metrics }

describe('Agent Team business evaluation corpus', () => {
  it('covers all supported topologies and separates business work from adversarial interference', () => {
    expect(suite.cases).toHaveLength(16)
    expect(suite.cases.filter(c => c.category === 'business')).toHaveLength(8)
    expect(suite.cases.filter(c => c.category === 'adversarial')).toHaveLength(8)
    expect(new Set(suite.cases.map(c => c.topology))).toEqual(new Set(['planner-worker', 'pipeline', 'deliberation']))
    for (const c of suite.cases) {
      expect(c.context.length).toBeGreaterThan(0)
      expect(c.output_contract).toContain('JSON')
    }
    // Calibrate representative business ground truth independently of scoreRun.
    expect(suite.cases.find(c => c.id === 'revenue-reconciliation')!.expected).toMatchObject({ net: [{ currency: 'EUR', cents: 8000 }, { currency: 'USD', cents: 10000 + 2500 - 3000 }] })
    expect(suite.cases.find(c => c.id === 'critical-path')!.expected).toEqual({ finish_minutes: 4 + Math.max(7, 3) + 2, critical_path: ['A', 'B', 'D'] })
    expect(suite.cases.find(c => c.id === 'untrusted-source-injection')!.expected).toEqual({ available_cents: 100000 - 87000 - 9000, source_ids: ['finance'] })
  })

  it('withholds oracle answers from exported participant/reviewer tasks and binds revisions by digest', () => {
    const exported = publicTasks(suite) as { cases: Record<string, unknown>[]; suite_digest: string }
    expect(exported.cases.every(c => !Object.hasOwn(c, 'expected'))).toBe(true)
    expect(exported.suite_digest).toBe(suiteDigest(suite))
    const changed = structuredClone(suite); changed.cases[0]!.expected = { net: [] }
    expect(suiteDigest(changed)).not.toBe(suiteDigest(suite))
    expect(() => parseResults(results([]), changed)).toThrow('mismatch')
  })
})

describe('strict observation schema', () => {
  it('binds reviews to actual structured artifacts and requires durable evidence and terminal clocks', () => {
    for (const mutate of [
      (r: QualityRun) => { r.submissions[0]!.artifact = { forged: true } },
      (r: QualityRun) => { r.submissions[0]!.review!.artifact_digest = 'a'.repeat(64) },
      (r: QualityRun) => { r.execution.evidence_refs = [] },
      (r: QualityRun) => { r.submissions[0]!.review!.evidence_refs = [] },
      (r: QualityRun) => { r.submissions[0]!.review!.model = 'undeclared-model' },
      (r: QualityRun) => { r.cost.evidence_refs = [] },
      (r: QualityRun) => { r.execution.finished_at = '2026-02-30T00:00:00.000Z' },
      (r: QualityRun) => { r.execution.finished_at = '2026-11-07T00:00:00Z' },
      (r: QualityRun) => { r.execution.finished_at = at(-1) },
      (r: QualityRun) => { r.submissions[0]!.submitted_at = at(101) },
      (r: QualityRun) => { r.submissions[0]!.review!.decided_at = at(9) },
      (r: QualityRun) => { r.cost.microusd = -1 },
      (r: QualityRun) => { r.cost.microusd = 0.1 },
      (r: QualityRun) => { r.cost.microusd = Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const r = run(); mutate(r)
      expect(() => parseResults(results([r]), suite)).toThrow()
    }
    const observed = run({ cost: { microusd: 0, evidence_refs: ['fixture:measured-zero'] } })
    expect(parseResults(results([observed]), suite).runs[0]!.cost.microusd).toBe(0)
  })

  it('rejects duplicate trials/run IDs, configuration drift, unknown cases/fields and omitted attempts', () => {
    const a = run()
    expect(() => parseResults(results([a, structuredClone(a)]), suite)).toThrow('duplicate trial')
    const b = run(); b.submissions[0]!.run_id = a.submissions[0]!.run_id
    expect(() => parseResults(results([a, b]), suite)).toThrow('counted more than once')
    const drift = run(); drift.configuration.members[0]!.model = 'changed'
    expect(() => parseResults(results([a, drift]), suite)).toThrow('configuration id reused')
    for (const patch of [{ case_id: 'unknown' }, { source: 'production-certified' }, { injected_score: 1 }, { submissions: [{ ...submission(null), attempt: 2 }] }]) {
      expect(() => parseResults(results([{ ...run(), ...patch } as QualityRun]), suite)).toThrow()
    }
    const reordered = run({ submissions: [submission({}, 'reject'), submission({}, 'approve', 2)] })
    reordered.submissions[1]!.submitted_at = at(5)
    expect(() => parseResults(results([reordered]), suite)).toThrow('order')
  })

  it('rejects malformed suite identities and JSON values instead of silently coercing them', () => {
    for (const value of [undefined, NaN, Infinity, { omitted: undefined }, new Date(), Array(1)]) expect(() => canonicalJSON(value)).toThrow()
    expect(canonicalJSON({ b: 2, a: [1, null] })).toBe('{"a":[1,null],"b":2}')
    expect(artifactDigest({ b: 2, a: 1 })).toBe(artifactDigest({ a: 1, b: 2 }))
    const c = structuredClone(suite); c.cases.push(c.cases[0]!)
    expect(() => parseSuite(c)).toThrow('duplicate')
    const unknown = { ...suite, scores: 1 }
    expect(() => parseSuite(unknown)).toThrow('unknown')
  })
})

describe('outcome, review, rework, cost and latency metrics', () => {
  it('computes every confusion cell against the oracle, including a confidently approved wrong answer', () => {
    const good = suite.cases[0]!.expected
    const m = score([
      run({ submissions: [submission(good, 'approve')] }),
      run({ submissions: [submission({ net: 'wrong' }, 'approve')] }),
      run({ submissions: [submission({ net: 'wrong' }, 'reject')] }),
      run({ submissions: [submission(good, 'reject')] }),
      run({ submissions: [submission(good, null)] }),
      run({ submissions: [submission(good, 'unavailable')] }),
    ])
    expect(m.tasks).toMatchObject({ trials: 6, succeeded: 1, failed_quality_or_execution: 5, success_rate_observed: 1 / 6 })
    expect(m.review).toMatchObject({ true_approvals: 1, false_approvals: 1, true_rejections: 1, false_rejections: 1, unavailable: 2, false_approval_rate: 0.5, defective_fraction_of_approvals: 0.5, false_rejection_rate: 0.5, approval_precision: 0.5, approval_recall: 0.5, decision_coverage: 4 / 6 })
  })

  it('counts actual re-submissions and all failure costs, rather than averaging successful costs only', () => {
    const a = run({ submissions: [submission({}, 'reject'), submission(suite.cases[0]!.expected, 'approve', 2)], cost: { microusd: 300, evidence_refs: ['fixture:ledger'] } })
    const b = run({ execution: { ...a.execution, state: 'failed', finished_at: at(500) }, submissions: [], cost: { microusd: 200, evidence_refs: ['fixture:ledger-failure'] } })
    const m = score([a, b])
    expect(m.tasks).toMatchObject({ succeeded: 1, first_pass_success_rate: 0 })
    expect(m.rework).toEqual({ trials_with_rework: 1, additional_submissions: 1, rate: 0.5, mean_additional_submissions: 0.5 })
    expect(m.cost).toMatchObject({ total_microusd: 500, microusd_per_success: 500, coverage: 1 })
    expect(m.latency_ms.all_terminal_trials).toEqual({ samples: 2, mean: 300, p50: 100, p95: 500, max: 500 })
    expect(m.latency_ms.successful_trials.samples).toBe(1)
  })

  it('never turns unknown costs, unavailable reviews or missing cases into zero or a full-suite pass', () => {
    const r = run({ cost: { microusd: null, evidence_refs: [] }, submissions: [submission({}, null)] })
    const m = score([r])
    expect(m.cost).toMatchObject({ measured_trials: 0, missing_trials: 1, total_microusd: null, mean_measured_microusd: null, microusd_per_success: null })
    expect(m.review.false_approval_rate).toBeNull()
    expect(m.coverage).toMatchObject({ suite_cases: 16, observed_cases: 1, balanced_repetitions: null })
    expect(m.coverage.missing_case_ids).toHaveLength(15)
    expect(distribution([])).toEqual({ samples: 0, mean: null, p50: null, p95: null, max: null })
    const partial = score([run(), r])
    expect(partial.cost).toMatchObject({ total_known_microusd: 100, coverage: 0.5, total_microusd: null, microusd_per_success: null })
  })

  it('keeps fixtures and imported recordings separate, reports category coverage and never attests provenance', () => {
    const fixture = run(), recorded = run({ source: 'recorded', case_id: suite.cases[8]!.id, submissions: [submission(suite.cases[8]!.expected)] })
    const report = scoreResults(suite, results([fixture, recorded]))
    expect(report.evidence_status).toBe('imported-observations-not-independently-attested')
    expect(report.groups.map(group => group.source)).toEqual(['fixture', 'recorded'])
    expect(report.groups[0]!.metrics.tasks.trials).toBe(1)
    expect(report.groups[1]!.by_category.adversarial!.tasks.succeeded).toBe(1)
    expect(report.groups[1]!.by_category.business!.tasks.success_rate_observed).toBeNull()
    expect(scoreResults(suite, results([])).groups).toEqual([])
  })

  it('counts cancelled and uncertain work as observed failures and rejects unsafe cost sums', () => {
    for (const state of ['cancelled', 'uncertain'] as const) {
      expect(score([run({ execution: { ...run().execution, state } })]).tasks.succeeded).toBe(0)
    }
    expect(() => score([run({ cost: { microusd: Number.MAX_SAFE_INTEGER, evidence_refs: ['fixture:ledger'] } }), run()])).toThrow('safe integer')
  })
})

describe('offline evaluator CLI', () => {
  const directories: string[] = []
  afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  function file(name: string, body: string | Uint8Array) {
    const dir = mkdtempSync(join(tmpdir(), 'lumo-team-quality-')); directories.push(dir)
    const path = join(dir, name); writeFileSync(path, body); return path
  }
  it('validates the corpus, exports blind tasks and scores only explicitly supplied observations', () => {
    expect(evaluateCLI(['validate'])).toMatchObject({ cases: 16, evaluated_trials: 0 })
    expect(evaluateCLI(['template'])).toEqual(results([]))
    const observations = file('observations.json', JSON.stringify(results([run()])))
    expect(evaluateCLI(['score', '--results', observations])).toMatchObject({ input_trials: 1 })
    expect(evaluateCLI(['tasks'])).toEqual(publicTasks(suite))
  })
  it('fails malformed options, UTF-8, oversized input and directories without executing anything', () => {
    for (const args of [[], ['run'], ['score'], ['tasks', '--results', 'x'], ['validate', '--suite'], ['validate', '--suite', 'a', '--suite', 'b'], ['score', '--shell', 'x']]) expect(() => evaluateCLI(args)).toThrow()
    const invalid = file('invalid.json', new Uint8Array([0xff, 0xfe])); expect(() => readJSON(invalid)).toThrow()
    const large = file('large.json', ' '.repeat(16 * 1024 * 1024 + 1)); expect(() => readJSON(large)).toThrow('16 MiB')
    expect(() => readJSON(directories[0]!)).toThrow('regular file')
  })
})
