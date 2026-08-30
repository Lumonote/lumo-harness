/**
 * 知识库 Consumer：把 `ctx.knowledge` 暴露为模型可见的 RAG 检索工具。
 * 安全边界（§5.4.1 / 铁律 17）：realm 与角色由装配层固定注入（模型不可改）；
 * 只检索 published 快照，草稿永不进入模型上下文。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import { DEFAULT_OVERFETCH_FACTOR, rerankHits, type RerankClient } from './rerank.ts'

export interface KnowledgeToolConfig {
  /** 本 agent 的 realm —— 工具固定注入，模型不可改（§5.4.1 硬规矩） */
  realm: string
  /** 检索角色（Provider 层 OPA 校验名单） */
  roles: string[]
  defaultTopK: number
  /** 交叉编码器重排（§5.4.5）；不配则保持向量原序，行为与引入 rerank 之前一致 */
  rerank?: RerankClient
  /** 粗召回倍数（默认 3）；仅在配置了 rerank 时生效 */
  overfetchFactor?: number
}

export function defineKnowledgeTool(
  ctx: Context,
  seam: KnowledgeSeam,
  config: KnowledgeToolConfig,
): () => void {
  const definition: ToolDefinition = {
    name: 'knowledge_query',
    description: '在知识库中检索与问题相关的已发布文档片段，供回答问题时引用。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '检索的语义内容' },
        topK: { type: 'number', description: `返回片段数上限（默认 ${config.defaultTopK}）` },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['hits'],
        properties: {
          hits: {
            type: 'array',
            items: {
              type: 'object',
              required: ['docId', 'text', 'score'],
              properties: {
                docId: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(
      args: unknown,
      _exec: ToolRunContext,
    ): Promise<{ hits: Array<{ docId: string; text: string; score: number }> }> {
      const { question, topK } = args as { question?: string; topK?: number }
      if (!question?.trim()) throw new Error('knowledge_query: question 不能为空')
      const k = Math.min(Math.max(topK ?? config.defaultTopK, 1), config.defaultTopK * 4)
      // 过量召回给重排留出空间；未配置 reranker 时倍数恒为 1，检索量不变。
      const factor = config.rerank ? Math.max(config.overfetchFactor ?? DEFAULT_OVERFETCH_FACTOR, 1) : 1
      const candidates = await seam.query({
        realm: config.realm,
        roles: config.roles,
        text: question,
        topK: k * factor,
        scope: 'published', // 铁律 17：模型只读发布态
      })
      const hits = await rerankHits(config.rerank, question, candidates, k, (reason) =>
        ctx.logger.warn('knowledge: 重排降级为向量原序: %s', reason),
      )
      return {
        hits: hits.map((h) => ({ docId: h.docId, text: h.text, score: h.score })),
      }
    },
  }
  return ctx.tools.register(definition)
}
