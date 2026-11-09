/** Offline retrieval evaluation. Explicit services only; never probes default
 * endpoints. Use a dedicated evaluation database: provider.init performs DDL.
 * Input/report contracts and an injectable runner are tested without TEI. */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { PgKnowledgeProvider } from '../src/pg-provider.ts'
import { TeiClient } from '../src/embedding.ts'
import { TeiRerankClient } from '../src/rerank.ts'
import { chunkByHeading } from './corpus.ts'
import { digest, parseConfiguration, parseCorpus, parseSuite, readBundleJSON, type EvalConfiguration, type EvalCorpus, type EvalSuite } from './contracts.ts'
import { compareTable } from './metrics.ts'
import { compareBaseline, parseReport, runEvaluation, type EvalReport } from './runner.ts'
import { readFileSync } from 'node:fs'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
export interface Options { root: string; corpus?: string; suite?: string; configuration?: string; baseline?: string; output?: string; markdown?: string; validateOnly: boolean }
export function parseOptions(args: string[]): Options {
  const options: Options = { root: process.cwd(), validateOnly: false }
  const flags: Record<string, keyof Omit<Options, 'validateOnly'>> = { '--input-root': 'root', '--corpus': 'corpus', '--suite': 'suite', '--configuration': 'configuration', '--baseline': 'baseline', '--output': 'output', '--markdown-output': 'markdown' }
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`)
    seen.add(flag)
    if (flag === '--validate-only') { options.validateOnly = true; continue }
    const key = flags[flag], value = args[++i]
    if (!key || !value || value.startsWith('--')) throw new Error(`Unknown option or missing value: ${flag}`)
    options[key] = value
  }
  if (Boolean(options.corpus) !== Boolean(options.suite)) throw new Error('--corpus and --suite must be provided together')
  return options
}

export function loadInputs(options: Options): { corpus: EvalCorpus; suite: EvalSuite } {
  if (options.corpus && options.suite) {
    const corpus = parseCorpus(readBundleJSON(options.root, options.corpus))
    return { corpus, suite: parseSuite(readBundleJSON(options.root, options.suite), corpus) }
  }
  // Existing 24-case repository fixture remains available, explicitly named
  // in report identity. Business conclusions require an operator-owned suite.
  const documents = [ ['architecture', 'architecture.md'], ['roadmap', 'roadmap.md'], ['review', 'design-review.md'] ].flatMap(([prefix, name]) =>
    chunkByHeading(readFileSync(resolve(repo, 'docs', name!), 'utf8'), prefix!).map(c => ({ id: c.docId, title: c.title, text: c.text })))
  const corpus = parseCorpus({ schema_version: 'lumo-knowledge-corpus/v1', id: 'repository-architecture-zh', revision: 1, documents })
  const cases = readBundleJSON(repo, 'platform/dsh-plugins/knowledge/eval/golden.zh.json')
  const suite = parseSuite({ schema_version: 'lumo-knowledge-suite/v1', id: 'repository-golden-zh', revision: 1, corpus_digest: digest(corpus), cases }, corpus)
  return { corpus, suite }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} must be explicitly configured`)
  return value
}
export function loadConfiguration(options: Options, env: NodeJS.ProcessEnv): EvalConfiguration {
  if (options.configuration) return parseConfiguration(readBundleJSON(options.root, options.configuration))
  const mode = env.LUMO_EVAL_RERANK_MODE ?? 'required'
  return parseConfiguration({ schema_version: 'lumo-knowledge-configuration/v1',
    embedding: { model: required(env, 'LUMO_TEI_MODEL'), revision: required(env, 'LUMO_TEI_REVISION'), dimension: Number(required(env, 'LUMO_TEI_DIM')) },
    rerank: { mode, model: mode === 'off' ? null : required(env, 'LUMO_RERANK_MODEL'), revision: mode === 'off' ? null : required(env, 'LUMO_RERANK_REVISION') },
    topK: Number(env.LUMO_EVAL_TOPK ?? 5), overfetch: Number(env.LUMO_EVAL_OVERFETCH ?? 3) })
}
function endpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('TEI URL must be an explicit HTTP(S) origin without credentials/path/query')
  return url.origin
}
function markdown(report: EvalReport): string {
  const lines = [`suite=${report.suite.id}@${report.suite.revision} sha256=${report.suite.digest}`, `corpus=${report.corpus.id}@${report.corpus.revision} sha256=${report.corpus.digest}`,
    `configuration sha256=${report.configuration_digest}; model sha256=${report.model_digest}`, `evidence=${report.evidence_status}; rerank=${report.rerank_status}; realm=${report.realm}`,
    '', compareTable(report.runs.map(run => ({ label: `rerank ${run.mode}`, metrics: run.metrics })))]
  const off = report.runs.find(run => run.mode === 'off'), on = report.runs.find(run => run.mode === 'on')
  if (off && on && on.metrics.ndcgAt5 <= off.metrics.ndcgAt5) lines.push('\n重排未改善 nDCG@5。请保留该否定结论，不要调分数。')
  if (report.rerank_status === 'unavailable') lines.push('\n显式 optional 模式：重排不可用，本次只有 off，不能证明重排效果。')
  if (report.baseline) lines.push('\n基线：' + report.baseline.report_digest, ...report.baseline.deltas.map(d => `${d.mode}: nDCG@5 Δ=${d.ndcgAt5.toFixed(3)}, Recall@5 Δ=${d.recallAt5.toFixed(3)}, MRR Δ=${d.mrr.toFixed(3)}`))
  lines.push('\n模型名和 revision 由操作者声明；报告不独立证明服务加载的权重。评测源留在专用数据库供复核，未声称物理清理。')
  return lines.join('\n') + '\n'
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const options = parseOptions(args), { corpus, suite } = loadInputs(options), configuration = loadConfiguration(options, env)
  if (options.validateOnly) {
    console.log(JSON.stringify({ schema_version: 'lumo-knowledge-input-validation/v1', valid: true, live_services_called: false, corpus_digest: digest(corpus), suite_digest: digest(suite), configuration_digest: digest(configuration), model_digest: digest({ embedding: configuration.embedding, rerank: configuration.rerank }), documents: corpus.documents.length, cases: suite.cases.length }, null, 2))
    return
  }
  // All untrusted inputs, including a baseline, are read before any service is
  // constructed. Credentials/endpoints never enter reports or console output.
  const baseline = options.baseline ? readBundleJSON(options.root, options.baseline) : undefined
  if (baseline !== undefined) {
    const previous = parseReport(baseline, corpus, suite)
    if (previous.evidence_status !== 'live-services-operator-declared-models' || previous.configuration.topK !== configuration.topK || previous.configuration.overfetch !== configuration.overfetch || previous.configuration.rerank.mode !== configuration.rerank.mode) throw new Error('Baseline is simulated or has incompatible retrieval settings')
  }
  const pg = required(env, 'LUMO_PG_DSN'), tei = endpoint(required(env, 'LUMO_TEI_URL'))
  const pgURL = new URL(pg)
  if (!['postgres:', 'postgresql:'].includes(pgURL.protocol)) throw new Error('Explicit PostgreSQL DSN required')
  const rerankURL = configuration.rerank.mode === 'off' ? undefined : endpoint(required(env, 'LUMO_RERANK_URL'))
  const embedding = new TeiClient({ baseUrl: tei, model: configuration.embedding.model, dimension: configuration.embedding.dimension })
  const provider = new PgKnowledgeProvider({ connectionString: pg, allowedRoles: ['viewer'], embedding, embeddingModel: configuration.embedding.model })
  const rerank = rerankURL ? new TeiRerankClient({ baseUrl: rerankURL, model: configuration.rerank.model! }) : undefined
  const report = await runEvaluation(corpus, suite, configuration, { provider, rerank, evidence: 'live-services-operator-declared-models' })
  if (baseline !== undefined) report.baseline = compareBaseline(report, baseline, corpus, suite)
  if (options.output) writeFileSync(resolve(options.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const table = markdown(report)
  if (options.markdown) writeFileSync(resolve(options.markdown), table, { flag: 'wx', mode: 0o600 })
  console.log(table)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Service/PG errors can include connection details or document fragments.
    console.error('knowledge-eval: failed; no valid comparison report was produced. Check input contracts and explicitly configured services locally.')
    process.exitCode = 1
  })
}
