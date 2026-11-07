import { artifactDigest, canonicalJSON, parseResults, type QualityCase, type QualityRun, type QualitySuite } from './schema.ts'

const ratio = (n: number, d: number): number | null => d ? n / d : null
function sum(values: number[]): number {
  const result = values.reduce((a, b) => a + b, 0)
  if (!Number.isSafeInteger(result)) throw new Error('Aggregate exceeds safe integer range')
  return result
}
/** Nearest-rank percentile; empty samples stay null, not a zero-latency run. */
export function distribution(values: number[]): { samples: number; mean: number | null; p50: number | null; p95: number | null; max: number | null } {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null
  return { samples: sorted.length, mean: ratio(sum(sorted), sorted.length), p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) ?? null }
}

function summarize(cases: QualityCase[], runs: QualityRun[]) {
  const expected = new Map(cases.map(c => [c.id, canonicalJSON(c.expected)]))
  const judged = runs.map(run => {
    const attempts = run.submissions.map(s => ({ attempt: s.attempt, correct: canonicalJSON(s.artifact) === expected.get(run.case_id), decision: s.review?.decision ?? 'unavailable' }))
    const final = attempts.at(-1)
    return { run, attempts, success: run.execution.state === 'completed' && final?.correct === true && final.decision === 'approve', duration: Date.parse(run.execution.finished_at) - Date.parse(run.execution.started_at) }
  })
  const decisions = judged.flatMap(item => item.attempts).filter(item => item.decision !== 'unavailable')
  const tp = decisions.filter(item => item.correct && item.decision === 'approve').length
  const fp = decisions.filter(item => !item.correct && item.decision === 'approve').length
  const tn = decisions.filter(item => !item.correct && item.decision === 'reject').length
  const fn = decisions.filter(item => item.correct && item.decision === 'reject').length
  const successes = judged.filter(item => item.success)
  const knownCosts = runs.flatMap(run => run.cost.microusd === null ? [] : [run.cost.microusd])
  const knownTotal = sum(knownCosts)
  const trialsByCase = cases.map(c => ({ case_id: c.id, trials: judged.filter(item => item.run.case_id === c.id).length, successes: successes.filter(item => item.run.case_id === c.id).length }))
  return {
    coverage: { suite_cases: cases.length, observed_cases: trialsByCase.filter(c => c.trials > 0).length, missing_case_ids: trialsByCase.filter(c => c.trials === 0).map(c => c.case_id), balanced_repetitions: trialsByCase.length && trialsByCase[0]!.trials > 0 && trialsByCase.every(c => c.trials === trialsByCase[0]!.trials) ? trialsByCase[0]!.trials : null, trials_by_case: trialsByCase },
    tasks: {
      trials: runs.length, succeeded: successes.length, failed_quality_or_execution: runs.length - successes.length,
      execution_states: Object.fromEntries(['completed', 'failed', 'cancelled', 'uncertain'].map(state => [state, runs.filter(run => run.execution.state === state).length])),
      success_rate_observed: ratio(successes.length, runs.length),
      first_pass_success_rate: ratio(successes.filter(item => item.attempts.length === 1).length, runs.length),
    },
    review: {
      submissions: judged.flatMap(item => item.attempts).length, decided: decisions.length,
      unavailable: judged.flatMap(item => item.attempts).length - decisions.length,
      true_approvals: tp, false_approvals: fp, true_rejections: tn, false_rejections: fn,
      false_approval_rate: ratio(fp, fp + tn),
      defective_fraction_of_approvals: ratio(fp, tp + fp),
      false_rejection_rate: ratio(fn, tp + fn),
      approval_precision: ratio(tp, tp + fp),
      approval_recall: ratio(tp, tp + fn),
      decision_coverage: ratio(decisions.length, judged.flatMap(item => item.attempts).length),
    },
    rework: {
      trials_with_rework: judged.filter(item => item.attempts.length > 1).length,
      additional_submissions: sum(judged.map(item => Math.max(0, item.attempts.length - 1))),
      rate: ratio(judged.filter(item => item.attempts.length > 1).length, runs.length),
      mean_additional_submissions: ratio(sum(judged.map(item => Math.max(0, item.attempts.length - 1))), runs.length),
    },
    cost: {
      unit: 'microUSD', measured_trials: knownCosts.length, missing_trials: runs.length - knownCosts.length,
      coverage: ratio(knownCosts.length, runs.length), total_known_microusd: knownTotal,
      mean_measured_microusd: ratio(knownTotal, knownCosts.length),
      // Include costs of failed attempts/trials; dividing successful-run cost
      // alone hides the cost of reaching those successes. Missing cost forbids
      // this aggregate instead of making a more efficient-looking estimate.
      total_microusd: knownCosts.length === runs.length && runs.length > 0 ? knownTotal : null,
      microusd_per_success: knownCosts.length === runs.length ? ratio(knownTotal, successes.length) : null,
    },
    latency_ms: { all_terminal_trials: distribution(judged.map(item => item.duration)), successful_trials: distribution(successes.map(item => item.duration)) },
  }
}

/** Shape validation and exact-oracle scoring never authenticate imported
 * evidence, supplier availability, or production review compliance. */
export function scoreResults(suite: QualitySuite, input: unknown) {
  const results = parseResults(input, suite)
  const keys = [...new Set(results.runs.map(run => JSON.stringify([run.source, run.configuration.id])))].sort()
  return {
    schema_version: 'lumo-team-quality-report/v1', suite_id: suite.id, suite_revision: suite.revision, suite_digest: results.suite_digest, observations_digest: artifactDigest(results),
    evidence_status: 'imported-observations-not-independently-attested',
    input_trials: results.runs.length,
    groups: keys.map(key => {
      const [source, configurationId] = JSON.parse(key) as [QualityRun['source'], string]
      const runs = results.runs.filter(run => run.source === source && run.configuration.id === configurationId)
      return {
        source, configuration: runs[0]!.configuration, metrics: summarize(suite.cases, runs),
        by_category: Object.fromEntries(['business', 'adversarial'].map(category => {
          const cases = suite.cases.filter(c => c.category === category), ids = new Set(cases.map(c => c.id))
          return [category, summarize(cases, runs.filter(run => ids.has(run.case_id)))]
        })),
        trials: runs.map(run => ({
          case_id: run.case_id, trial_id: run.trial_id, state: run.execution.state,
          attempts: run.submissions.map(s => ({ attempt: s.attempt, run_id: s.run_id, oracle_pass: canonicalJSON(s.artifact) === canonicalJSON(suite.cases.find(c => c.id === run.case_id)!.expected), review: s.review?.decision ?? 'unavailable' })),
        })),
      }
    }),
  }
}
