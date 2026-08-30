import { describe, expect, it, vi } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { defineGraphRagTool } from '../src/graph-rag.ts'
import type { RerankClient } from '../src/rerank.ts'
import type {
  KnowledgeHit,
  KnowledgeQuery,
  KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'

type Result = {
  hits: Array<{ docId: string; text: string; score: number }>
  related: Array<{ id: string; kind: string; label: string }>
}

function hit(docId: string, text: string, score: number): KnowledgeHit {
  return { docId, sourceVersion: 1, score, text }
}

function vectorReturning(hits: KnowledgeHit[]) {
  const query = vi.fn(async (_request: KnowledgeQuery) => hits)
  const seam = {
    ingest: vi.fn(async () => undefined),
    query,
    remove: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
  } satisfies KnowledgeSeam
  return { seam, query }
}

function graphSeam() {
  const neighborhood = vi.fn(async () => ({
    origin: '',
    nodes: [],
    edges: [],
    depth: 1,
    truncated: false,
  }))
  const seam = {
    upsertNodes: vi.fn(async () => undefined),
    upsertEdges: vi.fn(async () => undefined),
    neighborhood,
    removeNode: vi.fn(async () => undefined),
  } as unknown as GraphSeam
  return { seam, neighborhood }
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

function scoring(favor: string): RerankClient {
  return { model: 'fake-reranker', rerank: async (_q, texts) => texts.map((t) => (t === favor ? 1 : 0)) }
}

const BASE = { realm: 'realm-a', roles: ['viewer'], defaultTopK: 2, graphDepth: 1, graphMaxNodes: 50 }

describe('knowledge_graph_query rerank 接入', () => {
  it('overfetches candidates before reranking', async () => {
    const { seam: vector, query } = vectorReturning([hit('d1', '甲', 0.9)])
    const { seam: graph } = graphSeam()
    const { ctx, tool } = captureTool()
    defineGraphRagTool(ctx, vector, graph, { ...BASE, rerank: scoring('甲'), overfetchFactor: 3 })

    await tool().execute({ question: '问' }, {} as ToolRunContext)

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ topK: 6 }))
  })

  it('expands the graph from the reranked origins, not the raw candidate set', async () => {
    const { seam: vector } = vectorReturning([
      hit('d1', '甲', 0.9),
      hit('d2', '乙', 0.5),
      hit('d3', '丙', 0.1),
    ])
    const { seam: graph, neighborhood } = graphSeam()
    const { ctx, tool } = captureTool()
    defineGraphRagTool(ctx, vector, graph, { ...BASE, rerank: scoring('丙'), overfetchFactor: 3 })

    const out = (await tool().execute({ question: '问' }, {} as ToolRunContext)) as Result

    // 重排必须发生在扩图之前：origins 由 hits 派生，拿未重排的 3 倍候选扩图
    // 会让图代价翻三倍并引入噪声。
    expect(out.hits.map((h) => h.docId)).toEqual(['d3', 'd1'])
    expect(neighborhood).toHaveBeenCalledWith(expect.objectContaining({ origins: ['d3', 'd1'] }))
  })

  it('falls back to the vector order when the reranker fails', async () => {
    const { seam: vector } = vectorReturning([
      hit('d1', '甲', 0.9),
      hit('d2', '乙', 0.5),
      hit('d3', '丙', 0.1),
    ])
    const { seam: graph, neighborhood } = graphSeam()
    const { ctx, warn, tool } = captureTool()
    const broken: RerankClient = {
      model: 'fake-reranker',
      rerank: async () => {
        throw new Error('tei-rerank 不可达')
      },
    }
    defineGraphRagTool(ctx, vector, graph, { ...BASE, rerank: broken, overfetchFactor: 3 })

    const out = (await tool().execute({ question: '问' }, {} as ToolRunContext)) as Result

    expect(out.hits.map((h) => h.docId)).toEqual(['d1', 'd2'])
    expect(neighborhood).toHaveBeenCalledWith(expect.objectContaining({ origins: ['d1', 'd2'] }))
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the pre-rerank behaviour when no reranker is configured', async () => {
    const { seam: vector, query } = vectorReturning([hit('d1', '甲', 0.9), hit('d2', '乙', 0.5)])
    const { seam: graph } = graphSeam()
    const { ctx, tool } = captureTool()
    defineGraphRagTool(ctx, vector, graph, { ...BASE })

    const out = (await tool().execute({ question: '问' }, {} as ToolRunContext)) as Result

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ topK: 2 }))
    expect(out.hits.map((h) => h.docId)).toEqual(['d1', 'd2'])
  })
})
