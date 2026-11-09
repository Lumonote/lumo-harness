import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { artifactDigest, parseSuite, suiteDigest, type QualityResults } from '../eval/schema.ts'
import { evaluateQualityGate, parseQualityPolicy, type QualityPolicy } from '../eval/gate.ts'

const suite = parseSuite(JSON.parse(readFileSync(new URL('../eval/golden.zh.json', import.meta.url), 'utf8')))
function observations(id = 'candidate', count = 3, cost = 100): QualityResults {
  const configuration = { id, topology: 'planner-worker' as const, members: [{ role: 'reviewer', provider: 'recorded-provider', model: 'model-v1', preset_revision: 1 }] }
  return { schema_version: 'lumo-team-quality-results/v1', suite_id: suite.id, suite_revision: suite.revision, suite_digest: suiteDigest(suite),
    runs: suite.cases.flatMap(c => Array.from({ length: count }, (_, i) => ({
      case_id: c.id, trial_id: `${id}-${c.id}-${i}`, source: 'recorded' as const, configuration,
      execution: { state: 'completed' as const, started_at: '2026-11-09T00:00:00.000Z', finished_at: '2026-11-09T00:00:01.000Z', evidence_refs: ['test-only:execution'] },
      submissions: [{ attempt: 1, run_id: `${id}-${c.id}-${i}`, submitted_at: '2026-11-09T00:00:00.500Z', artifact: c.expected, artifact_digest: artifactDigest(c.expected), review: { decision: 'approve' as const, artifact_digest: artifactDigest(c.expected), decided_at: '2026-11-09T00:00:00.600Z', provider: 'recorded-provider', model: 'model-v1', evidence_refs: ['test-only:review'] } }],
      cost: { microusd: cost, evidence_refs: ['test-only:ledger'] },
    }))) }
}
function policy(results: QualityResults): QualityPolicy {
  return { schema_version: 'lumo-team-quality-policy/v1', suite_digest: suiteDigest(suite), configuration_id: 'candidate', configuration_digest: artifactDigest(results.runs[0]!.configuration), min_repetitions: 3, min_success_rate: 0.9, max_defective_approval_fraction: 0, max_rework_rate: 0.1, max_p95_ms: 1200, max_microusd_per_success: 150, baseline: null }
}

describe('recorded quality release gate (synthetic observations only)', () => {
  it('requires the entire suite, balanced repetitions, exact configuration and complete costs', () => {
    const results = observations(), p = policy(results)
    expect(evaluateQualityGate(suite, results, p).passed).toBe(true)
    for (const change of [
      (r: QualityResults) => { r.runs.pop() },
      (r: QualityResults) => { r.runs.forEach(run => { run.source = 'fixture' }) },
      (r: QualityResults) => { r.runs[0]!.cost = { microusd: null, evidence_refs: [] } },
      (r: QualityResults) => { r.runs.forEach(run => { run.configuration.members[0]!.model = 'changed'; run.submissions[0]!.review!.model = 'changed' }) },
    ]) {
      const changed = structuredClone(results); change(changed)
      expect(evaluateQualityGate(suite, changed, p).passed).toBe(false)
    }
    expect(evaluateQualityGate(suite, observations('candidate', 2), p).passed).toBe(false)
    expect(() => evaluateQualityGate(suite, results, { ...p, suite_digest: 'f'.repeat(64) })).toThrow('suite digest')
  })
  it('keeps bad approvals and failed execution costs in the release decision', () => {
    const r = observations(), p = policy(r)
    r.runs[0]!.submissions[0]!.artifact = { incorrect: true }
    r.runs[0]!.submissions[0]!.artifact_digest = artifactDigest({ incorrect: true })
    r.runs[0]!.submissions[0]!.review!.artifact_digest = artifactDigest({ incorrect: true })
    const result = evaluateQualityGate(suite, r, p)
    expect(result.passed).toBe(false)
    expect(result.checks.find(c => c.name === 'candidate.defective_approval_fraction')?.passed).toBe(false)
    expect(evaluateQualityGate(suite, observations('candidate', 3, 200), p).passed).toBe(false)
  })
  it('compares full recorded baselines without hiding mismatched samples or missing baseline data', () => {
    const candidate = observations(), baseline = observations('baseline'), p = policy(candidate)
    p.baseline = { configuration_id: 'baseline', configuration_digest: artifactDigest(baseline.runs[0]!.configuration), max_success_rate_drop: 0, max_cost_ratio: 1.1, max_latency_ratio: 1.1 }
    expect(evaluateQualityGate(suite, candidate, p, baseline).passed).toBe(true)
    expect(evaluateQualityGate(suite, candidate, p, observations('baseline', 4)).passed).toBe(false)
    expect(evaluateQualityGate(suite, candidate, p, observations('baseline', 3, 50)).passed).toBe(false)
    expect(() => evaluateQualityGate(suite, candidate, p)).toThrow('Baseline')
    p.baseline = null
    expect(() => evaluateQualityGate(suite, candidate, p, baseline)).toThrow('Baseline')
  })
  it('rejects malformed policies and returns nonzero for an insufficient CLI sample', () => {
    const r = observations(), p = policy(r)
    for (const changed of [{ ...p, min_repetitions: 0 }, { ...p, max_p95_ms: NaN }, { ...p, configuration_digest: '' }, { ...p, min_success_rate: 2 }, { ...p, unknown: true }]) expect(() => parseQualityPolicy(changed)).toThrow()
    const directory = mkdtempSync(join(tmpdir(), 'lumo-quality-gate-'))
    try {
      const results = join(directory, 'results.json'), limits = join(directory, 'policy.json')
      writeFileSync(results, JSON.stringify({ ...r, runs: [] })); writeFileSync(limits, JSON.stringify(p))
      const cli = spawnSync(process.execPath, ['--import', 'tsx', new URL('../eval/run-eval.ts', import.meta.url).pathname, 'gate', '--results', results, '--policy', limits], { encoding: 'utf8', cwd: new URL('../', import.meta.url) })
      expect(cli.status, cli.stderr).toBe(2)
      expect(JSON.parse(cli.stdout)).toMatchObject({ passed: false, evidence_status: 'imported-observations-not-independently-attested' })
    } finally { rmSync(directory, { force: true, recursive: true }) }
  })
})
