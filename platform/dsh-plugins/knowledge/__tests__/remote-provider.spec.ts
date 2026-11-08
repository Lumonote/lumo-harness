import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeQuery } from '../../../shared/seam-contracts/knowledge.ts'
import { MilvusKnowledgeProvider } from '../src/remote-provider.ts'

afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const embed = vi.fn().mockResolvedValue([[0.25, 0.75]])
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: [{ doc_id: 'selected-doc', source_version: 4, text: '匹配内容', distance: 0.9 }] }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const provider = new MilvusKnowledgeProvider({ baseUrl: 'http://milvus.invalid', collection: 'knowledge', embedding: { embed, dimension: 2 }, embeddingModel: 'test-model', dimension: 2, allowedRoles: ['viewer'] })
  const query: KnowledgeQuery = { realm: 'realm-a', roles: ['viewer'], text: '审批流程', topK: 1, scope: 'published' }
  return { provider, query, embed, fetch, body: () => JSON.parse(fetch.mock.calls[0]![1].body as string) }
}

describe('Milvus query space filters', () => {
  it('preserves unrestricted space selection when spaces is omitted', async () => {
    const f = fixture(); expect(await f.provider.query(f.query)).toEqual([{ docId: 'selected-doc', sourceVersion: 4, text: '匹配内容', score: 0.9 }])
    expect(f.body()).toMatchObject({ collectionName: 'knowledge', limit: 1, filter: 'realm == "realm-a" && embedding_model == "test-model"', data: [[0.25, 0.75]] })
    expect(f.fetch).toHaveBeenCalledWith('http://milvus.invalid/v2/vectordb/entities/search', expect.any(Object))
  })
  it('places selected spaces in the remote search filter before its candidate limit', async () => {
    const f = fixture(); await f.provider.query({ ...f.query, spaces: ['operations', '产品知识'] })
    expect(f.body()).toMatchObject({ limit: 1, filter: 'realm == "realm-a" && embedding_model == "test-model" && space in ["operations", "产品知识"]' })
    expect(f.embed).toHaveBeenCalledWith(['审批流程'])
  })
  it('escapes quotes, slashes and control characters as string data without broadening the predicate', async () => {
    const f = fixture(); const space = '知识"\\\n\t\u0000] || realm != "'
    await f.provider.query({ ...f.query, spaces: [space] })
    const filter = f.body().filter as string
    expect(filter).toBe(`realm == "realm-a" && embedding_model == "test-model" && space in [${JSON.stringify(space)}]`)
    expect(JSON.parse(filter.slice(filter.indexOf('space in ') + 'space in '.length))).toEqual([space])
  })
  it('returns no hits for an empty allowed space set without embedding or querying Milvus', async () => {
    const f = fixture(); expect(await f.provider.query({ ...f.query, spaces: [] })).toEqual([])
    expect(f.embed).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([{ roles: ['unauthorized'] }, { scope: 'draft' as const }])('still authorizes empty-space requests %j', async overrides => {
    const f = fixture(); await expect(f.provider.query({ ...f.query, ...overrides, spaces: [] })).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.embed).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
})
