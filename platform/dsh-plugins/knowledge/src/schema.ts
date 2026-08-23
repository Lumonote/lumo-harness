/**
 * 知识库存储 schema（pgvector Provider 用）。
 * 遵循 architecture §5.3 治理铁律：组件绝不直连数据库（本文件属 seam Provider 层，例外）；
 * 查询一律参数化（§5.3.4）；realm 为强制过滤与隔离分区键（§5.4.1）。
 */

export const DDL = `-- 向量检索：pgvector（Local-lite 用；Standalone+ 由 Milvus Provider 提供同契约）
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
  vector         vector(1024) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_realm_doc ON knowledge_chunks (realm, doc_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_vec_hnsw ON knowledge_chunks
  USING hnsw (vector vector_cosine_ops) WHERE realm IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_tombstones (
  doc_id     TEXT PRIMARY KEY,
  realm      TEXT NOT NULL,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`

/** 检索结果行（SQL 层） */
export interface ChunkRow {
  chunk_id: string
  doc_id: string
  realm: string
  space: string
  title: string
  source_version: number
  embedding_model: string
  text: string
  distance: number
}
