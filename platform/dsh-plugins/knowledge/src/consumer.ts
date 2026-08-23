/**
 * 知识库 Consumer：把 `ctx.knowledge` 暴露为模型可见的 RAG 检索工具。
 * 安全边界（§5.4.1 / 铁律 17）：realm 与角色由装配层固定注入（模型不可改）；
 * 只检索 published 快照，草稿永不进入模型上下文。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'

export interface KnowledgeToolConfig {
  /** 本 agent 的 realm —— 工具固定注入，模型不可改（§5.4.1 硬规矩） */
  realm: string
  /** 检索角色（Provider 层 OPA 校验名单） */
  roles: string[]
  defaultTopK: number
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
      const hits = await seam.query({
        realm: config.realm,
        roles: config.roles,
        text: question,
        topK: k,
        scope: 'published', // 铁律 17：模型只读发布态
      })
      return {
        hits: hits.map((h) => ({ docId: h.docId, text: h.text, score: h.score })),
      }
    },
  }
  return ctx.tools.register(definition)
}
