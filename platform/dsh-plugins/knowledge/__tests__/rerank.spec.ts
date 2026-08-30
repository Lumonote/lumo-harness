import { afterEach, describe, expect, it, vi } from 'vitest'

import { TeiRerankClient, rankByScore } from '../src/rerank.ts'

afterEach(() => vi.unstubAllGlobals())

/** TEI 的 /rerank 按分数降序返回，`index` 指回输入下标（见 spec §2.2）。 */
function rerankResponse(entries: Array<{ index: number; score: number }>): Response {
  return new Response(JSON.stringify(entries), { status: 200 })
}

describe('TeiRerankClient', () => {
  it('maps descending TEI scores back to input order', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      rerankResponse([
        { index: 2, score: 0.9 },
        { index: 0, score: 0.5 },
        { index: 1, score: 0.1 },
      ]),
    )
    vi.stubGlobal('fetch', fetch)
    const client = new TeiRerankClient({ baseUrl: 'http://tei-rerank', model: 'bge-reranker-v2-m3' })

    // 朴素实现会返回 [0.9, 0.5, 0.1] —— 分数安在错误的文本上，且不会报错。
    await expect(client.rerank('知识库怎么换模型', ['甲', '乙', '丙'])).resolves.toEqual([0.5, 0.1, 0.9])
  })

  it('rejects a duplicated index instead of silently dropping a text', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      rerankResponse([
        { index: 0, score: 0.9 },
        { index: 0, score: 0.1 },
      ]),
    ))
    const client = new TeiRerankClient({ baseUrl: 'http://tei-rerank', model: 'bge-reranker-v2-m3' })

    // 重复 index 会让某条文本拿不到分数（undefined 参与排序 = 静默失效）。
    await expect(client.rerank('q', ['甲', '乙'])).rejects.toThrow(/index/)
  })

  it('rejects an out-of-range index', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      rerankResponse([
        { index: 0, score: 0.9 },
        { index: 7, score: 0.1 },
      ]),
    ))
    const client = new TeiRerankClient({ baseUrl: 'http://tei-rerank', model: 'bge-reranker-v2-m3' })

    await expect(client.rerank('q', ['甲', '乙'])).rejects.toThrow(/index/)
  })

  it('rejects a count mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      rerankResponse([{ index: 0, score: 0.9 }]),
    ))
    const client = new TeiRerankClient({ baseUrl: 'http://tei-rerank', model: 'bge-reranker-v2-m3' })

    await expect(client.rerank('q', ['甲', '乙'])).rejects.toThrow(/2/)
  })

  it('rejects non-finite scores', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('[{"index":0,"score":null},{"index":1,"score":0.5}]', { status: 200 }),
    ))
    const client = new TeiRerankClient({ baseUrl: 'http://tei-rerank', model: 'bge-reranker-v2-m3' })

    await expect(client.rerank('q', ['甲', '乙'])).rejects.toThrow(/分数/)
  })

  it('rejects a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('model is loading', { status: 503 }),
    ))
    const client = new TeiRerankClient({ baseUrl: 'http://tei-rerank', model: 'bge-reranker-v2-m3' })

    await expect(client.rerank('q', ['甲'])).rejects.toThrow(/503/)
  })

  it('names the model in a timeout error', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    ))
    const client = new TeiRerankClient({
      baseUrl: 'http://tei-rerank',
      model: 'bge-reranker-v2-m3',
      timeoutMs: 10,
    })

    // 超时诊断必须能指认是哪个模型实例挂了 —— 平台同时跑 embedding 与 rerank 两个 TEI。
    await expect(client.rerank('q', ['甲'])).rejects.toThrow(/bge-reranker-v2-m3/)
  })
})

describe('rankByScore', () => {
  it('keeps the original order when every score ties', () => {
    const hits = ['甲', '乙', '丙', '丁']

    // 交叉编码器给相近片段打并列分是常态。排序不稳定 = 同一查询两次结果不同，
    // 且不会报错（spec §2.1）。
    expect(rankByScore(hits, [0, 0, 0, 0], 4)).toEqual(['甲', '乙', '丙', '丁'])
  })

  it('sorts descending and truncates to topK', () => {
    const hits = ['甲', '乙', '丙']

    expect(rankByScore(hits, [0.1, 0.9, 0.5], 2)).toEqual(['乙', '丙'])
  })
})
