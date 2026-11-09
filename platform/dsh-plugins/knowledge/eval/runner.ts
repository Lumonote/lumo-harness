import { randomUUID } from 'node:crypto'
import type { KnowledgeHit, KnowledgeIngest, KnowledgeQuery } from '../../../shared/seam-contracts/knowledge.ts'
import { rerankHits, type RerankClient } from '../src/rerank.ts'
import { boundedText, digest, exact, list, parseConfiguration, record, type EvalConfiguration, type EvalCorpus, type EvalSuite } from './contracts.ts'
import { scoreRun, type Metrics } from './metrics.ts'

export interface EvalProvider {
  init(): Promise<void>
  ingest(entry: KnowledgeIngest): Promise<void>
  query(request: KnowledgeQuery): Promise<KnowledgeHit[]>
  close(): Promise<void>
}
export interface EvalObservation { case_id: string; ranked_doc_ids: string[] }
export interface EvalRun { mode: 'off' | 'on'; observations: EvalObservation[]; metrics: Metrics }
export interface BaselineComparison {
  report_digest: string
  deltas: Array<{ mode: 'off' | 'on'; recallAt1: number; recallAt3: number; recallAt5: number; mrr: number; ndcgAt5: number }>
}
export interface EvalReport {
  schema_version: 'lumo-knowledge-evaluation/v1'
  evidence_status: 'live-services-operator-declared-models' | 'simulated-contract-test'
  run_id: string
  realm: string
  started_at: string
  finished_at: string
  suite: { id: string; revision: number; digest: string }
  corpus: { id: string; revision: number; digest: string; documents: number }
  configuration: EvalConfiguration
  configuration_digest: string
  model_digest: string
  rerank_status: 'off' | 'available' | 'unavailable'
  runs: EvalRun[]
  baseline: BaselineComparison | null
}
const METRICS = ['recallAt1', 'recallAt3', 'recallAt5', 'mrr', 'ndcgAt5'] as const

/** Injectable only for tests. The CLI always constructs the real configured
 * PostgreSQL/TEI clients and labels their operator-declared model identities. */
export async function runEvaluation(corpus: EvalCorpus, suite: EvalSuite, configuration: EvalConfiguration, dependencies: {
  provider: EvalProvider
  rerank?: RerankClient
  evidence: EvalReport['evidence_status']
}): Promise<EvalReport> {
  const runID = randomUUID(), realm = `lumo-kb-eval-${runID}`
  const started = new Date().toISOString()
  // knowledge_sources.doc_id is global, not realm-scoped. Namespacing BOTH
  // keys is essential: a realm alone would collide with business documents.
  const physical = new Map(corpus.documents.map((d, i) => [d.id, `${realm}:document:${i}`]))
  const logical = new Map([...physical].map(([key, value]) => [value, key]))
  const provider = dependencies.provider
  let rerank = dependencies.rerank
  let rerankStatus: EvalReport['rerank_status'] = 'off'
  const runs: EvalRun[] = []
  try {
    // Required must fail before DDL/ingest, rather than publish a silent off
    // substitute. Optional is explicit and records unavailable in the report.
    if (configuration.rerank.mode !== 'off') {
      try {
        if (!rerank || rerank.model !== configuration.rerank.model) throw new Error('Reranker missing/model mismatch')
        const scores = await rerank.rerank('evaluation readiness', ['evaluation readiness'])
        if (scores.length !== 1 || !scores.every(Number.isFinite)) throw new Error('Reranker readiness response invalid')
        rerankStatus = 'available'
      } catch {
        if (configuration.rerank.mode === 'required') throw new Error('Required evaluation reranker is unavailable; no off-only report is valid')
        rerank = undefined; rerankStatus = 'unavailable'
      }
    } else rerank = undefined
    await provider.init()
    for (const document of corpus.documents) {
      await provider.ingest({
        doc: { docId: physical.get(document.id)!, realm, space: 'eval', title: document.title, sourceVersion: 1, embeddingModel: configuration.embedding.model },
        chunks: [{ text: document.text, metadata: {} }],
      })
    }
    for (const mode of (rerank ? ['off', 'on'] : ['off']) as Array<'off' | 'on'>) {
      const observations: EvalObservation[] = []
      for (const c of suite.cases) {
        const candidates = await provider.query({ realm, roles: ['viewer'], spaces: ['eval'], scope: 'published', text: c.query,
          topK: configuration.topK * (mode === 'on' ? configuration.overfetch : 1) })
        if (candidates.some(hit => !logical.has(hit.docId))) throw new Error('Provider returned a document outside this evaluation run')
        const hits = await rerankHits(mode === 'on' ? rerank : undefined, c.query, candidates, configuration.topK,
          () => { throw new Error('Evaluation rerank failed during a case; report aborted') })
        const ranked = [...new Set(hits.map(hit => logical.get(hit.docId)!))]
        observations.push({ case_id: c.id, ranked_doc_ids: ranked })
      }
      runs.push({ mode, observations, metrics: scoreRun(observations.map((o, i) => ({ expected: suite.cases[i]!.expectedDocIds, ranked: o.ranked_doc_ids }))) })
    }
  } finally { await provider.close() }
  return {
    schema_version: 'lumo-knowledge-evaluation/v1', evidence_status: dependencies.evidence,
    run_id: runID, realm, started_at: started, finished_at: new Date().toISOString(),
    suite: { id: suite.id, revision: suite.revision, digest: digest(suite) },
    corpus: { id: corpus.id, revision: corpus.revision, digest: digest(corpus), documents: corpus.documents.length },
    configuration: structuredClone(configuration), configuration_digest: digest(configuration), model_digest: digest({ embedding: configuration.embedding, rerank: configuration.rerank }),
    rerank_status: rerankStatus, runs, baseline: null,
  }
}

/** Baseline observations are untrusted input. Bind coverage and recompute every
 * metric from per-case logical rankings, never trust an imported score. */
export function parseReport(input: unknown, corpus: EvalCorpus, suite: EvalSuite): EvalReport {
  const r = record(input, 'report')
  exact(r, ['schema_version', 'evidence_status', 'run_id', 'realm', 'started_at', 'finished_at', 'suite', 'corpus', 'configuration', 'configuration_digest', 'model_digest', 'rerank_status', 'runs', 'baseline'], 'report')
  if (r.schema_version !== 'lumo-knowledge-evaluation/v1' || !['live-services-operator-declared-models', 'simulated-contract-test'].includes(String(r.evidence_status))) throw new Error('Unsupported evaluation report')
  if (typeof r.run_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(r.run_id) || r.realm !== `lumo-kb-eval-${r.run_id}`) throw new Error('Invalid evaluation run isolation identity')
  const time = (v: unknown): number => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error('Invalid report timestamp')
    return Date.parse(v)
  }
  if (time(r.finished_at) < time(r.started_at)) throw new Error('Invalid report time range')
  if (digest(r.suite) !== digest({ id: suite.id, revision: suite.revision, digest: digest(suite) }) || digest(r.corpus) !== digest({ id: corpus.id, revision: corpus.revision, digest: digest(corpus), documents: corpus.documents.length })) throw new Error('Baseline suite/corpus identity mismatch')
  const configuration = parseConfiguration(r.configuration)
  if (r.configuration_digest !== digest(configuration) || r.model_digest !== digest({ embedding: configuration.embedding, rerank: configuration.rerank })) throw new Error('Report configuration/model digest mismatch')
  if (!['off', 'available', 'unavailable'].includes(String(r.rerank_status)) || configuration.rerank.mode === 'off' && r.rerank_status !== 'off' || configuration.rerank.mode === 'required' && r.rerank_status !== 'available' || configuration.rerank.mode === 'optional' && r.rerank_status === 'off') throw new Error('Report rerank status contradicts configuration')
  list(r.runs, 'report.runs', 2)
  const expectedModes = r.rerank_status === 'available' ? ['off', 'on'] : ['off']
  if (JSON.stringify(r.runs.map(value => record(value, 'run').mode)) !== JSON.stringify(expectedModes)) throw new Error('Report run coverage mismatch')
  const docIDs = new Set(corpus.documents.map(d => d.id))
  for (const value of r.runs) {
    const run = record(value, 'run'); exact(run, ['mode', 'observations', 'metrics'], 'run')
    list(run.observations, 'observations', suite.cases.length)
    if (run.observations.length !== suite.cases.length) throw new Error('Report case coverage mismatch')
    for (const [i, value] of run.observations.entries()) {
      const o = record(value, 'observation'); exact(o, ['case_id', 'ranked_doc_ids'], 'observation')
      if (o.case_id !== suite.cases[i]!.id || !Array.isArray(o.ranked_doc_ids) || o.ranked_doc_ids.length > configuration.topK || new Set(o.ranked_doc_ids).size !== o.ranked_doc_ids.length || o.ranked_doc_ids.some(id => typeof id !== 'string' || !docIDs.has(id))) throw new Error('Invalid/duplicate/foreign report case ranking')
    }
    const metrics = scoreRun((run.observations as EvalObservation[]).map((o, i) => ({ expected: suite.cases[i]!.expectedDocIds, ranked: o.ranked_doc_ids })))
    if (digest(run.metrics) !== digest(metrics)) throw new Error('Report metrics do not match observations')
  }
  if (r.baseline !== null) {
    const b = record(r.baseline, 'baseline'); exact(b, ['report_digest', 'deltas'], 'baseline')
    if (typeof b.report_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(b.report_digest)) throw new Error('Invalid baseline report digest')
    list(b.deltas, 'baseline.deltas', expectedModes.length)
    if (b.deltas.length !== expectedModes.length) throw new Error('Baseline delta coverage mismatch')
    b.deltas.forEach((value, i) => {
      const d = record(value, 'delta'); exact(d, ['mode', ...METRICS], 'delta')
      if (d.mode !== expectedModes[i] || METRICS.some(key => typeof d[key] !== 'number' || !Number.isFinite(d[key]) || Math.abs(Number(d[key])) > 1)) throw new Error('Invalid baseline delta')
    })
  }
  return structuredClone(r) as unknown as EvalReport
}

export function compareBaseline(report: EvalReport, baselineInput: unknown, corpus: EvalCorpus, suite: EvalSuite): BaselineComparison {
  const candidate = parseReport(report, corpus, suite), baseline = parseReport(baselineInput, corpus, suite)
  if (candidate.evidence_status !== baseline.evidence_status) throw new Error('Simulated and live reports cannot be compared')
  const retrieval = (c: EvalConfiguration) => ({ topK: c.topK, overfetch: c.overfetch, rerank_mode: c.rerank.mode })
  if (digest(retrieval(candidate.configuration)) !== digest(retrieval(baseline.configuration)) || candidate.rerank_status !== baseline.rerank_status || JSON.stringify(candidate.runs.map(r => r.mode)) !== JSON.stringify(baseline.runs.map(r => r.mode))) throw new Error('Baseline retrieval settings/run coverage mismatch')
  return { report_digest: digest(baseline), deltas: candidate.runs.map((run, i) => ({ mode: run.mode,
    ...Object.fromEntries(METRICS.map(key => [key, run.metrics[key] - baseline.runs[i]!.metrics[key]])) as Pick<Metrics, typeof METRICS[number]> })) }
}
