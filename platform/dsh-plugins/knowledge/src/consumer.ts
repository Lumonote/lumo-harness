/**
 * 知识库 Consumer：把 `ctx.knowledge` 暴露为模型可见的 RAG 检索工具。
 * 安全边界（§5.4.1 / 铁律 17）：realm 与角色由装配层固定注入（模型不可改）；
 * 只检索 published 快照，草稿永不进入模型上下文。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { KNOWLEDGE_TOOL_QUERY, type KnowledgeSeam, type KnowledgeSessionScope } from '../../../shared/seam-contracts/knowledge.ts'
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

/** Shared execution face; callers supply identity, never a synthetic DSH Agent. */
export interface KnowledgeQueryTool {
  realm: string
  parameters: ToolDefinition['parameters']
  execute(args: unknown, context: { sessionRef?: string; userId?: string; signal?: AbortSignal }): Promise<{ hits: Array<{ docId: string; text: string; score: number }> }>
}

export function defineKnowledgeTool(
  ctx: Context,
  seam: KnowledgeSeam,
  config: KnowledgeToolConfig,
  scope: KnowledgeSessionScope,
  publish?: (tool: KnowledgeQueryTool) => void,
): () => void {
  const sessionUserId = (exec: ToolRunContext): string | undefined => {
    const session = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id
    return session === undefined || session === null ? undefined : scope.userIdFor?.(String(session))
  }
  const definition: ToolDefinition = {
    name: KNOWLEDGE_TOOL_QUERY,
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
    execute(args: unknown, exec: ToolRunContext) {
      const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id, userId = sessionUserId(exec)
      return run(args, { ...(id == null ? {} : { sessionRef: String(id) }), ...(userId ? { userId } : {}), ...((exec as { signal?: AbortSignal }).signal ? { signal: (exec as { signal?: AbortSignal }).signal } : {}) })
    },
  }
  const run: KnowledgeQueryTool['execute'] = async (args, context) => {
      const scopedUser = context.sessionRef ? scope.userIdFor?.(context.sessionRef) : undefined
      if (scopedUser && context.userId && scopedUser !== context.userId) throw new Error('knowledge: 会话身份不匹配')
      const { question, topK } = args as { question?: string; topK?: number }
      context.signal?.throwIfAborted()
      if (typeof question !== 'string' || !question.trim()) throw new Error('knowledge_query: question 不能为空')
      if (topK !== undefined && (!Number.isFinite(topK) || topK <= 0)) throw new Error('knowledge_query: topK 必须为正数')
      const k = Math.floor(Math.min(Math.max(topK ?? config.defaultTopK, 1), config.defaultTopK * 4))
      // 过量召回给重排留出空间；未配置 reranker 时倍数恒为 1，检索量不变。
      const factor = config.rerank ? Math.max(config.overfetchFactor ?? DEFAULT_OVERFETCH_FACTOR, 1) : 1
      const candidates = await seam.query({
        realm: config.realm,
        roles: config.roles,
        ...(context.userId === undefined ? {} : { userId: context.userId }),
        text: question,
        topK: k * factor,
        scope: 'published', // 铁律 17：模型只读发布态
        // 这一次会话的收窄条件（受治理执行按预设设的）。**没设过就是 undefined**，
        // 而 `spaces: undefined` 与省略同义（不按空间收窄）——契约里那条区分在
        // Provider 侧实现，这里只负责如实传下去，不在这里替它做判断。
        spaces: context.sessionRef ? scope.spacesFor(context.sessionRef) : undefined,
      })
      const hits = await rerankHits(config.rerank, question, candidates, k, (reason) =>
        ctx.logger.warn('knowledge: 重排降级为向量原序: %s', reason),
      )
      context.signal?.throwIfAborted()
      return {
        hits: hits.map((h) => ({ docId: h.docId, text: h.text, score: h.score })),
      }
  }
  publish?.({ realm: config.realm, parameters: definition.parameters, execute: run })

  return ctx.tools.register(definition)
}
