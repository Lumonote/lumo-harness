/**
 * Standalone/Cluster providers.
 *
 * Milvus exposes its REST v2 entity API; Nebula is reached through the small
 * graphd adapter deployed beside it. Both adapters keep the seam contract at
 * the boundary, so consumers never need to know which topology is active.
 */
import type {
  GraphEdge, GraphNode, GraphSeam, Neighborhood, NeighborhoodQuery,
} from '../../../shared/seam-contracts/graph.ts'
import type {
  KnowledgeHit, KnowledgeIngest, KnowledgeQuery, KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'
import { forbidden } from '../../../shared/seam-contracts/errors.ts'
import type { EmbeddingClient } from './embedding.ts'

interface RemoteConfig { baseUrl: string; apiKey?: string; timeoutMs?: number; allowedRoles: string[] }

class JSONClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  constructor(config: RemoteConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.headers = { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }
    this.timeoutMs = config.timeoutMs ?? 15_000
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) }, signal: controller.signal })
      const text = await res.text()
      if (!res.ok) throw new Error(`remote provider: ${path} 返回 ${res.status}: ${text.slice(0, 300)}`)
      return (text ? JSON.parse(text) : undefined) as T
    } finally { clearTimeout(timer) }
  }
}

export interface MilvusProviderConfig extends RemoteConfig {
  collection: string
  embedding: EmbeddingClient
  embeddingModel: string
  dimension: number
  /** Source-of-truth replay endpoint, returning KnowledgeIngest[] for a realm. */
  rebuildUrl?: string
}

type MilvusResult = { data?: Array<{ doc_id: string; source_version: number; text: string; score?: number; distance?: number }> }

export class MilvusKnowledgeProvider implements KnowledgeSeam {
  private readonly client: JSONClient
  private readonly collection: string
  private readonly embedding: EmbeddingClient
  private readonly embeddingModel: string
  private readonly dimension: number
  private readonly rebuildUrl?: string
  private readonly allowedRoles: ReadonlySet<string>
  constructor(config: MilvusProviderConfig) {
    this.client = new JSONClient(config); this.collection = config.collection
    this.embedding = config.embedding; this.embeddingModel = config.embeddingModel
    this.dimension = config.dimension; this.rebuildUrl = config.rebuildUrl
    this.allowedRoles = new Set(config.allowedRoles)
  }
  async init(): Promise<void> {
    try {
      await this.client.request('/v2/vectordb/collections/describe', { method: 'POST', body: JSON.stringify({ collectionName: this.collection }) })
    } catch (error) {
      if (!String(error).includes('返回 404')) throw error
      await this.client.request('/v2/vectordb/collections/create', { method: 'POST', body: JSON.stringify({
        collectionName: this.collection, dimension: this.dimension, metricType: 'COSINE',
        idType: 'VarChar', autoID: false, primaryFieldName: 'id', vectorFieldName: 'vector',
      }) })
    }
  }
  async ingest(entry: KnowledgeIngest): Promise<void> {
    const vectors = await this.embedding.embed(entry.chunks.map((c) => c.text))
    await this.client.request('/v2/vectordb/entities/insert', { method: 'POST', body: JSON.stringify({
      collectionName: this.collection,
      data: entry.chunks.map((chunk, index) => ({ id: `${entry.doc.docId}:${index}`, doc_id: entry.doc.docId,
        realm: entry.doc.realm, space: entry.doc.space, title: entry.doc.title, source_version: entry.doc.sourceVersion,
        embedding_model: entry.doc.embeddingModel, chunk_index: index, text: chunk.text, metadata: chunk.metadata, vector: vectors[index] })),
    }) })
  }
  async query(request: KnowledgeQuery): Promise<KnowledgeHit[]> {
    this.authorize(request.roles)
    const [vector] = await this.embedding.embed([request.text])
    const result = await this.client.request<MilvusResult>('/v2/vectordb/entities/search', { method: 'POST', body: JSON.stringify({
      collectionName: this.collection, data: [vector], annsField: 'vector', limit: request.topK,
      filter: `realm == "${escapeFilter(request.realm)}" && embedding_model == "${escapeFilter(this.embeddingModel)}"`,
      outputFields: ['doc_id', 'source_version', 'text'],
    }) })
    return (result.data ?? []).map((hit) => ({ docId: hit.doc_id, sourceVersion: hit.source_version, text: hit.text, score: hit.score ?? (hit.distance === undefined ? 0 : 1 - hit.distance) }))
  }
  async remove(docId: string, realm: string): Promise<void> {
    await this.client.request('/v2/vectordb/entities/delete', { method: 'POST', body: JSON.stringify({
      collectionName: this.collection, filter: `doc_id == "${escapeFilter(docId)}" && realm == "${escapeFilter(realm)}"`,
    }) })
  }
  async rebuild(realm: string): Promise<void> {
    if (!this.rebuildUrl) throw new Error('MilvusKnowledgeProvider: rebuild 需要配置 source-of-truth rebuildUrl')
    const url = `${this.rebuildUrl.replace(/\/$/, '')}?realm=${encodeURIComponent(realm)}`
    const source = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!source.ok) throw new Error(`MilvusKnowledgeProvider: rebuild source 返回 ${source.status}`)
    const entries = await source.json() as KnowledgeIngest[]
    for (const entry of entries) {
      if (entry.doc.realm !== realm) continue
      await this.remove(entry.doc.docId, realm)
      await this.ingest(entry)
    }
  }
  async close(): Promise<void> {}
  private authorize(roles: string[]) { if (!roles.some((role) => this.allowedRoles.has(role))) throw forbidden(`MilvusKnowledgeProvider: 角色 ${roles.join(',')} 无知识库检索权限`) }
}

export interface NebulaProviderConfig extends RemoteConfig {}

export class NebulaGraphProvider implements GraphSeam {
  private readonly client: JSONClient
  private readonly allowedRoles: ReadonlySet<string>
  constructor(config: NebulaProviderConfig) { this.client = new JSONClient(config); this.allowedRoles = new Set(config.allowedRoles) }
  async init(): Promise<void> {}
  async upsertNodes(nodes: GraphNode[]): Promise<void> { if (nodes.length) await this.client.request('/v1/graph/nodes:upsert', { method: 'POST', body: JSON.stringify({ nodes }) }) }
  async upsertEdges(edges: GraphEdge[]): Promise<void> { if (edges.length) await this.client.request('/v1/graph/edges:upsert', { method: 'POST', body: JSON.stringify({ edges }) }) }
  async neighborhood(query: NeighborhoodQuery): Promise<Neighborhood> {
    if (!query.roles.some((role) => this.allowedRoles.has(role))) throw forbidden(`NebulaGraphProvider: 角色 ${query.roles.join(',')} 无图检索权限`)
    return this.client.request<Neighborhood>('/v1/graph/neighborhood', { method: 'POST', body: JSON.stringify(query) })
  }
  async removeNode(id: string, realm: string): Promise<void> { await this.client.request('/v1/graph/nodes:delete', { method: 'POST', body: JSON.stringify({ id, realm }) }) }
  async close(): Promise<void> {}
}

function escapeFilter(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') }
