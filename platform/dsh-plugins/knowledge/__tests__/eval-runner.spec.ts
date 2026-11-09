import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeIngest } from '../../../shared/seam-contracts/knowledge.ts'
import { digest, parseConfiguration, parseCorpus, parseSuite, readBundleJSON } from '../eval/contracts.ts'
import { compareBaseline, parseReport, runEvaluation, type EvalProvider } from '../eval/runner.ts'
import { loadConfiguration, loadInputs, main, parseOptions } from '../eval/run-eval.ts'

// Synthetic contract fixtures, never labeled as live business measurements.
const corpus = parseCorpus({ schema_version: 'lumo-knowledge-corpus/v1', id: 'contract-fixture', revision: 1,
  documents: [{ id: 'a', title: 'A', text: 'Alpha' }, { id: 'b', title: 'B', text: 'Beta' }] })
const suite = parseSuite({ schema_version: 'lumo-knowledge-suite/v1', id: 'contract-fixture', revision: 1, corpus_digest: digest(corpus), cases: [
  { id: 'c1', query: 'Alpha?', expectedDocIds: ['a'], note: 'B is the distractor' },
  { id: 'c2', query: 'Beta?', expectedDocIds: ['b'], note: 'A is the distractor' },
] }, corpus)
const configuration = parseConfiguration({ schema_version: 'lumo-knowledge-configuration/v1', embedding: { model: 'test-embedding', revision: 'test-revision', dimension: 2 }, rerank: { mode: 'off', model: null, revision: null }, topK: 5, overfetch: 3 })
function provider() {
  const ingested: KnowledgeIngest[] = []
  const p: EvalProvider = {
    init: vi.fn(async () => {}),
    ingest: vi.fn(async entry => { ingested.push(entry) }),
    query: vi.fn(async request => {
      const docs = request.text === 'Alpha?' ? ingested : [...ingested].reverse()
      return docs.map(d => ({ docId: d.doc.docId, sourceVersion: 1, score: 1, text: d.chunks[0]!.text }))
    }),
    close: vi.fn(async () => {}),
  }
  return { p, ingested }
}
async function report() { return runEvaluation(corpus, suite, configuration, { provider: provider().p, evidence: 'simulated-contract-test' }) }
const roots: string[] = []
afterEach(() => { roots.forEach(p => rmSync(p, { recursive: true, force: true })); roots.length = 0; vi.restoreAllMocks() })

describe('reproducible knowledge evaluation', () => {
  it('isolates concurrent runs with random realms AND global document IDs', async () => {
    const first = provider(), second = provider()
    const [a, b] = await Promise.all([runEvaluation(corpus, suite, configuration, { provider: first.p, evidence: 'simulated-contract-test' }), runEvaluation(corpus, suite, configuration, { provider: second.p, evidence: 'simulated-contract-test' })])
    expect(a.realm).not.toBe(b.realm)
    expect(first.ingested.every(d => d.doc.realm === a.realm && d.doc.docId.startsWith(a.realm))).toBe(true)
    expect(first.ingested.some(d => second.ingested.some(e => d.doc.docId === e.doc.docId))).toBe(false)
    expect(a.runs[0]!.observations[0]!.ranked_doc_ids).toEqual(['a', 'b'])
    expect(a.runs[0]!.metrics.ndcgAt5).toBe(1)
    expect(first.p.close).toHaveBeenCalledOnce()
    expect(first.p.query).toHaveBeenCalledWith(expect.objectContaining({ realm: a.realm, spaces: ['eval'], roles: ['viewer'], scope: 'published' }))
    expect(parseReport(a, corpus, suite).configuration_digest).toBe(digest(configuration))
    expect(JSON.stringify(a)).not.toContain('Alpha?')
  })
  it('fails required rerank readiness before ingest or DDL', async () => {
    const { p } = provider()
    const c = parseConfiguration({ ...configuration, rerank: { mode: 'required', model: 'reranker', revision: 'r1' } })
    await expect(runEvaluation(corpus, suite, c, { provider: p, rerank: { model: 'reranker', rerank: async () => { throw new Error('not configured') } }, evidence: 'simulated-contract-test' })).rejects.toThrow(/Required/)
    expect(p.init).not.toHaveBeenCalled()
    expect(p.ingest).not.toHaveBeenCalled()
    expect(p.close).toHaveBeenCalledOnce()
  })
  it('records explicit optional unavailable without claiming an on run', async () => {
    const c = parseConfiguration({ ...configuration, rerank: { mode: 'optional', model: 'reranker', revision: 'r1' } })
    const r = await runEvaluation(corpus, suite, c, { provider: provider().p, evidence: 'simulated-contract-test' })
    expect(r.rerank_status).toBe('unavailable')
    expect(r.runs.map(r => r.mode)).toEqual(['off'])
    expect(parseReport(r, corpus, suite).rerank_status).toBe('unavailable')
  })
  it('aborts a run if an available reranker later degrades', async () => {
    const c = parseConfiguration({ ...configuration, rerank: { mode: 'required', model: 'reranker', revision: 'r1' } })
    let calls = 0
    await expect(runEvaluation(corpus, suite, c, { provider: provider().p, rerank: { model: 'reranker', rerank: async () => { if (++calls === 1) return [1]; throw new Error('failure mid run') } }, evidence: 'simulated-contract-test' })).rejects.toThrow(/aborted/)
  })
  it('rejects cross-run query results rather than score leaked sources', async () => {
    const { p } = provider()
    p.query = vi.fn(async () => [{ docId: 'business-document', sourceVersion: 1, score: 1, text: 'private' }])
    await expect(runEvaluation(corpus, suite, configuration, { provider: p, evidence: 'simulated-contract-test' })).rejects.toThrow(/outside/)
  })
  it('binds baselines to complete cases, settings and evidence class, recomputing scores', async () => {
    const a = await report(), b = await report()
    expect(compareBaseline(a, b, corpus, suite).deltas[0]?.ndcgAt5).toBe(0)
    const missing = structuredClone(b); missing.runs[0]!.observations.pop()
    expect(() => compareBaseline(a, missing, corpus, suite)).toThrow(/coverage/)
    const forged = structuredClone(b); forged.runs[0]!.metrics.ndcgAt5 = 0.9
    expect(() => compareBaseline(a, forged, corpus, suite)).toThrow(/metrics/)
    const foreign = structuredClone(b); foreign.evidence_status = 'live-services-operator-declared-models'
    expect(() => compareBaseline(a, foreign, corpus, suite)).toThrow(/Simulated/)
    const altered = structuredClone(b); altered.configuration.topK = 10; altered.configuration_digest = digest(altered.configuration)
    expect(() => compareBaseline(a, altered, corpus, suite)).toThrow(/settings/)
    const duplicates = structuredClone(b); duplicates.runs[0]!.observations[0]!.ranked_doc_ids = ['a', 'a']
    expect(() => compareBaseline(a, duplicates, corpus, suite)).toThrow(/duplicate/)
  })
  it('allows embedding model changes with identical corpus/suite and retrieval settings', async () => {
    const a = await report(), b = await report()
    b.configuration.embedding.model = 'old-model'
    b.configuration_digest = digest(b.configuration)
    b.model_digest = digest({ embedding: b.configuration.embedding, rerank: b.configuration.rerank })
    expect(compareBaseline(a, b, corpus, suite).report_digest).toBe(digest(b))
    const changedCorpus = parseCorpus({ ...corpus, revision: 2 })
    expect(() => parseReport(a, changedCorpus, suite)).toThrow(/identity/)
  })
})

describe('evaluation bundle and CLI', () => {
  it('loads bounded local manifests and rejects traversal, links, directories and unknown keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-eval-')); roots.push(root)
    writeFileSync(join(root, 'corpus.json'), JSON.stringify(corpus))
    writeFileSync(join(root, 'suite.json'), JSON.stringify(suite))
    symlinkSync('corpus.json', join(root, 'linked.json'))
    mkdirSync(join(root, 'nested')); symlinkSync('nested', join(root, 'linked-dir'))
    writeFileSync(join(root, 'nested', 'data.json'), '{}')
    expect(loadInputs(parseOptions(['--input-root', root, '--corpus', 'corpus.json', '--suite', 'suite.json'])).corpus).toEqual(corpus)
    for (const path of ['../corpus.json', '/etc/passwd', 'linked.json', 'linked-dir/data.json', 'nested', 'nested//data.json']) expect(() => readBundleJSON(root, path)).toThrow()
    expect(() => parseCorpus({ ...corpus, url: 'https://example.com/never-fetched' })).toThrow(/unknown/)
  })
  it('validates repository fixtures and custom configuration with no service calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-eval-')); roots.push(root)
    writeFileSync(join(root, 'config.json'), JSON.stringify(configuration))
    expect(loadInputs(parseOptions([])).suite.cases).toHaveLength(24)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['--input-root', root, '--configuration', 'config.json', '--validate-only'], {})
    expect(fetch).not.toHaveBeenCalled()
    const result = JSON.parse(log.mock.calls[0]![0] as string)
    expect(result.live_services_called).toBe(false)
    expect(result.cases).toBe(24)
  })
  it('requires explicit services and pinned operator model metadata', async () => {
    expect(() => loadConfiguration(parseOptions([]), {})).toThrow(/explicitly/)
    const root = mkdtempSync(join(tmpdir(), 'lumo-eval-')); roots.push(root)
    writeFileSync(join(root, 'config.json'), JSON.stringify(configuration))
    await expect(main(['--input-root', root, '--configuration', 'config.json'], {})).rejects.toThrow(/LUMO_PG_DSN/)
    expect(() => parseOptions(['--corpus', 'only.json'])).toThrow(/together/)
    expect(() => parseOptions(['--unknown', 'x'])).toThrow(/Unknown/)
    expect(() => parseOptions(['--validate-only', '--validate-only'])).toThrow(/Duplicate/)
  })
})
