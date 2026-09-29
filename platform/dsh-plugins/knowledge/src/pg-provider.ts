/**
 * KnowledgeSeam 的 pgvector Provider（Local-lite / 低规模 Standalone 用）。
 * 接口契约：platform/shared/seam-contracts/knowledge.ts —— Provider 必须通过契约断言。
 * 安全边界（§5.4.1）：realm 过滤条件由 Provider 强制注入；角色越权直接拒绝。
 * 向量：注入 EmbeddingClient（默认 TEI）；维度驱动 DDL 与检索（§5.4.4 模型版本。
 */
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import {
  type KnowledgeDoc,
  type KnowledgeHit,
  type KnowledgeIngest,
  type KnowledgeQuery,
  type KnowledgeSeam,
  type KnowledgeSourceManager,
  type KnowledgeSourceSummary,
  type KnowledgeSourceWrite,
  type KnowledgeLibraryAccess,
  type KnowledgeLibraryFile,
  type KnowledgeLibraryFolder,
  type KnowledgeLibraryManager,
  type KnowledgeLibraryPrincipal,
} from '../../../shared/seam-contracts/knowledge.ts'
import { spaceAllowed } from '../../../shared/seam-contracts/knowledge.ts'
import { forbidden } from '../../../shared/seam-contracts/errors.ts'
import type { EmbeddingClient } from './embedding.ts'
import { OUTBOX_DDL, collectProjection } from './graph-projector.ts'

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
);

-- 源文档是重建真相；向量表和图表都只是可删除的派生投影。
CREATE TABLE IF NOT EXISTS knowledge_sources (
  doc_id          TEXT PRIMARY KEY,
  realm           TEXT NOT NULL,
  space           TEXT NOT NULL,
  title           TEXT NOT NULL,
  source_version  INTEGER NOT NULL,
  embedding_model TEXT NOT NULL,
  chunks          JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 文件资料与原始对象归资料库管理；父目录 ACL 通过递归查询继承到后代。
CREATE TABLE IF NOT EXISTS knowledge_library_folders (
  folder_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (realm, folder_id),
  FOREIGN KEY (realm, parent_id) REFERENCES knowledge_library_folders (realm, folder_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_library_folder_sibling
  ON knowledge_library_folders (realm, COALESCE(parent_id, ''), lower(name));

CREATE TABLE IF NOT EXISTS knowledge_library_files (
  doc_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL,
  folder_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  extraction_state TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_state IN ('pending','ready','failed','unsupported')),
  ocr_state TEXT NOT NULL DEFAULT 'not_needed' CHECK (ocr_state IN ('not_needed','pending','ready','failed','unavailable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (realm, folder_id) REFERENCES knowledge_library_folders (realm, folder_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_library_files_realm_folder
  ON knowledge_library_files (realm, folder_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_library_folder_grants (
  realm TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','role')),
  principal_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('viewer','editor')),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, folder_id, principal_type, principal_id),
  FOREIGN KEY (realm, folder_id) REFERENCES knowledge_library_folders (realm, folder_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS knowledge_library_file_grants (
  realm TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','role')),
  principal_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('viewer','editor')),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, doc_id, principal_type, principal_id),
  FOREIGN KEY (doc_id) REFERENCES knowledge_library_files (doc_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_vector_outbox (
  realm TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (realm, doc_id)
);
${OUTBOX_DDL}`
}

export interface PgProviderConfig {
  connectionString: string
  /** 允许检索知识库的角色名单（OPA 单点评估的下沉实现；不在名单内 → 拒绝） */
  allowedRoles: string[]
  /** 向量来源（EmbeddingClient；默认 TeiClient，维度与模型对齐） */
  embedding: EmbeddingClient
  /** 用于向量–模型一致的校验 token（§5.4.4） */
  embeddingModel: string
  vectorProjection?: KnowledgeSeam & { init?: () => Promise<void>; close?: () => Promise<void> }
}

/** 供宿主 API 映射成 409，避免管理员在并发编辑时静默覆盖来源。 */
export class KnowledgeSourceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeSourceConflictError'
  }
}

type LockedSource = { realm: string; source_version: number } | undefined
type StoredSource = {
  doc_id: string; realm: string; space: string; title: string; source_version: number
  embedding_model: string; chunks: unknown
}
type LibraryFileRow = {
  doc_id: string; realm: string; folder_id: string | null; filename: string; mime_type: string
  object_key: string; byte_size: string | number; sha256: string; owner_user_id: string
  extraction_state: KnowledgeLibraryFile['extractionState']; ocr_state: KnowledgeLibraryFile['ocrState']; created_at: string
}

function libraryFile(row: LibraryFileRow): KnowledgeLibraryFile {
  return {
    docId: row.doc_id, realm: row.realm, folderId: row.folder_id, filename: row.filename, mimeType: row.mime_type,
    objectKey: row.object_key, byteSize: Number(row.byte_size), sha256: row.sha256, ownerUserId: row.owner_user_id,
    extractionState: row.extraction_state, ocrState: row.ocr_state, createdAt: row.created_at,
  }
}

function readChunks(value: unknown): KnowledgeIngest['chunks'] {
  const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(decoded) || !decoded.every(chunk => typeof chunk === 'object' && chunk !== null && typeof (chunk as { text?: unknown }).text === 'string' && typeof (chunk as { metadata?: unknown }).metadata === 'object' && (chunk as { metadata?: unknown }).metadata !== null && !Array.isArray((chunk as { metadata?: unknown }).metadata))) {
    throw new Error('knowledge source contains malformed chunks')
  }
  return decoded.map(chunk => ({
    text: (chunk as { text: string }).text,
    metadata: (chunk as { metadata: Record<string, unknown> }).metadata,
  }))
}

export class PgKnowledgeProvider implements KnowledgeSeam, KnowledgeSourceManager, KnowledgeLibraryManager {
  private pool: pg.Pool
  private readonly allowedRoles: ReadonlySet<string>
  private readonly embedding: EmbeddingClient
  private readonly embeddingModel: string
  private readonly vectorProjection?: PgProviderConfig['vectorProjection']
  private projecting = false

  constructor(config: PgProviderConfig) {
    this.pool = new pg.Pool({ connectionString: config.connectionString })
    this.allowedRoles = new Set(config.allowedRoles)
    this.embedding = config.embedding
    this.embeddingModel = config.embeddingModel
    this.vectorProjection = config.vectorProjection
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(823054)')
      await client.query(ddl(this.embedding.dimension))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
    await this.vectorProjection?.init?.()
  }

  private embed(text: string): Promise<number[]> {
    return this.embedding.embed([text]).then(([v]) => v!)
  }

  /**
   * 给单个 doc_id 加事务级锁。source 表的主键是 doc_id，因此不允许同一
   * doc_id 被另一 realm 抢占；锁还使来源管理的 compare-and-swap 可线性化。
   */
  private async lockSource(client: pg.PoolClient, docId: string): Promise<LockedSource> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [docId])
    const current = await client.query<{ realm: string; source_version: number }>(
      'SELECT realm, source_version FROM knowledge_sources WHERE doc_id = $1 FOR UPDATE', [docId],
    )
    return current.rows[0]
  }

  private assertOwner(current: LockedSource, docId: string, realm: string): void {
    if (current !== undefined && current.realm !== realm) {
      throw forbidden(`knowledge source ${docId} belongs to another realm`)
    }
  }

  /** 写 source-of-truth、向量投影和图 outbox；调用方已持有该 doc 的锁。 */
  private async writeSource(client: pg.PoolClient, entry: KnowledgeIngest, vectors: number[][]): Promise<KnowledgeSourceSummary> {
    const { doc, chunks } = entry
    const written = await client.query<{
      doc_id: string; realm: string; space: string; title: string; source_version: number; embedding_model: string; updated_at: string
    }>(
      `INSERT INTO knowledge_sources
         (doc_id, realm, space, title, source_version, embedding_model, chunks, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (doc_id) DO UPDATE SET realm = EXCLUDED.realm, space = EXCLUDED.space,
         title = EXCLUDED.title, source_version = EXCLUDED.source_version,
         embedding_model = EXCLUDED.embedding_model, chunks = EXCLUDED.chunks, updated_at = now()
       RETURNING doc_id, realm, space, title, source_version, embedding_model, updated_at::text`,
      [doc.docId, doc.realm, doc.space, doc.title, doc.sourceVersion, doc.embeddingModel, JSON.stringify(chunks)],
    )
    // 一次来源更新中的分片数可以变少；删掉尾部旧分片，防止它继续被召回。
    await client.query(
      'DELETE FROM knowledge_chunks WHERE doc_id = $1 AND realm = $2 AND chunk_index >= $3',
      [doc.docId, doc.realm, chunks.length],
    )
    for (const [i, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO knowledge_chunks
           (chunk_id, doc_id, realm, space, title, source_version, embedding_model, chunk_index, text, vector)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
           realm = EXCLUDED.realm, space = EXCLUDED.space, title = EXCLUDED.title,
           text = EXCLUDED.text, vector = EXCLUDED.vector, source_version = EXCLUDED.source_version,
           embedding_model = EXCLUDED.embedding_model`,
        [`${doc.docId}:${i}`, doc.docId, doc.realm, doc.space, doc.title, doc.sourceVersion,
         doc.embeddingModel, i, chunk.text, JSON.stringify(vectors[i])],
      )
    }
    // 重新写入同 id 的来源应取消此前的墓碑，否则投影侧会把新文档误视为已删除。
    await client.query('DELETE FROM knowledge_tombstones WHERE doc_id = $1 AND realm = $2', [doc.docId, doc.realm])
    // 图投影意图与 chunk 写入同事务（outbox；跨存储无事务，见 graph-projector.ts）
    await client.query(
      `INSERT INTO knowledge_graph_outbox (doc_id, realm, op, payload) VALUES ($1,$2,'upsert',$3)`,
      [doc.docId, doc.realm, JSON.stringify(collectProjection(doc, chunks))],
    )
    await this.enqueueVector(client, doc.docId, doc.realm)
    const row = written.rows[0]!
    return {
      docId: row.doc_id, realm: row.realm, space: row.space, title: row.title,
      sourceVersion: row.source_version, embeddingModel: row.embedding_model,
      chunkCount: chunks.length, updatedAt: row.updated_at,
    }
  }

  async ingest(entry: KnowledgeIngest): Promise<void> {
    const { doc, chunks } = entry
    // 不在事务中等待 embedding，避免网络慢时长期锁住同一来源。
    const vectors = await this.embedding.embed(chunks.map((c) => c.text))
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await this.lockSource(client, doc.docId)
      this.assertOwner(current, doc.docId, doc.realm)
      if (current !== undefined && doc.sourceVersion < current.source_version) {
        throw new KnowledgeSourceConflictError(`knowledge source ${doc.docId} has a newer version`)
      }
      await this.writeSource(client, entry, vectors)
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
      throw forbidden(`PgKnowledgeProvider: 角色 ${request.roles.join(',')} 无知识库检索权限`)
    }
    if (request.scope !== 'published') throw forbidden('knowledge: only published sources are searchable')
    if (this.vectorProjection) {
      const candidateRequest = { ...request, topK: Math.min(Math.max(request.topK, request.topK * 5), 100) }
      const hits = await this.vectorProjection.query(candidateRequest)
      if (hits.length === 0) return []
      const sources = await this.pool.query<StoredSource>(
        `SELECT doc_id, realm, space, title, source_version, embedding_model, chunks
         FROM knowledge_sources WHERE realm=$1 AND doc_id=ANY($2::text[])`,
        [request.realm, hits.map(hit => hit.docId)],
      )
      const current = new Map(sources.rows.map(source => [source.doc_id, source]))
      const currentHits = hits.filter(hit => {
        const source = current.get(hit.docId)
        return source?.source_version === hit.sourceVersion && source.embedding_model === this.embeddingModel
          // 空间收窄**在这一层做**：向量投影方（Milvus）可能不认识 `spaces`，而这一层拿到的是
          // PG 里的权威行。投影侧忽略该字段只会**少召回**（topK 里被过滤掉一部分），不会泄漏
          // ——这正是把复核放在权威源上的价值。
          && spaceAllowed(source.space, request.spaces)
          && readChunks(source.chunks).some(chunk => chunk.text === hit.text)
      })
      return this.filterLibraryHits(request, currentHits)
    }
    const vector = await this.embed(request.text)
    const rows = await this.pool.query<{
      doc_id: string
      source_version: number
      text: string
      distance: number
    }>(
      // 空间收窄在**取数之前**（`LIMIT` 之前）生效，所以它与投影那条路不同：这里过滤掉
      // 的空间根本不占 topK 名额，召回质量不受影响。
      //
      // 写法用「参数为 NULL 即不过滤」而不是把条件拼进 SQL 字符串：`undefined` → NULL →
      // 整条不生效；`[]` → 空数组 → `= ANY('{}')` 恒假 → **零条**。两种输入得到两种结果，
      // 正是契约里那条「省略 ≠ 空数组」。
      `SELECT doc_id, source_version, text, 1 - (vector <=> $1::vector) AS distance
       FROM knowledge_chunks
       WHERE realm = $2 AND embedding_model = $3 AND vector IS NOT NULL
         AND ($5::text[] IS NULL OR space = ANY($5::text[]))
       ORDER BY vector <=> $1::vector
       LIMIT $4`,
      [JSON.stringify(vector), request.realm, this.embeddingModel, Math.min(Math.max(request.topK, request.topK * 5), 100),
        request.spaces === undefined ? null : [...request.spaces]],
    )
    const hits = rows.rows.map((r) => ({
      docId: r.doc_id,
      sourceVersion: r.source_version,
      score: r.distance,
      text: r.text,
    }))
    return this.filterLibraryHits(request, hits)
  }

  private async filterLibraryHits(request: KnowledgeQuery, hits: KnowledgeHit[]): Promise<KnowledgeHit[]> {
    const allowed: KnowledgeHit[] = []
    for (const hit of hits) {
      const file = await this.getLibraryFile(hit.docId, request.realm)
      // 手工登记的旧来源没有文件 ACL，保留原有 realm/role 授权；文件资料必须有经过签名的用户身份。
      if (file === undefined) { allowed.push(hit); continue }
      if (request.libraryAdmin === true) { allowed.push(hit); continue }
      if (request.userId === undefined || request.userId === '') continue
      if (await this.canAccessLibraryFile({
        docId: hit.docId, realm: request.realm, userId: request.userId, roles: request.roles, isAdmin: false,
      })) allowed.push(hit)
    }
    return allowed.slice(0, request.topK)
  }

  async remove(docId: string, realm: string): Promise<void> {
    // 抽除、墓碑、图删除意图必须同事务：任一半成功都会留下可召回的残留（数据泄漏路径 §5.4.3）
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await this.lockSource(client, docId)
      this.assertOwner(current, docId, realm)
      await client.query('DELETE FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2', [docId, realm])
      await client.query('DELETE FROM knowledge_chunks WHERE doc_id = $1 AND realm = $2', [docId, realm])
      await client.query('DELETE FROM knowledge_sources WHERE doc_id = $1 AND realm = $2', [docId, realm])
      await client.query(
        `INSERT INTO knowledge_tombstones (doc_id, realm) VALUES ($1,$2)
         ON CONFLICT (doc_id) DO UPDATE SET removed_at = now()`,
        [docId, realm],
      )
      await client.query(
        `INSERT INTO knowledge_graph_outbox (doc_id, realm, op) VALUES ($1,$2,'remove')`,
        [docId, realm],
      )
      await this.enqueueVector(client, docId, realm)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async rebuild(realm: string): Promise<void> {
    const rows = await this.pool.query<StoredSource>(
      `SELECT doc_id, realm, space, title, source_version, embedding_model, chunks
       FROM knowledge_sources WHERE realm = $1 ORDER BY doc_id`, [realm],
    )
    // 不先清空整个 realm：否则某来源在快照与 DELETE 之间更新，会暂时或永久
    // 丢失新投影。下面以 doc 为锁粒度，仅回放仍处于同一版本的来源。
    for (const row of rows.rows) {
      const chunks = readChunks(row.chunks)
      const vectors = await this.embedding.embed(chunks.map(chunk => chunk.text))
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        const current = await this.lockSource(client, row.doc_id)
        if (current === undefined || current.realm !== realm || current.source_version !== row.source_version) {
          await client.query('COMMIT')
          continue
        }
        await this.writeSource(client, {
          doc: { docId: row.doc_id, realm, space: row.space, title: row.title, sourceVersion: row.source_version, embeddingModel: row.embedding_model },
          chunks,
        }, vectors)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }

  async listSources(realm: string): Promise<KnowledgeSourceSummary[]> {
    const rows = await this.pool.query<{
      doc_id: string; realm: string; space: string; title: string; source_version: number; embedding_model: string; chunk_count: number; updated_at: string
    }>(
      `SELECT doc_id, realm, space, title, source_version, embedding_model,
              jsonb_array_length(chunks) AS chunk_count, updated_at::text
       FROM knowledge_sources WHERE realm = $1 ORDER BY updated_at DESC, doc_id`, [realm],
    )
    return rows.rows.map(row => ({
      docId: row.doc_id, realm: row.realm, space: row.space, title: row.title,
      sourceVersion: row.source_version, embeddingModel: row.embedding_model,
      chunkCount: Number(row.chunk_count), updatedAt: row.updated_at,
    }))
  }

  async getSource(docId: string, realm: string): Promise<KnowledgeIngest | undefined> {
    const result = await this.pool.query<StoredSource>(
      `SELECT doc_id, realm, space, title, source_version, embedding_model, chunks
       FROM knowledge_sources WHERE doc_id = $1 AND realm = $2`, [docId, realm],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return {
      doc: { docId: row.doc_id, realm: row.realm, space: row.space, title: row.title, sourceVersion: row.source_version, embeddingModel: row.embedding_model },
      chunks: readChunks(row.chunks),
    }
  }

  async upsertSource(entry: KnowledgeSourceWrite): Promise<KnowledgeSourceSummary> {
    if (entry.chunks.length === 0) throw new TypeError('knowledge source requires at least one chunk')
    const vectors = await this.embedding.embed(entry.chunks.map(chunk => chunk.text))
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await this.lockSource(client, entry.docId)
      this.assertOwner(current, entry.docId, entry.realm)
      const expected = entry.expectedSourceVersion
      if (current === undefined) {
        if (expected !== undefined && expected !== 0) throw new KnowledgeSourceConflictError(`knowledge source ${entry.docId} does not exist at version ${expected}`)
      } else if (expected === undefined || expected !== current.source_version) {
        throw new KnowledgeSourceConflictError(`knowledge source ${entry.docId} changed; reload before saving`)
      }
      const sourceVersion = current === undefined ? 1 : current.source_version + 1
      const summary = await this.writeSource(client, {
        doc: { docId: entry.docId, realm: entry.realm, space: entry.space, title: entry.title, sourceVersion, embeddingModel: this.embeddingModel },
        chunks: entry.chunks,
      }, vectors)
      await client.query('COMMIT')
      return summary
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async removeSource(docId: string, realm: string, expectedSourceVersion: number): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await this.lockSource(client, docId)
      this.assertOwner(current, docId, realm)
      if (current === undefined) throw new KnowledgeSourceConflictError(`knowledge source ${docId} no longer exists`)
      if (current.source_version !== expectedSourceVersion) throw new KnowledgeSourceConflictError(`knowledge source ${docId} changed; reload before deleting`)
      await client.query('DELETE FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2', [docId, realm])
      await client.query('DELETE FROM knowledge_chunks WHERE doc_id = $1 AND realm = $2', [docId, realm])
      await client.query('DELETE FROM knowledge_sources WHERE doc_id = $1 AND realm = $2', [docId, realm])
      await client.query(
        `INSERT INTO knowledge_tombstones (doc_id, realm) VALUES ($1,$2)
         ON CONFLICT (doc_id) DO UPDATE SET removed_at = now()`,
        [docId, realm],
      )
      await client.query(
        `INSERT INTO knowledge_graph_outbox (doc_id, realm, op) VALUES ($1,$2,'remove')`,
        [docId, realm],
      )
      await this.enqueueVector(client, docId, realm)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listLibraryFolders(realm: string, userId: string, roles: string[], isAdmin: boolean): Promise<KnowledgeLibraryFolder[]> {
    const rows = await this.pool.query<{ folder_id: string; realm: string; parent_id: string | null; name: string; owner_user_id: string; created_at: string }>(
      `SELECT folder_id, realm, parent_id, name, owner_user_id, created_at::text
       FROM knowledge_library_folders WHERE realm=$1 ORDER BY lower(name), folder_id`, [realm],
    )
    const visible: KnowledgeLibraryFolder[] = []
    for (const row of rows.rows) {
      if (!isAdmin && !await this.canAccessFolder(realm, row.folder_id, userId, roles, 'viewer')) continue
      visible.push({ folderId: row.folder_id, realm: row.realm, parentId: row.parent_id, name: row.name, ownerUserId: row.owner_user_id, createdAt: row.created_at })
    }
    return visible
  }

  async canAccessLibraryFolder(input: { realm: string; folderId: string; userId: string; roles: string[]; isAdmin: boolean; access?: KnowledgeLibraryAccess }): Promise<boolean> {
    return input.isAdmin || this.canAccessFolder(input.realm, input.folderId, input.userId, input.roles, input.access ?? 'viewer')
  }

  async createLibraryFolder(input: { realm: string; parentId: string | null; name: string; ownerUserId: string; roles: string[]; isAdmin: boolean }): Promise<KnowledgeLibraryFolder> {
    const name = input.name.trim()
    if (name.length === 0 || Buffer.byteLength(name, 'utf8') > 240 || /[\\/\u0000-\u001f]/u.test(name) || name === '.' || name === '..') {
      throw new TypeError('资料文件夹名称无效')
    }
    if (input.parentId !== null && !input.isAdmin
      && !await this.canAccessFolder(input.realm, input.parentId, input.ownerUserId, input.roles, 'editor')) {
      throw forbidden('没有在此资料文件夹中创建子目录的权限')
    }
    const folderId = `folder-${randomUUID()}`
    const result = await this.pool.query<{ folder_id: string; realm: string; parent_id: string | null; name: string; owner_user_id: string; created_at: string }>(
      `INSERT INTO knowledge_library_folders (folder_id, realm, parent_id, name, owner_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING folder_id, realm, parent_id, name, owner_user_id, created_at::text`,
      [folderId, input.realm, input.parentId, name, input.ownerUserId],
    )
    const row = result.rows[0]!
    return { folderId: row.folder_id, realm: row.realm, parentId: row.parent_id, name: row.name, ownerUserId: row.owner_user_id, createdAt: row.created_at }
  }

  async deleteLibraryFolder(input: { realm: string; folderId: string; actorUserId: string; roles: string[]; isAdmin: boolean }): Promise<void> {
    if (!input.isAdmin && !await this.canAccessFolder(input.realm, input.folderId, input.actorUserId, input.roles, 'editor')) throw forbidden('没有删除该资料文件夹的权限')
    const result = await this.pool.query(
      `DELETE FROM knowledge_library_folders f WHERE f.realm=$1 AND f.folder_id=$2
       AND NOT EXISTS (SELECT 1 FROM knowledge_library_folders c WHERE c.realm=f.realm AND c.parent_id=f.folder_id)
       AND NOT EXISTS (SELECT 1 FROM knowledge_library_files d WHERE d.realm=f.realm AND d.folder_id=f.folder_id)`,
      [input.realm, input.folderId],
    )
    if (result.rowCount === 0) throw new KnowledgeSourceConflictError('资料文件夹不存在或仍含有子目录/文件')
  }

  async listLibraryFiles(realm: string, userId: string, roles: string[], isAdmin: boolean): Promise<KnowledgeLibraryFile[]> {
    const rows = await this.pool.query<LibraryFileRow>(
      `SELECT doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id,
              extraction_state, ocr_state, created_at::text
       FROM knowledge_library_files WHERE realm=$1 ORDER BY created_at DESC, doc_id`, [realm],
    )
    const visible: KnowledgeLibraryFile[] = []
    for (const row of rows.rows) {
      if (!isAdmin && !await this.canAccessLibraryFile({ docId: row.doc_id, realm, userId, roles, isAdmin, access: 'viewer' })) continue
      visible.push(libraryFile(row))
    }
    return visible
  }

  async getLibraryFile(docId: string, realm: string): Promise<KnowledgeLibraryFile | undefined> {
    const result = await this.pool.query<LibraryFileRow>(
      `SELECT doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id,
              extraction_state, ocr_state, created_at::text
       FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2`, [docId, realm],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : libraryFile(row)
  }

  async createLibraryFile(file: KnowledgeLibraryFile): Promise<void> {
    await this.pool.query(
      `INSERT INTO knowledge_library_files
         (doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id, extraction_state, ocr_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [file.docId, file.realm, file.folderId, file.filename, file.mimeType, file.objectKey, file.byteSize, file.sha256,
        file.ownerUserId, file.extractionState, file.ocrState],
    )
  }

  async removeLibraryFile(docId: string, realm: string): Promise<void> {
    await this.pool.query('DELETE FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2', [docId, realm])
  }

  async canAccessLibraryFile(input: { docId: string; realm: string; userId: string; roles: string[]; isAdmin: boolean; access?: KnowledgeLibraryAccess }): Promise<boolean> {
    if (input.isAdmin) return true
    const required = input.access ?? 'viewer'
    const result = await this.pool.query<{ allowed: boolean }>(
      `WITH RECURSIVE file_scope AS (
         SELECT f.folder_id, d.owner_user_id FROM knowledge_library_files d
         LEFT JOIN knowledge_library_folders f ON f.realm=d.realm AND f.folder_id=d.folder_id
         WHERE d.realm=$1 AND d.doc_id=$2
       ), ancestors AS (
         SELECT folder_id FROM file_scope WHERE folder_id IS NOT NULL
         UNION ALL
         SELECT parent.parent_id FROM ancestors a
         JOIN knowledge_library_folders parent ON parent.realm=$1 AND parent.folder_id=a.folder_id
         WHERE parent.parent_id IS NOT NULL
       )
       SELECT EXISTS (
         SELECT 1 FROM file_scope s WHERE s.owner_user_id=$3
         UNION ALL
         SELECT 1 FROM knowledge_library_file_grants g
          WHERE g.realm=$1 AND g.doc_id=$2 AND (g.principal_type='user' AND g.principal_id=$3
             OR g.principal_type='role' AND g.principal_id=ANY($4::text[]))
            AND ($5='viewer' OR g.access='editor')
         UNION ALL
         SELECT 1 FROM ancestors a
         JOIN knowledge_library_folders f ON f.realm=$1 AND f.folder_id=a.folder_id
          WHERE f.owner_user_id=$3
         UNION ALL
         SELECT 1 FROM ancestors a JOIN knowledge_library_folder_grants g ON g.realm=$1 AND g.folder_id=a.folder_id
          WHERE (g.principal_type='user' AND g.principal_id=$3 OR g.principal_type='role' AND g.principal_id=ANY($4::text[]))
            AND ($5='viewer' OR g.access='editor')
       ) AS allowed`,
      [input.realm, input.docId, input.userId, input.roles, required],
    )
    return result.rows[0]?.allowed === true
  }

  async setLibraryGrants(input: { realm: string; resourceType: 'folder' | 'file'; resourceId: string; actorUserId: string; roles: string[]; isAdmin: boolean; grants: KnowledgeLibraryPrincipal[] }): Promise<void> {
    const canEdit = input.isAdmin || (input.resourceType === 'folder'
      ? await this.canAccessFolder(input.realm, input.resourceId, input.actorUserId, input.roles, 'editor')
      : await this.canAccessLibraryFile({ docId: input.resourceId, realm: input.realm, userId: input.actorUserId, roles: input.roles, isAdmin: false, access: 'editor' }))
    if (!canEdit) throw forbidden('只有资料所有者、编辑者或 Realm 管理员可以调整分享权限')
    if (input.grants.length > 200 || input.grants.some(grant => !/^[A-Za-z0-9._:-]{1,128}$/u.test(grant.id))) throw new TypeError('分享对象无效')
    const table = input.resourceType === 'folder' ? 'knowledge_library_folder_grants' : 'knowledge_library_file_grants'
    const idColumn = input.resourceType === 'folder' ? 'folder_id' : 'doc_id'
    const exists = input.resourceType === 'folder'
      ? await this.pool.query('SELECT 1 FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2', [input.realm, input.resourceId])
      : await this.pool.query('SELECT 1 FROM knowledge_library_files WHERE realm=$1 AND doc_id=$2', [input.realm, input.resourceId])
    if (exists.rowCount === 0) throw new KnowledgeSourceConflictError('资料对象不存在')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM ${table} WHERE realm=$1 AND ${idColumn}=$2`, [input.realm, input.resourceId])
      for (const grant of input.grants) {
        if (grant.type !== 'user' && grant.type !== 'role' || grant.access !== 'viewer' && grant.access !== 'editor') throw new TypeError('分享权限无效')
        await client.query(
          `INSERT INTO ${table} (realm, ${idColumn}, principal_type, principal_id, access, granted_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.realm, input.resourceId, grant.type, grant.id, grant.access, input.actorUserId],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listLibraryGrants(realm: string, resourceType: 'folder' | 'file', resourceId: string): Promise<KnowledgeLibraryPrincipal[]> {
    const table = resourceType === 'folder' ? 'knowledge_library_folder_grants' : 'knowledge_library_file_grants'
    const idColumn = resourceType === 'folder' ? 'folder_id' : 'doc_id'
    const result = await this.pool.query<{ principal_type: 'user' | 'role'; principal_id: string; access: KnowledgeLibraryAccess }>(
      `SELECT principal_type, principal_id, access FROM ${table} WHERE realm=$1 AND ${idColumn}=$2 ORDER BY principal_type, principal_id`, [realm, resourceId],
    )
    return result.rows.map(row => ({ type: row.principal_type, id: row.principal_id, access: row.access }))
  }

  private async canAccessFolder(realm: string, folderId: string, userId: string, roles: string[], access: KnowledgeLibraryAccess): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `WITH RECURSIVE ancestors AS (
         SELECT folder_id, parent_id, owner_user_id FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2
         UNION ALL
         SELECT parent.folder_id, parent.parent_id, parent.owner_user_id FROM knowledge_library_folders parent
         JOIN ancestors child ON parent.realm=$1 AND parent.folder_id=child.parent_id
       )
       SELECT EXISTS (SELECT 1 FROM ancestors WHERE owner_user_id=$3)
         OR EXISTS (SELECT 1 FROM ancestors a JOIN knowledge_library_folder_grants g ON g.realm=$1 AND g.folder_id=a.folder_id
           WHERE (g.principal_type='user' AND g.principal_id=$3 OR g.principal_type='role' AND g.principal_id=ANY($4::text[]))
             AND ($5='viewer' OR g.access='editor')) AS allowed`,
      [realm, folderId, userId, roles, access],
    )
    return result.rows[0]?.allowed === true
  }

  async close(): Promise<void> {
    await this.pool.end()
    await this.vectorProjection?.close?.()
  }

  private async enqueueVector(client: pg.PoolClient, docId: string, realm: string): Promise<void> {
    await client.query(`INSERT INTO knowledge_vector_outbox (realm,doc_id) VALUES ($1,$2)
      ON CONFLICT (realm,doc_id) DO UPDATE SET revision=knowledge_vector_outbox.revision+1`, [realm, docId])
  }

  /** Row locks serialize each document's remote replacement across all replicas. */
  async drainVectorProjection(batchSize = 25): Promise<number> {
    if (!this.vectorProjection || this.projecting) return 0
    this.projecting = true
    let client: pg.PoolClient | undefined
    try {
      client = await this.pool.connect()
      await client.query('BEGIN')
      const pending = await client.query<{ realm: string; doc_id: string }>(
        `SELECT realm,doc_id FROM knowledge_vector_outbox ORDER BY realm,doc_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [Math.min(Math.max(batchSize, 1), 100)],
      )
      for (const row of pending.rows) {
        const result = await client.query<StoredSource>(
          `SELECT doc_id,realm,space,title,source_version,embedding_model,chunks
           FROM knowledge_sources WHERE realm=$1 AND doc_id=$2`, [row.realm, row.doc_id],
        )
        const source = result.rows[0]
        await this.vectorProjection.remove(row.doc_id, row.realm)
        if (source) {
          await this.vectorProjection.ingest({
            doc: { docId: source.doc_id, realm: source.realm, space: source.space, title: source.title,
              sourceVersion: source.source_version, embeddingModel: source.embedding_model },
            chunks: readChunks(source.chunks),
          })
        }
        await client.query('DELETE FROM knowledge_vector_outbox WHERE realm=$1 AND doc_id=$2', [row.realm, row.doc_id])
      }
      await client.query('COMMIT')
      return pending.rows.length
    } catch (error) {
      await client?.query('ROLLBACK')
      throw error
    } finally {
      client?.release()
      this.projecting = false
    }
  }
}

export type { KnowledgeDoc, KnowledgeHit }
