import { describe, expect, it } from 'vitest'
import { parseJSON, parseCorpus, parseSuite, parseConfiguration, digest } from '../eval/contracts.ts'

const corpus = { schema_version: 'lumo-knowledge-corpus/v1', id: 'business-demo', revision: 1, documents: [
  { id: 'policy', title: '退款政策', text: '退款在七日内办理。' },
  { id: 'support', title: '客服流程', text: '客服工单在一个工作日内响应。' },
] } as const

describe('knowledge evaluation contracts', () => {
  it('rejects duplicate JSON keys before parsing', () => {
    expect(() => parseJSON('{"a":1,"a":2}')).toThrow(/Duplicate JSON key/)
    expect(() => parseJSON('{"a":1,"\\u0061":2}')).toThrow(/Duplicate JSON key/)
    for (const raw of ['{"a":1e999}', '[1,]', '{"a":', '{"a":1} true', '['.repeat(33) + '0' + ']'.repeat(33)]) expect(() => parseJSON(raw)).toThrow()
    expect(parseJSON('{"quoted":"a\\\"b","nested":[true,null,{"x":2}]}')).toEqual({ quoted: 'a"b', nested: [true, null, { x: 2 }] })
  })
  it('binds suite cases to explicit corpus documents', () => {
    const parsed = parseCorpus(corpus)
    const suite = parseSuite({ schema_version: 'lumo-knowledge-suite/v1', id: 'support-suite', revision: 1, corpus_digest: digest(parsed), cases: [
      { id: 'refund', query: '七日内可以退款吗', expectedDocIds: ['policy'], note: '客服流程是干扰项' },
    ] }, parsed)
    expect(suite.cases[0]?.expectedDocIds).toEqual(['policy'])
    expect(() => parseSuite({ schema_version: 'lumo-knowledge-suite/v1', id: 'bad', revision: 1, corpus_digest: digest(parsed), cases: [
      { id: 'unknown', query: 'x', expectedDocIds: ['missing'], note: 'distractor' },
    ] }, parsed)).toThrow(/Expected document/)
  })
  it('requires an explicit rerank mode and bounded retrieval settings', () => {
    expect(parseConfiguration({ schema_version: 'lumo-knowledge-configuration/v1', embedding: { model: 'e5', revision: 'r1', dimension: 4 }, rerank: { mode: 'required', model: 'bge-reranker', revision: 'r2' }, topK: 5, overfetch: 3 }).rerank.mode).toBe('required')
    expect(() => parseConfiguration({ schema_version: 'lumo-knowledge-configuration/v1', embedding: { model: 'e5', revision: 'r1', dimension: 4 }, rerank: { mode: 'off', model: 'bge-reranker', revision: 'r2' }, topK: 5, overfetch: 3 })).toThrow(/Off rerank/)
  })
  it('rejects ambiguous corpus IDs, repeated expected IDs and corpus drift', () => {
    const parsed = parseCorpus(corpus)
    expect(() => parseCorpus({ ...corpus, documents: [corpus.documents[0], corpus.documents[0]] })).toThrow(/duplicate/)
    const s = { schema_version: 'lumo-knowledge-suite/v1', id: 's', revision: 1, corpus_digest: digest(parsed), cases: [{ id: 'q', query: 'q', expectedDocIds: ['policy', 'policy'], note: 'n' }] }
    expect(() => parseSuite(s, parsed)).toThrow(/duplicate/)
    expect(() => parseSuite({ ...s, corpus_digest: '0'.repeat(64) }, parsed)).toThrow(/digest/)
    expect(() => parseSuite({ ...s, cases: [] }, parsed)).toThrow(/nonempty/)
  })
})
