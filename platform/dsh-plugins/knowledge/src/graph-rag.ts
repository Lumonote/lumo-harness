/**
 * GraphRAG Consumer（§5.4.5）：向量召回 → 图邻域扩展 → 组装上下文。
 *
 * 安全（评审 R5 / §5.4.5）：外部检索内容必须带 **provenance 标记**，
 * 与用户输入区分，供 OPA 在 tools/pre-execute 收窄该 turn 的工具集 ——
 * 防止知识库文档里的注入指令劫持 agent。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'

export interface GraphRagConfig {
  realm: string
  roles: string[]
  defaultTopK: number
  /** 图扩展跳数（1–3；默认 1 跳，代价可控） */
  graphDepth: number
  /** 图扩展节点上限 */
  graphMaxNodes: number
}

export function defineGraphRagTool(
  ctx: Context,
  vector: KnowledgeSeam,
  graph: GraphSeam,
  config: GraphRagConfig,
): () => void {
  const definition: ToolDefinition = {
    name: 'knowledge_graph_query',
    description:
      '知识库深度检索：先语义召回相关文档，再沿知识图谱扩展关联实体与上下文。'
      + '适用于需要理解实体关系、溯源或跨文档关联的问题。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '检索的语义内容' },
        topK: { type: 'number', description: `向量召回条数（默认 ${config.defaultTopK}）` },
        depth: { type: 'number', description: `图扩展跳数 1-3（默认 ${config.graphDepth}）` },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['provenance', 'hits', 'related'],
        properties: {
          // provenance：显式标注为外部检索内容（R5 上下文来源标记）
          provenance: { type: 'string' },
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
          related: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'kind', 'label'],
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                label: { type: 'string' },
              },
            },
          },
          relations: {
            type: 'array',
            items: {
              type: 'object',
              required: ['from', 'to', 'kind'],
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                kind: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, _exec: ToolRunContext): Promise<unknown> {
      const { question, topK, depth } = args as {
        question?: string; topK?: number; depth?: number
      }
      if (!question?.trim()) throw new Error('knowledge_graph_query: question 不能为空')

      // 阶段 1：向量召回（只读 published —— 铁律 17）
      const k = Math.min(Math.max(topK ?? config.defaultTopK, 1), config.defaultTopK * 4)
      const hits = await vector.query({
        realm: config.realm,
        roles: config.roles,
        text: question,
        topK: k,
        scope: 'published',
      })

      // 阶段 2：图邻域扩展（以召回的 docId 为起点）
      const origins = [...new Set(hits.map((h) => h.docId))]
      const hood = origins.length === 0
        ? { nodes: [], edges: [], truncated: false, origin: '', depth: 0 }
        : await graph.neighborhood({
            realm: config.realm,
            roles: config.roles,
            origins,
            depth: Math.min(Math.max(depth ?? config.graphDepth, 1), 3),
            maxNodes: config.graphMaxNodes,
          })

      return {
        // 该字段让模型与策略层都能识别：以下是外部检索内容，非用户指令
        provenance: 'external:knowledge-base',
        hits: hits.map((h) => ({ docId: h.docId, text: h.text, score: h.score })),
        related: hood.nodes
          .filter((n) => !origins.includes(n.id))
          .map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
        relations: hood.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
        truncated: hood.truncated,
      }
    },
  }
  return ctx.tools.register(definition)
}
