import { createHash } from 'node:crypto'
import { TOPOLOGIES, type Topology } from '../src/model.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface QualityCase {
  id: string
  title: string
  category: 'business' | 'adversarial'
  topology: Topology
  task: string
  context: Array<{ id: string; text: string }>
  output_contract: string
  expected: Json
}
export interface QualitySuite {
  schema_version: 'lumo-team-quality-suite/v1'
  id: string
  revision: number
  cases: QualityCase[]
}
export interface Configuration {
  id: string
  topology: Topology
  members: Array<{ role: string; provider: string; model: string; preset_revision: number }>
}
export interface Submission {
  attempt: number
  run_id: string
  submitted_at: string
  /** Parsed final structured answer, not a model-supplied correctness flag. */
  artifact: Json
  artifact_digest: string
  review: null | {
    decision: 'approve' | 'reject' | 'unavailable'
    artifact_digest: string
    decided_at: string
    provider: string
    model: string
    evidence_refs: string[]
  }
}
export interface QualityRun {
  case_id: string
  trial_id: string
  source: 'fixture' | 'recorded'
  configuration: Configuration
  execution: {
    state: 'completed' | 'failed' | 'cancelled' | 'uncertain'
    started_at: string
    finished_at: string
    evidence_refs: string[]
  }
  submissions: Submission[]
  /** Whole-trial ledger total, including coordinator, all members, reviews and
   * retries. null means unavailable/incomplete, never a measured zero. */
  cost: { microusd: number | null; evidence_refs: string[] }
}
export interface QualityResults {
  schema_version: 'lumo-team-quality-results/v1'
  suite_id: string
  suite_revision: number
  suite_digest: string
  runs: QualityRun[]
}

function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`) }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'expected a plain object')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) fail(path, 'missing or unknown field')
}
function text(value: unknown, path: string, max = 1000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail(path, 'expected bounded nonempty text')
}
function id(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail(path, 'invalid identifier')
}
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(path, 'expected a bounded safe integer')
}
function array(value: unknown, path: string, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, 'expected a bounded array')
}
function unique(values: unknown[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'duplicate value')
}
function hash(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(path, 'expected lowercase SHA-256')
}
function refs(value: unknown, path: string, required = true): void {
  array(value, path, 100)
  if (required && value.length === 0) fail(path, 'evidence reference required')
  for (const entry of value) text(entry, path, 2000)
  unique(value, path)
}
function timestamp(value: unknown, path: string): number {
  // Exact UTC round-trip rejects Date.parse normalization (e.g. February 30),
  // ambiguous local clocks and precision silently discarded by Date.parse.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) fail(path, 'expected UTC ISO timestamp with milliseconds')
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail(path, 'invalid timestamp')
  return ms
}

/** Deterministic JSON encoding: finite values, sorted object keys, array order
 * retained. It is an evaluation-format digest, not a Governance receipt. */
export function canonicalJSON(value: unknown, depth = 0): string {
  if (depth > 32) fail('json', 'maximum nesting exceeded')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length > 10000 || Object.keys(value).length !== value.length || Object.keys(value).some((key, i) => key !== String(i))) fail('json', 'invalid array')
    return '[' + value.map(entry => canonicalJSON(entry, depth + 1)).join(',') + ']'
  }
  const record = object(value, 'json')
  if (Object.keys(record).length > 10000) fail('json', 'too many fields')
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(record[key], depth + 1)).join(',') + '}'
}
export function artifactDigest(value: unknown): string { return createHash('sha256').update(canonicalJSON(value)).digest('hex') }
export function suiteDigest(suite: QualitySuite): string { return artifactDigest(suite) }
function artifact(value: unknown, path: string): void {
  if (Buffer.byteLength(canonicalJSON(value)) > 32768) fail(path, 'structured answer exceeds 32 KiB')
}

export function parseSuite(value: unknown): QualitySuite {
  const suite = object(value, 'suite')
  keys(suite, ['schema_version', 'id', 'revision', 'cases'], 'suite')
  if (suite.schema_version !== 'lumo-team-quality-suite/v1') fail('suite', 'unsupported schema')
  id(suite.id, 'suite.id'); integer(suite.revision, 'suite.revision', 1)
  array(suite.cases, 'suite.cases', 1000)
  if (!suite.cases.length) fail('suite.cases', 'at least one case required')
  for (const [i, entry] of suite.cases.entries()) {
    const path = `suite.cases[${i}]`, c = object(entry, path)
    keys(c, ['id', 'title', 'category', 'topology', 'task', 'context', 'output_contract', 'expected'], path)
    id(c.id, path + '.id'); text(c.title, path + '.title')
    if (!['business', 'adversarial'].includes(String(c.category))) fail(path, 'invalid category')
    if (!TOPOLOGIES.includes(c.topology as Topology)) fail(path, 'invalid topology')
    text(c.task, path + '.task', 16000); text(c.output_contract, path + '.output_contract', 4000)
    array(c.context, path + '.context', 32)
    for (const source of c.context) {
      const s = object(source, path + '.context')
      keys(s, ['id', 'text'], path + '.context'); id(s.id, path + '.context.id'); text(s.text, path + '.context.text', 32000)
    }
    unique(c.context.map(source => (source as Record<string, unknown>).id), path + '.context')
    artifact(c.expected, path + '.expected')
  }
  unique(suite.cases.map(c => (c as Record<string, unknown>).id), 'suite.cases')
  return structuredClone(suite) as unknown as QualitySuite
}

export function parseResults(value: unknown, suite: QualitySuite): QualityResults {
  const results = object(value, 'results')
  keys(results, ['schema_version', 'suite_id', 'suite_revision', 'suite_digest', 'runs'], 'results')
  if (results.schema_version !== 'lumo-team-quality-results/v1' || results.suite_id !== suite.id || results.suite_revision !== suite.revision || results.suite_digest !== suiteDigest(suite)) fail('results', 'suite identity/revision/digest mismatch')
  array(results.runs, 'results.runs', 10000)
  const configurations = new Map<string, string>(), runIDs = new Set<string>(), trials = new Set<string>()
  for (const [i, entry] of results.runs.entries()) {
    const path = `results.runs[${i}]`, run = object(entry, path)
    keys(run, ['case_id', 'trial_id', 'source', 'configuration', 'execution', 'submissions', 'cost'], path)
    id(run.case_id, path + '.case_id'); id(run.trial_id, path + '.trial_id')
    const c = suite.cases.find(item => item.id === run.case_id)
    if (!c) fail(path, 'unknown case')
    if (!['fixture', 'recorded'].includes(String(run.source))) fail(path, 'invalid source')
    const config = object(run.configuration, path + '.configuration')
    keys(config, ['id', 'topology', 'members'], path + '.configuration'); id(config.id, path + '.configuration.id')
    if (!TOPOLOGIES.includes(config.topology as Topology)) fail(path, 'invalid topology')
    // Cases carry a suggested topology. Alternative topologies are deliberate
    // experiments and remain explicit in each configuration's identity.
    array(config.members, path + '.configuration.members', 32)
    if (!config.members.length) fail(path, 'configuration must identify its models')
    for (const member of config.members) {
      const m = object(member, path + '.configuration.members')
      keys(m, ['role', 'provider', 'model', 'preset_revision'], path + '.configuration.members')
      id(m.role, path + '.role'); text(m.provider, path + '.provider', 200); text(m.model, path + '.model', 200); integer(m.preset_revision, path + '.preset_revision', 1)
    }
    unique(config.members.map(member => (member as Record<string, unknown>).role), path + '.configuration.members')
    const serialized = canonicalJSON(config), old = configurations.get(String(config.id))
    if (old !== undefined && old !== serialized) fail(path, 'configuration id reused for different models/topology')
    configurations.set(String(config.id), serialized)
    const trial = canonicalJSON([run.source, config.id, run.case_id, run.trial_id])
    if (trials.has(trial)) fail(path, 'duplicate trial')
    trials.add(trial)
    const execution = object(run.execution, path + '.execution')
    keys(execution, ['state', 'started_at', 'finished_at', 'evidence_refs'], path + '.execution')
    if (!['completed', 'failed', 'cancelled', 'uncertain'].includes(String(execution.state))) fail(path, 'execution must be terminal')
    const start = timestamp(execution.started_at, path + '.started_at'), end = timestamp(execution.finished_at, path + '.finished_at')
    if (end < start) fail(path, 'negative duration')
    refs(execution.evidence_refs, path + '.execution.evidence_refs')
    array(run.submissions, path + '.submissions', 32)
    let previousTime = start
    for (const [j, item] of run.submissions.entries()) {
      const s = object(item, path + '.submissions')
      keys(s, ['attempt', 'run_id', 'submitted_at', 'artifact', 'artifact_digest', 'review'], path + '.submissions')
      if (s.attempt !== j + 1) fail(path, 'submission attempts must be consecutive starting at 1')
      id(s.run_id, path + '.run_id')
      const runID = `${run.source}:${s.run_id}`
      if (runIDs.has(runID)) fail(path, 'execution run_id counted more than once')
      runIDs.add(runID)
      const submitted = timestamp(s.submitted_at, path + '.submitted_at')
      if (submitted < previousTime || submitted > end) fail(path, 'submission timestamp outside execution/order')
      previousTime = submitted
      artifact(s.artifact, path + '.artifact'); hash(s.artifact_digest, path + '.artifact_digest')
      if (s.artifact_digest !== artifactDigest(s.artifact)) fail(path, 'artifact digest mismatch')
      if (s.review !== null) {
        const review = object(s.review, path + '.review')
        keys(review, ['decision', 'artifact_digest', 'decided_at', 'provider', 'model', 'evidence_refs'], path + '.review')
        if (!['approve', 'reject', 'unavailable'].includes(String(review.decision)) || review.artifact_digest !== s.artifact_digest) fail(path, 'review must bind the exact artifact')
        const decided = timestamp(review.decided_at, path + '.decided_at')
        if (decided < submitted || decided > end) fail(path, 'review timestamp outside execution/order')
        previousTime = decided
        text(review.provider, path + '.review.provider', 200); text(review.model, path + '.review.model', 200); refs(review.evidence_refs, path + '.review.evidence_refs')
        if (!config.members.some(member => {
          const m = member as Record<string, unknown>
          return m.provider === review.provider && m.model === review.model
        })) fail(path, 'review model must be declared in the configuration')
      }
    }
    const cost = object(run.cost, path + '.cost')
    keys(cost, ['microusd', 'evidence_refs'], path + '.cost')
    if (cost.microusd !== null) integer(cost.microusd, path + '.cost.microusd')
    refs(cost.evidence_refs, path + '.cost.evidence_refs', cost.microusd !== null)
  }
  return structuredClone(results) as unknown as QualityResults
}

/** Do not send the expected answer to a participant or reviewer. */
export function publicTasks(suite: QualitySuite): object {
  return { suite_id: suite.id, suite_revision: suite.revision, suite_digest: suiteDigest(suite), cases: suite.cases.map(({ expected: _oracle, ...task }) => task) }
}
