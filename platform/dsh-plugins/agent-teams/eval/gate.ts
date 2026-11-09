import { artifactDigest, parseResults, type QualitySuite } from './schema.ts'
import { scoreResults } from './metrics.ts'

export interface QualityPolicy {
  schema_version: 'lumo-team-quality-policy/v1'
  suite_digest: string
  configuration_id: string
  configuration_digest: string
  min_repetitions: number
  min_success_rate: number
  max_defective_approval_fraction: number
  max_rework_rate: number
  max_p95_ms: number
  max_microusd_per_success: number
  baseline: null | {
    configuration_id: string
    configuration_digest: string
    max_success_rate_drop: number
    max_cost_ratio: number
    max_latency_ratio: number
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Quality policy must be an object')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error('Missing or unknown quality policy field')
}
function bounded(value: unknown, name: string, min: number, max: number, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) throw new Error(`Invalid quality policy ${name}`)
}
function identity(value: Record<string, unknown>): void {
  if (typeof value.configuration_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.configuration_id) || typeof value.configuration_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.configuration_digest)) throw new Error('Quality policy must bind exact configuration ID and digest')
}
export function parseQualityPolicy(input: unknown): QualityPolicy {
  const policy = record(input)
  exact(policy, ['schema_version', 'suite_digest', 'configuration_id', 'configuration_digest', 'min_repetitions', 'min_success_rate', 'max_defective_approval_fraction', 'max_rework_rate', 'max_p95_ms', 'max_microusd_per_success', 'baseline'])
  if (policy.schema_version !== 'lumo-team-quality-policy/v1') throw new Error('Unsupported quality policy')
  identity(policy)
  if (typeof policy.suite_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(policy.suite_digest)) throw new Error('Quality policy must bind exact suite digest')
  bounded(policy.min_repetitions, 'min_repetitions', 1, 10000, true)
  for (const key of ['min_success_rate', 'max_defective_approval_fraction', 'max_rework_rate']) bounded(policy[key], key, 0, 1)
  for (const key of ['max_p95_ms', 'max_microusd_per_success']) bounded(policy[key], key, 0, Number.MAX_SAFE_INTEGER, true)
  if (policy.baseline !== null) {
    const baseline = record(policy.baseline)
    exact(baseline, ['configuration_id', 'configuration_digest', 'max_success_rate_drop', 'max_cost_ratio', 'max_latency_ratio'])
    identity(baseline)
    bounded(baseline.max_success_rate_drop, 'max_success_rate_drop', 0, 1)
    bounded(baseline.max_cost_ratio, 'max_cost_ratio', 0, 1000)
    bounded(baseline.max_latency_ratio, 'max_latency_ratio', 0, 1000)
  }
  return structuredClone(policy) as unknown as QualityPolicy
}

/** Recompute metrics from strict observations. A passing gate validates the
 * imported observations against policy; it does not attest their provenance. */
export function evaluateQualityGate(suite: QualitySuite, input: unknown, policyInput: unknown, baselineInput?: unknown) {
  const policy = parseQualityPolicy(policyInput)
  if ((policy.baseline !== null) !== (baselineInput !== undefined)) throw new Error('Baseline observations must match policy baseline requirement')
  const results = parseResults(input, suite)
  if (results.suite_digest !== policy.suite_digest) throw new Error('Policy suite digest mismatch')
  const report = scoreResults(suite, results)
  const checks: Array<{ name: string; passed: boolean; actual: number | string | null; required: number | string }> = []
  const check = (name: string, passed: boolean, actual: number | string | null, required: number | string) => checks.push({ name, passed, actual, required })
  function select(value: ReturnType<typeof scoreResults>, id: string, digest: string, prefix: string) {
    const group = value.groups.find(g => g.source === 'recorded' && g.configuration.id === id)
    check(prefix + '.recorded_configuration', group !== undefined, group ? id : null, id)
    if (!group) return undefined
    check(prefix + '.configuration_digest', artifactDigest(group.configuration) === digest, artifactDigest(group.configuration), digest)
    const m = group.metrics
    const repetitions = m.coverage.balanced_repetitions
    check(prefix + '.balanced_repetitions', repetitions !== null && repetitions >= policy.min_repetitions, repetitions, policy.min_repetitions)
    check(prefix + '.cost_coverage', m.cost.coverage === 1, m.cost.coverage, 1)
    // Both sources remain in the score report, but fixture evidence can never
    // satisfy the recorded group or inflate the release sample count.
    return m
  }
  const metrics = select(report, policy.configuration_id, policy.configuration_digest, 'candidate')
  if (metrics) {
    check('candidate.success_rate', metrics.tasks.success_rate_observed !== null && metrics.tasks.success_rate_observed >= policy.min_success_rate, metrics.tasks.success_rate_observed, policy.min_success_rate)
    check('candidate.defective_approval_fraction', metrics.review.defective_fraction_of_approvals !== null && metrics.review.defective_fraction_of_approvals <= policy.max_defective_approval_fraction, metrics.review.defective_fraction_of_approvals, policy.max_defective_approval_fraction)
    check('candidate.rework_rate', metrics.rework.rate !== null && metrics.rework.rate <= policy.max_rework_rate, metrics.rework.rate, policy.max_rework_rate)
    check('candidate.p95_ms', metrics.latency_ms.all_terminal_trials.p95 !== null && metrics.latency_ms.all_terminal_trials.p95 <= policy.max_p95_ms, metrics.latency_ms.all_terminal_trials.p95, policy.max_p95_ms)
    check('candidate.microusd_per_success', metrics.cost.microusd_per_success !== null && metrics.cost.microusd_per_success <= policy.max_microusd_per_success, metrics.cost.microusd_per_success, policy.max_microusd_per_success)
  }
  let baselineReport: ReturnType<typeof scoreResults> | undefined
  if (policy.baseline) {
    baselineReport = scoreResults(suite, baselineInput)
    const baseline = select(baselineReport, policy.baseline.configuration_id, policy.baseline.configuration_digest, 'baseline')
    if (metrics && baseline) {
      const sameTrials = JSON.stringify(metrics.coverage.trials_by_case.map(c => [c.case_id, c.trials])) === JSON.stringify(baseline.coverage.trials_by_case.map(c => [c.case_id, c.trials]))
      check('comparison.same_case_counts', sameTrials, sameTrials ? 'equal' : 'different', 'equal')
      const a = metrics.tasks.success_rate_observed, b = baseline.tasks.success_rate_observed
      check('comparison.success_rate_drop', a !== null && b !== null && b - a <= policy.baseline.max_success_rate_drop, a !== null && b !== null ? b - a : null, policy.baseline.max_success_rate_drop)
      for (const [name, candidate, previous, limit] of [
        ['cost', metrics.cost.microusd_per_success, baseline.cost.microusd_per_success, policy.baseline.max_cost_ratio],
        ['latency', metrics.latency_ms.all_terminal_trials.p95, baseline.latency_ms.all_terminal_trials.p95, policy.baseline.max_latency_ratio],
      ] as const) {
        // Zero baseline permits only a zero candidate. Missing data never
        // becomes a free or zero-latency success.
        const ratio = candidate === null || previous === null ? null : previous === 0 ? candidate === 0 ? 1 : null : candidate / previous
        check('comparison.' + name + '_ratio', ratio !== null && ratio <= limit, ratio, limit)
      }
    }
  }
  return {
    schema_version: 'lumo-team-quality-gate/v1', passed: checks.every(c => c.passed),
    evidence_status: report.evidence_status, policy_digest: artifactDigest(policy),
    suite_digest: report.suite_digest, observations_digest: report.observations_digest,
    baseline_observations_digest: baselineReport?.observations_digest ?? null,
    checks, report, baseline_report: baselineReport ?? null,
  }
}
