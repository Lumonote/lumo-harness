/**
 * @lumo/knowledge —— 知识库组件（组件化契约 §4.3 首次落地）。
 *
 * 提供两个并列 seam（§5.4.5 GraphRAG 的两条腿）：
 *   - `ctx.knowledge`      向量语义召回（契约 shared/seam-contracts/knowledge.ts）
 *   - `ctx.knowledgeGraph` 图关系扩展（契约 shared/seam-contracts/graph.ts）
 * 以及两个 Consumer 工具：`knowledge_query`（纯向量）与
 * `knowledge_graph_query`（向量召回 → 图邻域扩展），均只读 published（铁律 17）。
 *
 * 插件形态：与 dsh 官方插件一致（tmux-context 惯例：
 * `export const inject` / `interface Config` + `const Config: z<Config>` /
 * `apply(ctx, config)`；额外提供 default 导出供 loader unwrap 兜底）。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { PgKnowledgeProvider } from './pg-provider.ts'
import { defineKnowledgeTool } from './consumer.ts'
import { createSessionScope } from './session-scope.ts'
import { TeiClient } from './embedding.ts'
import { PgGraphProvider } from './graph-provider.ts'
import { GraphProjector } from './graph-projector.ts'
import { defineGraphRagTool } from './graph-rag.ts'
import { MilvusKnowledgeProvider, NebulaGraphProvider } from './remote-provider.ts'
import { TeiRerankClient } from './rerank.ts'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'

export interface EmbeddingConfig {
  /** TEI HTTP 地址（deploy/compose.local.yml 的 lumo-platform-tei :55433） */
  baseUrl: string
  /** 模型标识（记录/版本化用；§5.4.4 换模型须换 collection） */
  model: string
  /** 向量维度（须与模型一致；bge-m3=1024） */
  dimension: number
  timeoutMs?: number
}

/** 图侧参数（Local-lite 用 PG 递归 CTE；Standalone+ 换 Nebula Provider，契约不变） */
export interface GraphConfig {
  /** 默认图扩展跳数（1–3；缺省 1 跳，代价可控） */
  depth?: number
  /** 单次邻域扩展的节点上限（缺省 50；超出显式标记 truncated） */
  maxNodes?: number
  /** outbox → 图 的投影轮询间隔 ms（缺省 2000） */
  projectIntervalMs?: number
  /** 单轮投影搬运条数上限（缺省 100） */
  projectBatchSize?: number
}

export interface KnowledgeConfig {
  /** Remote mode registers consumers against the seams supplied by seam-proxy. */
  providerMode?: 'local' | 'remote'
  /** pgvector 连接串。standalone/cluster 形态应切换 milvus provider（同契约） */
  connectionString: string
  /** 本节点/本 agent 的 realm —— 检索隔离边界（§5.4.1） */
  realm: string
  /** 允许检索角色（OPA 下沉实现；缺省 viewer） */
  roles?: string[]
  /** RAG 检索默认 topK */
  defaultTopK?: number
  /** 向量来源（默认 TEI/bge-m3） */
  embedding: EmbeddingConfig
  /** Standalone/Cluster Milvus REST v2 地址；为空时使用 pgvector */
  milvusUrl?: string
  milvusCollection?: string
  /** 发布源的全量回放接口；配置后 provider.rebuild 可执行。 */
  milvusRebuildUrl?: string
  /** Nebula graphd adapter 地址；为空时使用 PG recursive CTE */
  nebulaUrl?: string
  remoteApiKey?: string
  /** 图扩展参数（缺省 1 跳 / 50 节点） */
  graph?: GraphConfig
  /** 交叉编码器重排（§5.4.5）；**不配则完全不重排**，行为与引入本功能之前一致 */
  rerank?: RerankConfig
}

/** 重排参数（§5.4.5）。与 embedding 分属两个 TEI 实例：模型不同，不可复用同一地址。 */
export interface RerankConfig {
  /** TEI reranker 地址（deploy/compose.local.yml 的 lumo-platform-tei-rerank :55434） */
  baseUrl: string
  /** 模型标识（记录用；bge-reranker-v2-m3 或体感不足时的 bge-reranker-base） */
  model: string
  /** 粗召回倍数（缺省 3）。不过量召回则重排无空间，见 rerank.ts */
  overfetchFactor?: number
  timeoutMs?: number
}

/** Schemastery validation for {@link KnowledgeConfig}（可选性由 interface 的 `?` 表达） */
export const Config: z<KnowledgeConfig> = z.object({
  providerMode: z.union(['local', 'remote'] as const),
  connectionString: z.string(),
  realm: z.string(),
  roles: z.array(z.string()),
  defaultTopK: z.number(),
  embedding: z.object({
    baseUrl: z.string(),
    model: z.string(),
    dimension: z.number(),
    timeoutMs: z.number(),
  }),
  milvusUrl: z.string(),
  milvusCollection: z.string(),
  milvusRebuildUrl: z.string(),
  nebulaUrl: z.string(),
  remoteApiKey: z.string(),
  graph: z.object({
    depth: z.number(),
    maxNodes: z.number(),
    projectIntervalMs: z.number(),
    projectBatchSize: z.number(),
  }),
  rerank: z.object({
    baseUrl: z.string(),
    model: z.string(),
    overfetchFactor: z.number(),
    timeoutMs: z.number(),
  }),
})

/** 两个 seam 并列挂在同一 Context 上；Consumer 只声明 consumes，不感知引擎（铁律 21） */
declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: KnowledgeSeam
    knowledgeGraph: GraphSeam
  }
}

/** 依赖注入：ctx.tools 必须先于本插件 mount（Consumer 注册工具面） */
export const inject = ['tools']

export function apply(ctx: Context, config: KnowledgeConfig): void {
  const roles = config.roles ?? ['viewer']
  const defaultTopK = config.defaultTopK ?? 5
  const remote = config.providerMode === 'remote'

  const embedding = new TeiClient({
    baseUrl: config.embedding.baseUrl,
    model: config.embedding.model,
    dimension: config.embedding.dimension,
    timeoutMs: config.embedding.timeoutMs,
  })
  const vectorProjection = !remote && config.milvusUrl
    ? new MilvusKnowledgeProvider({ baseUrl: config.milvusUrl, apiKey: config.remoteApiKey,
      allowedRoles: roles, collection: config.milvusCollection ?? `knowledge_${config.embedding.model}`, embedding, embeddingModel: config.embedding.model,
      dimension: config.embedding.dimension, rebuildUrl: config.milvusRebuildUrl })
    : undefined
  const provider: KnowledgeSeam = remote ? ctx.knowledge
    : new PgKnowledgeProvider({ connectionString: config.connectionString, allowedRoles: roles, embedding, embeddingModel: config.embedding.model, vectorProjection })
  // 图 Provider 自持连接池：两个 seam 生命周期独立，换 Nebula 时不牵动向量侧
  const graph: GraphSeam = remote ? ctx.knowledgeGraph : config.nebulaUrl
    ? new NebulaGraphProvider({ baseUrl: config.nebulaUrl, apiKey: config.remoteApiKey, allowedRoles: roles })
    : new PgGraphProvider({ connectionString: config.connectionString, allowedRoles: roles })
  // outbox 投影器：把 ingest 写下的图投影意图异步搬进图（最终一致，见 graph-projector.ts）
  if (!provider || !graph) throw new Error('knowledge: remote mode requires knowledge and knowledgeGraph seams')
  const projector = remote ? undefined : new GraphProjector(
    { connectionString: config.connectionString, batchSize: config.graph?.projectBatchSize },
    graph,
  )

  ctx.effect(() => () => {
    if (remote) return
    if ('close' in provider && typeof provider.close === 'function') void provider.close()
    if ('close' in graph && typeof graph.close === 'function') void graph.close()
    void projector?.close()
  })

  // seam 注册：一 ctx 一 provider（重复注册抛错是 Cordis 标准行为）
  if (!remote) {
    ctx.provide('knowledge', provider)
    ctx.provide('knowledgeGraph', graph)
  }

  // 交叉编码器重排（§5.4.5）。未配置 → undefined → 两个 Consumer 完全不重排、不过量召回。
  const rerank = config.rerank
    ? new TeiRerankClient({
        baseUrl: config.rerank.baseUrl,
        model: config.rerank.model,
        timeoutMs: config.rerank.timeoutMs,
      })
    : undefined
  const overfetchFactor = config.rerank?.overfetchFactor

  // 会话级的知识空间收窄（受治理执行按预设设、工具按会话读）。**provide 出去是为了让
  // 设它的那一方不必直连本插件的内部状态**——与 `meteringCaps` 同一条理由。
  const scope = createSessionScope()
  ctx.provide('knowledgeScope', scope)

  // Consumer 1：纯向量 RAG（装配层固定 realm、只读 published —— 铁律 17）
  const unregister = defineKnowledgeTool(ctx, provider, {
    realm: config.realm,
    roles,
    defaultTopK,
    rerank,
    overfetchFactor,
  }, scope)
  // Consumer 2：GraphRAG（向量召回 → 重排 → 图邻域扩展；输出带 provenance 标记，评审 R5）
  const unregisterGraph = defineGraphRagTool(ctx, provider, graph, {
    realm: config.realm,
    roles,
    defaultTopK,
    graphDepth: config.graph?.depth ?? 1,
    graphMaxNodes: config.graph?.maxNodes ?? 50,
    rerank,
    overfetchFactor,
  }, scope)
  ctx.effect(() => () => {
    unregister()
    unregisterGraph()
  })
  if (remote || !projector) return

  // 幂等初始化（建表/索引）；失败即加载失败（响亮失败，§15）
  // 投影轮询必须等建表完成再起，否则前几轮全是「表不存在」噪音。
  const providerInit = (provider as KnowledgeSeam & { init?: () => Promise<void> }).init?.() ?? Promise.resolve()
  const graphInit = (graph as GraphSeam & { init?: () => Promise<void> }).init?.() ?? Promise.resolve()
  const ready = Promise.all([providerInit, graphInit])

  // unref 不阻塞进程退出；插件卸载时随 effect 一起清掉。
  // 投影失败只 warn 不抛 —— outbox 未标记 projected_at，下一轮自然重放。
  const intervalMs = Math.max(config.graph?.projectIntervalMs ?? 2000, 200)
  ctx.effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false
    void ready.then(() => {
      if (disposed) return
      timer = setInterval(() => {
        projector.drain().catch((e: unknown) => {
          ctx.logger.warn('knowledge: 图投影失败（将在下一轮重放）: %s', e)
        })
        if (provider instanceof PgKnowledgeProvider) {
          void provider.drainVectorProjection().catch((error: unknown) => {
            ctx.logger.warn('knowledge: vector projection failed; retrying from outbox: %s', error)
          })
        }
      }, intervalMs)
      timer.unref?.()
    }).catch((e: unknown) => {
      ctx.logger.error('knowledge: 初始化失败，图投影未启动: %s', e)
    })
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
    }
  })
}

export default apply
export type { KnowledgeSeam, GraphSeam }
