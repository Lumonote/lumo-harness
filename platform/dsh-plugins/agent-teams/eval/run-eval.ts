/** Offline evaluator. It never invokes models, tools or external services. */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSuite, publicTasks, suiteDigest } from './schema.ts'
import { scoreResults } from './metrics.ts'
import { evaluateQualityGate } from './gate.ts'

const defaultSuite = fileURLToPath(new URL('./golden.zh.json', import.meta.url))
export function readJSON(path: string): unknown {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Evaluation input must be a regular file at most 16 MiB')
  const raw = readFileSync(path)
  if (raw.length > 16 * 1024 * 1024) throw new Error('Evaluation input exceeds 16 MiB')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown
}
export function evaluateCLI(args: string[]): object {
  const [command, ...rest] = args
  if (!['validate', 'tasks', 'template', 'score', 'gate'].includes(command ?? '')) throw new Error('Usage: run-eval.ts validate|tasks|template|score|gate [--suite path] [--results path] [--policy path] [--baseline path]')
  const options = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]
    if (!['--suite', '--results', '--policy', '--baseline'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error('Invalid or duplicate evaluation option')
    options.set(key, value)
  }
  if ((command === 'score' || command === 'gate') !== options.has('--results')) throw new Error('Only score/gate require --results path')
  if ((command === 'gate') !== options.has('--policy') || command !== 'gate' && options.has('--baseline')) throw new Error('Only gate requires --policy and accepts --baseline')
  const suite = parseSuite(readJSON(options.get('--suite') ?? defaultSuite))
  if (command === 'tasks') return publicTasks(suite)
  if (command === 'template') return { schema_version: 'lumo-team-quality-results/v1', suite_id: suite.id, suite_revision: suite.revision, suite_digest: suiteDigest(suite), runs: [] }
  if (command === 'score') return scoreResults(suite, readJSON(options.get('--results')!))
  if (command === 'gate') return evaluateQualityGate(suite, readJSON(options.get('--results')!), readJSON(options.get('--policy')!), options.has('--baseline') ? readJSON(options.get('--baseline')!) : undefined)
  return { schema_version: suite.schema_version, suite_id: suite.id, suite_revision: suite.revision, suite_digest: suiteDigest(suite), cases: suite.cases.length, categories: [...new Set(suite.cases.map(c => c.category))], suggested_topologies: [...new Set(suite.cases.map(c => c.topology))], evaluated_trials: 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = evaluateCLI(process.argv.slice(2))
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if ('passed' in result && result.passed === false) process.exitCode = 2
  }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Evaluation failed') + '\n'); process.exitCode = 1 }
}
