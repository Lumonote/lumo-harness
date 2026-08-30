import { describe, expect, it, vi } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { defineKnowledgeTool } from '../src/consumer.ts'
import type { RerankClient } from '../src/rerank.ts'
import type {
  KnowledgeHit,
  KnowledgeQuery,
  KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'

type Hits = { hits: Array<{ docId: string; text: string; score: number }> }

function hit(docId: string, text: string, score: number): KnowledgeHit {
  return { docId, sourceVersion: 1, score, text }
}

function seamReturning(hits: KnowledgeHit[]) {
  const query = vi.fn(async (_request: KnowledgeQuery) => hits)
  const seam = {
    ingest: vi.fn(async () => undefined),
    query,
    remove: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
  } satisfies KnowledgeSeam
  return { seam, query }
}

function captureTool() {
  let definition: ToolDefinition | undefined
  const warn = vi.fn()
  const ctx = {
    tools: {
      register(d: ToolDefinition) {
        definition = d
        return () => {}
      },
    },
    logger: { warn },
  } as unknown as Context
  return { ctx, warn, tool: () => definition! }
}

/** 打分函数：给指定文本 1 分，其余 0 分。 */
function scoring(favor: string): RerankClient {
  return { model: 'fake-reranker', rerank: async (_q, texts) => texts.map((t) => (t === favor ? 1 : 0)) }
}

const BASE = { realm: 'realm-a', roles: ['viewer'], defaultTopK: 2 }

describe('knowledge_query rerank 接入', () => {
  it('overfetches candidates so the reranker has something to reorder', async () => {
    const { seam, query } = seamReturning([hit('d1', '甲', 0.9)])
    const { ctx, tool } = captureTool()
    defineKnowledgeTool(ctx, seam, { ...BASE, rerank: scoring('甲'), overfetchFactor: 3 })

    await tool().execute({ question: '问' }, {} as ToolRunContext)

    // 不过量召回，rerank 拿到的候选集就是最终结果集，重排无空间（spec §3）。
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ topK: 6 }))
  })

  it('returns the reranked order truncated to topK', async () => {
    const { seam } = seamReturning([hit('d1', '甲', 0.9), hit('d2', '乙', 0.5), hit('d3', '丙', 0.1)])
    const { ctx, tool } = captureTool()
    // 向量序是 d1 > d2 > d3；reranker 认为 d3 最相关。
    defineKnowledgeTool(ctx, seam, { ...BASE, rerank: scoring('丙'), overfetchFactor: 3 })

    const out = (await tool().execute({ question: '问' }, {} as ToolRunContext)) as Hits

    expect(out.hits.map((h) => h.docId)).toEqual(['d3', 'd1'])
  })

  it('falls back to the vector order when the reranker fails', async () => {
    const { seam } = seamReturning([hit('d1', '甲', 0.9), hit('d2', '乙', 0.5), hit('d3', '丙', 0.1)])
    const { ctx, warn, tool } = captureTool()
    const broken: RerankClient = {
      model: 'fake-reranker',
      rerank: async () => {
        throw new Error('tei-rerank 不可达')
      },
    }
    defineKnowledgeTool(ctx, seam, { ...BASE, rerank: broken, overfetchFactor: 3 })

    const out = (await tool().execute({ question: '问' }, {} as ToolRunContext)) as Hits

    // §2.3：rerank 失败的后果是「顺序次优」而非「内容错误」，故 fail-open 而非
    // 照抄 embedding 的 CapabilityUnavailable —— 否则 reranker 一挂知识库整个不可用。
    expect(out.hits.map((h) => h.docId)).toEqual(['d1', 'd2'])
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the pre-rerank behaviour when no reranker is configured', async () => {
    const { seam, query } = seamReturning([hit('d1', '甲', 0.9), hit('d2', '乙', 0.5)])
    const { ctx, tool } = captureTool()
    defineKnowledgeTool(ctx, seam, { ...BASE })

    const out = (await tool().execute({ question: '问' }, {} as ToolRunContext)) as Hits

    // 未配置 rerank 的部署不得因本轮改动而改变行为（spec §8 验收 4）。
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ topK: 2 }))
    expect(out.hits.map((h) => h.docId)).toEqual(['d1', 'd2'])
  })
})
