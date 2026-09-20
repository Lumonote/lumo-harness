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

export function defineKnowledgeTool(
  ctx: Context,
  seam: KnowledgeSeam,
  config: KnowledgeToolConfig,
  scope: KnowledgeSessionScope,
): () => void {
  /**
   * 这一次会话允许的空间。读的是 `exec.agent.session.id`——与 `@lumo/control` 读控制状态
   * 同一个形状，因为工具执行时拿不到 agent 的作用域（`Agent.ctx` 是私有的）。
   *
   * 取不到会话（例如 PTC 之类的合成调用）时返回 `undefined` = 不按空间收窄。**这与
   * 「读不到收窄条件」是同一条语义**：收窄是调用方设的，没设就是不设限——而它不是安全
   * 边界，realm 才是（见契约里那段）。
   */
  const sessionSpaces = (exec: ToolRunContext): readonly string[] | undefined => {
    const session = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id
    return session === undefined || session === null ? undefined : scope.spacesFor(String(session))
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
    async execute(
      args: unknown,
      exec: ToolRunContext,
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
        // 这一次会话的收窄条件（受治理执行按预设设的）。**没设过就是 undefined**，
        // 而 `spaces: undefined` 与省略同义（不按空间收窄）——契约里那条区分在
        // Provider 侧实现，这里只负责如实传下去，不在这里替它做判断。
        spaces: sessionSpaces(exec),
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
