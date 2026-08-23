/**
 * KnowledgeSeam 的 pgvector Provider（Local-lite / 低规模 Standalone 用）。
 * 接口契约：platform/shared/seam-contracts/knowledge.ts —— Provider 必须通过契约断言。
 * 安全边界（§5.4.1）：realm 过滤条件由 Provider 强制注入；角色越权直接拒绝。
 * 向量：注入 EmbeddingClient（默认 TEI）；维度驱动 DDL 与检索（§5.4.4 模型版本。
 */
import pg from 'pg'
import {
  type KnowledgeDoc,
  type KnowledgeHit,
  type KnowledgeIngest,
  type KnowledgeQuery,
  type KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'
import type { EmbeddingClient } from './embedding.ts'

/** 幂等初始化：建表 + 建索引（含动态维度 vector(n)） */
export function ddl(dimension: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id       TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL,
  realm          TEXT NOT NULL,
  space          TEXT NOT NULL,
  title          TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  embedding_model TEXT NOT NULL,
  chunk_index    INTEGER NOT NULL,
  text           TEXT NOT NULL,
  vector         vector(${dimension}) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_realm_doc ON knowledge_chunks (realm, doc_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_vec_hnsw ON knowledge_chunks
  USING hnsw (vector vector_cosine_ops);

CREATE TABLE IF NOT EXISTS knowledge_tombstones (
  doc_id     TEXT PRIMARY KEY,
  realm      TEXT NOT NULL,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`
}

export interface PgProviderConfig {
  connectionString: string
  /** 允许检索知识库的角色名单（OPA 单点评估的下沉实现；不在名单内 → 拒绝） */
  allowedRoles: string[]
  /** 向量来源（EmbeddingClient；默认 TeiClient，维度与模型对齐） */
  embedding: EmbeddingClient
  /** 用于向量–模型一致的校验 token（§5.4.4） */
  embeddingModel: string
}

export class PgKnowledgeProvider implements KnowledgeSeam {
  private pool: pg.Pool
  private readonly allowedRoles: ReadonlySet<string>
  private readonly embedding: EmbeddingClient
  private readonly embeddingModel: string

  constructor(config: PgProviderConfig) {
    this.pool = new pg.Pool({ connectionString: config.connectionString })
    this.allowedRoles = new Set(config.allowedRoles)
    this.embedding = config.embedding
    this.embeddingModel = config.embeddingModel
  }

  async init(): Promise<void> {
    await this.pool.query(ddl(this.embedding.dimension))
  }

  private embed(text: string): Promise<number[]> {
    return this.embedding.embed([text]).then(([v]) => v!)
  }

  async ingest(entry: KnowledgeIngest): Promise<void> {
    const { doc, chunks } = entry
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const vectors = await this.embedding.embed(chunks.map((c) => c.text))
      for (const [i, chunk] of chunks.entries()) {
        await client.query(
          `INSERT INTO knowledge_chunks
             (chunk_id, doc_id, realm, space, title, source_version, embedding_model, chunk_index, text, vector)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
             text = EXCLUDED.text, vector = EXCLUDED.vector, source_version = EXCLUDED.source_version`,
          [`${doc.docId}:${i}`, doc.docId, doc.realm, doc.space, doc.title, doc.sourceVersion,
           doc.embeddingModel, i, chunk.text, JSON.stringify(vectors[i])],
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async query(request: KnowledgeQuery): Promise<KnowledgeHit[]> {
    // 角色越权 → 显式拒绝（§6.3 OPA 下沉；不静默返回空）
    if (!request.roles.some((r) => this.allowedRoles.has(r))) {
      throw new Error(`PgKnowledgeProvider: 角色 ${request.roles.join(',')} 无知识库检索权限`)
    }
    const vector = await this.embed(request.text)
    const rows = await this.pool.query<{
      doc_id: string
      source_version: number
      text: string
      distance: number
    }>(
      `SELECT doc_id, source_version, text, 1 - (vector <=> $1::vector) AS distance
       FROM knowledge_chunks
       WHERE realm = $2 AND embedding_model = $3 AND vector IS NOT NULL
       ORDER BY vector <=> $1::vector
       LIMIT $4`,
      [JSON.stringify(vector), request.realm, this.embeddingModel, request.topK],
    )
    return rows.rows.map((r) => ({
      docId: r.doc_id,
      sourceVersion: r.source_version,
      score: r.distance,
      text: r.text,
    }))
  }

  async remove(docId: string, realm: string): Promise<void> {
    await this.pool.query('DELETE FROM knowledge_chunks WHERE doc_id = $1 AND realm = $2', [docId, realm])
    await this.pool.query(
      `INSERT INTO knowledge_tombstones (doc_id, realm) VALUES ($1,$2)
       ON CONFLICT (doc_id) DO UPDATE SET removed_at = now()`,
      [docId, realm],
    )
  }

  async rebuild(_realm: string): Promise<void> {
    // ∎ P2：从 MinIO/PG 源全量重建（§5.4.3 一等交付物）；当前为空实现 —— 重建语义由 ingest 重新注入
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export type { KnowledgeDoc, KnowledgeHit }
