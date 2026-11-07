/**
 * KnowledgeSeam 的 pgvector Provider（Local-lite / 低规模 Standalone 用）。
 * 接口契约：platform/shared/seam-contracts/knowledge.ts —— Provider 必须通过契约断言。
 * 安全边界（§5.4.1）：realm 过滤条件由 Provider 强制注入；角色越权直接拒绝。
 * 向量：注入 EmbeddingClient（默认 TEI）；维度驱动 DDL 与检索（§5.4.4 模型版本。
 */
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
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
import { pinManagedContent, releaseManagedContent } from '../../../shared/managed-content.ts'

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
  library_file BOOLEAN NOT NULL DEFAULT false,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE knowledge_tombstones ADD COLUMN IF NOT EXISTS library_file BOOLEAN NOT NULL DEFAULT false;

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
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (realm, folder_id),
  FOREIGN KEY (realm, parent_id) REFERENCES knowledge_library_folders (realm, folder_id) ON DELETE RESTRICT
);
ALTER TABLE knowledge_library_folders ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_library_folder_sibling
  ON knowledge_library_folders (realm, COALESCE(parent_id, ''), lower(name));
CREATE INDEX IF NOT EXISTS idx_knowledge_library_folder_parent
  ON knowledge_library_folders (realm, parent_id);

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
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (realm, folder_id) REFERENCES knowledge_library_folders (realm, folder_id) ON DELETE RESTRICT
);
ALTER TABLE knowledge_library_files ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
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
  can_edit?: boolean
  revision: string | number
}
type LibraryFolderRow = {
  folder_id: string; realm: string; parent_id: string | null; name: string; owner_user_id: string
  created_at: string; revision: string | number; can_edit?: boolean
}

function libraryFolder(row: LibraryFolderRow): KnowledgeLibraryFolder {
  return { folderId: row.folder_id, realm: row.realm, parentId: row.parent_id, name: row.name, ownerUserId: row.owner_user_id,
    createdAt: row.created_at, revision: Number(row.revision), ...(row.can_edit === undefined ? {} : { canEdit: row.can_edit }) }
}

function libraryFile(row: LibraryFileRow): KnowledgeLibraryFile {
  return {
    docId: row.doc_id, realm: row.realm, folderId: row.folder_id, filename: row.filename, mimeType: row.mime_type,
    objectKey: row.object_key, byteSize: Number(row.byte_size), sha256: row.sha256, ownerUserId: row.owner_user_id,
    extractionState: row.extraction_state, ocrState: row.ocr_state, createdAt: row.created_at,
    revision: Number(row.revision),
    ...(row.can_edit === undefined ? {} : { canEdit: row.can_edit }),
  }
}

function validLibraryName(value: string): string {
  const name = value.trim()
  if (name.length === 0 || Buffer.byteLength(name, 'utf8') > 240 || /[\\/\u0000-\u001f\u007f]/u.test(name) || name === '.' || name === '..') throw new TypeError('资料名称无效')
  return name
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('必须提供读取时的有效资料版本')
}

/** A single recursive walk propagates matching ancestor grants to all descendants. */
const libraryFolderAccessCte = `WITH RECURSIVE allowed_folders(folder_id, required_access) AS (
  SELECT f.folder_id, access.required FROM knowledge_library_folders f
    CROSS JOIN (VALUES ('viewer'), ('editor')) access(required) WHERE f.realm=$1 AND (
    $5::boolean OR f.owner_user_id=$2 OR EXISTS (
      SELECT 1 FROM knowledge_library_folder_grants g WHERE g.realm=$1 AND g.folder_id=f.folder_id
        AND (g.principal_type='user' AND g.principal_id=$2 OR g.principal_type='role' AND g.principal_id=ANY($3::text[]))
        AND (access.required='viewer' OR g.access='editor')
    )
  )
  UNION
  SELECT f.folder_id, parent.required_access FROM knowledge_library_folders f JOIN allowed_folders parent ON f.parent_id=parent.folder_id
    WHERE f.realm=$1
)`

/** Requires the surrounding query to alias the library file as d. */
function libraryFileAccessSql(access = '$4'): string { return `($5::boolean OR d.owner_user_id=$2
  OR d.folder_id IN (SELECT folder_id FROM allowed_folders WHERE required_access=${access})
  OR EXISTS (SELECT 1 FROM knowledge_library_file_grants g WHERE g.realm=$1 AND g.doc_id=d.doc_id
    AND (g.principal_type='user' AND g.principal_id=$2 OR g.principal_type='role' AND g.principal_id=ANY($3::text[]))
    AND (${access}='viewer' OR g.access='editor')))` }

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
  readonly managedContentTransactions = true as const
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

  /** ACL changes include inherited ancestors, so serialize the complete realm's ACL snapshot. */
  private async lockLibraryAcl(client: pg.PoolClient, realm: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 74107)', [realm])
  }

  /** 写 source-of-truth、向量投影和图 outbox；调用方已持有该 doc 的锁。 */
  private async writeSource(client: pg.PoolClient, entry: KnowledgeIngest, vectors: number[][]): Promise<KnowledgeSourceSummary> {
    let { doc } = entry
    const file = await client.query<{ realm: string; filename: string }>(
      'SELECT realm, filename FROM knowledge_library_files WHERE doc_id=$1 FOR KEY SHARE', [doc.docId],
    )
    if (file.rows[0] !== undefined && file.rows[0].realm !== doc.realm) throw forbidden(`knowledge file ${doc.docId} belongs to another realm`)
    const lifecycle = await client.query<{ deleted_library: boolean; library_source: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM knowledge_tombstones WHERE doc_id=$1 AND library_file) AS deleted_library,
       EXISTS (SELECT 1 FROM knowledge_sources WHERE doc_id=$1 AND chunks @> '[{"metadata":{"libraryFile":true}}]'::jsonb) AS library_source`,
      [doc.docId],
    )
    const hasFile = file.rows[0] !== undefined
    if (lifecycle.rows[0]?.deleted_library || !hasFile && (lifecycle.rows[0]?.library_source || entry.chunks.some(chunk => chunk.metadata.libraryFile === true))) {
      throw new KnowledgeSourceConflictError('资料文件已删除或不存在，请重新上传文件')
    }
    // The source lock is acquired after embedding. An upload deleted while embedding was
    // in flight must never recreate the source or clear its deletion tombstone.
    if (hasFile) doc = { ...doc, title: file.rows[0]!.filename }
    const chunks = hasFile ? entry.chunks.map(chunk => ({ ...chunk, metadata: { ...chunk.metadata, filename: file.rows[0]!.filename, libraryFile: true } })) : entry.chunks
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
      [doc.docId, doc.realm, JSON.stringify({ ...collectProjection(doc, chunks), ...(hasFile ? { libraryFile: true } : {}) })],
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
    request = await this.projectQueryScope(request)
    if (request.spaces?.length === 0) return []
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
    if (hits.length === 0) return []
    const identified = typeof request.userId === 'string' && request.userId !== ''
    const projectFilter = request.projectId === undefined ? '' : `AND EXISTS(SELECT 1 FROM project_spaces ps
      JOIN projects p ON p.id=ps.project_id AND p.realm=ps.realm AND p.status='active'
      JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2
      JOIN governance_users u ON u.realm=p.realm AND u.id=pm.user_id AND u.status='active'
      WHERE ps.realm=s.realm AND ps.space_id=s.space AND p.id=$9)`
    const sources = await this.pool.query<{ doc_id: string; source_version: number }>(
      `${libraryFolderAccessCte}
       SELECT s.doc_id, s.source_version FROM knowledge_sources s
       LEFT JOIN knowledge_library_files d ON d.realm=s.realm AND d.doc_id=s.doc_id
       WHERE s.realm=$1 AND s.doc_id=ANY($6::text[]) AND s.embedding_model=$7
         ${projectFilter}
         AND NOT EXISTS (SELECT 1 FROM knowledge_tombstones t WHERE t.realm=s.realm AND t.doc_id=s.doc_id)
         AND (d.doc_id IS NULL AND NOT (s.chunks @> '[{"metadata":{"libraryFile":true}}]'::jsonb)
           OR d.doc_id IS NOT NULL AND $8::boolean AND ${libraryFileAccessSql()})`,
      [request.realm, request.userId ?? '', identified ? request.roles : [], 'viewer', request.libraryAdmin === true,
        [...new Set(hits.map(hit => hit.docId))], this.embeddingModel, identified || request.libraryAdmin === true,
        ...(request.projectId === undefined ? [] : [request.projectId])],
    )
    // Final authority check also closes a race where a search candidate was read before deletion
    // but its file row was removed before ACL filtering (absence must not turn it into a public source).
    const current = new Map(sources.rows.map(source => [source.doc_id, source.source_version]))
    return hits.filter(hit => current.get(hit.docId) === hit.sourceVersion).slice(0, request.topK)
  }

  private async projectQueryScope(request: KnowledgeQuery): Promise<KnowledgeQuery> {
    if (request.projectId === undefined) return request
    if (!request.projectId.trim() || !request.userId?.trim()) throw forbidden('knowledge: project queries require an authenticated user')
    const result = await this.pool.query<{ spaces: string[] }>(
      `SELECT COALESCE(array_agg(ps.space_id) FILTER (WHERE ps.space_id IS NOT NULL),'{}'::text[]) AS spaces
       FROM projects p JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$3
       JOIN governance_users u ON u.realm=p.realm AND u.id=pm.user_id AND u.status='active'
       LEFT JOIN project_spaces ps ON ps.project_id=p.id AND ps.realm=p.realm
       WHERE p.realm=$1 AND p.id=$2 AND p.status='active' GROUP BY p.id`,
      [request.realm, request.projectId, request.userId],
    )
    const allowed = result.rows[0]?.spaces
    if (!allowed) throw forbidden('knowledge: current active project membership is required')
    return { ...request, spaces: allowed.filter(space => spaceAllowed(space, request.spaces)) }
  }

  async remove(docId: string, realm: string): Promise<void> {
    // 抽除、墓碑、图删除意图必须同事务：任一半成功都会留下可召回的残留（数据泄漏路径 §5.4.3）
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await this.lockSource(client, docId)
      this.assertOwner(current, docId, realm)
      await this.removeSourceState(client, docId, realm)
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
      await this.removeSourceState(client, docId, realm)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listLibraryFolders(realm: string, userId: string, roles: string[], isAdmin: boolean): Promise<KnowledgeLibraryFolder[]> {
    const rows = await this.pool.query<LibraryFolderRow>(
      `${libraryFolderAccessCte}
       SELECT folder_id, realm, parent_id, name, owner_user_id, created_at::text, revision,
         folder_id IN (SELECT folder_id FROM allowed_folders WHERE required_access='editor') AS can_edit
       FROM knowledge_library_folders WHERE realm=$1 AND folder_id IN (SELECT folder_id FROM allowed_folders WHERE required_access=$4)
       ORDER BY lower(name), folder_id`, [realm, userId, roles, 'viewer', isAdmin],
    )
    return rows.rows.map(libraryFolder)
  }

  async canAccessLibraryFolder(input: { realm: string; folderId: string; userId: string; roles: string[]; isAdmin: boolean; access?: KnowledgeLibraryAccess }): Promise<boolean> {
    return input.isAdmin || this.canAccessFolder(input.realm, input.folderId, input.userId, input.roles, input.access ?? 'viewer')
  }

  async createLibraryFolder(input: { realm: string; parentId: string | null; name: string; ownerUserId: string; roles: string[]; isAdmin: boolean }): Promise<KnowledgeLibraryFolder> {
    const name = validLibraryName(input.name)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, input.realm)
      await this.assertLibraryDestination(client, input.realm, input.parentId, input.ownerUserId, input.roles, input.isAdmin)
      const result = await client.query<LibraryFolderRow>(
        `INSERT INTO knowledge_library_folders (folder_id, realm, parent_id, name, owner_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING folder_id, realm, parent_id, name, owner_user_id, created_at::text, revision`,
        [`folder-${randomUUID()}`, input.realm, input.parentId, name, input.ownerUserId],
      )
      await client.query('COMMIT')
      return { ...libraryFolder(result.rows[0]!), canEdit: true }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async updateLibraryFolder(input: { realm: string; folderId: string; actorUserId: string; roles: string[]; isAdmin: boolean; expectedRevision: number; name?: string; parentId?: string | null }): Promise<KnowledgeLibraryFolder> {
    assertRevision(input.expectedRevision)
    if (input.name === undefined && input.parentId === undefined) throw new TypeError('请提供目录名称或目标目录')
    const name = input.name === undefined ? undefined : validLibraryName(input.name)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, input.realm)
      const current = (await client.query<LibraryFolderRow>(
        'SELECT folder_id, realm, parent_id, name, owner_user_id, created_at::text, revision FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2 FOR UPDATE', [input.realm, input.folderId],
      )).rows[0]
      if (current === undefined) throw new KnowledgeSourceConflictError('资料目录已不存在，请刷新')
      if (!input.isAdmin && !await this.canAccessFolder(input.realm, input.folderId, input.actorUserId, input.roles, 'editor', client)) throw forbidden('没有整理该资料目录的权限')
      if (Number(current.revision) !== input.expectedRevision) throw new KnowledgeSourceConflictError('资料目录已变更，请刷新后重试')
      const parentId = input.parentId === undefined ? current.parent_id : input.parentId
      if (parentId !== current.parent_id) {
        await this.assertLibraryDestination(client, input.realm, parentId, input.actorUserId, input.roles, input.isAdmin)
        if (parentId !== null) {
          const cycle = await client.query<{ cyclic: boolean }>(
            `WITH RECURSIVE descendants(folder_id) AS (
               SELECT folder_id FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2
               UNION SELECT f.folder_id FROM knowledge_library_folders f JOIN descendants p ON f.parent_id=p.folder_id WHERE f.realm=$1
             ) SELECT EXISTS (SELECT 1 FROM descendants WHERE folder_id=$3) AS cyclic`,
            [input.realm, input.folderId, parentId],
          )
          if (cycle.rows[0]?.cyclic) throw new TypeError('不能将资料目录移动到自身或子目录')
        }
      }
      const row = (await client.query<LibraryFolderRow>(
        `UPDATE knowledge_library_folders SET name=$3, parent_id=$4, revision=revision+1 WHERE realm=$1 AND folder_id=$2
         RETURNING folder_id, realm, parent_id, name, owner_user_id, created_at::text, revision`,
        [input.realm, input.folderId, name ?? current.name, parentId],
      )).rows[0]!
      const canEdit = input.isAdmin || await this.canAccessFolder(input.realm, input.folderId, input.actorUserId, input.roles, 'editor', client)
      await client.query('COMMIT')
      return { ...libraryFolder(row), canEdit }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  private async assertLibraryDestination(client: pg.PoolClient, realm: string, folderId: string | null, userId: string, roles: string[], isAdmin: boolean): Promise<void> {
    if (folderId === null) return
    const folder = await client.query('SELECT 1 FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2 FOR KEY SHARE', [realm, folderId])
    if (folder.rowCount === 0) throw new KnowledgeSourceConflictError('目标资料目录不存在')
    if (!isAdmin && !await this.canAccessFolder(realm, folderId, userId, roles, 'editor', client)) throw forbidden('没有在目标资料目录中整理文件的权限')
  }

  async deleteLibraryFolder(input: { realm: string; folderId: string; actorUserId: string; roles: string[]; isAdmin: boolean; expectedRevision?: number }): Promise<void> {
    if (input.expectedRevision !== undefined) assertRevision(input.expectedRevision)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, input.realm)
      if (!input.isAdmin && !await this.canAccessFolder(input.realm, input.folderId, input.actorUserId, input.roles, 'editor', client)) throw forbidden('没有删除该资料文件夹的权限')
      const current = (await client.query<{ revision: string | number }>('SELECT revision FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2 FOR UPDATE', [input.realm, input.folderId])).rows[0]
      if (current === undefined || input.expectedRevision !== undefined && Number(current.revision) !== input.expectedRevision) throw new KnowledgeSourceConflictError('资料目录已变更或不存在，请刷新后重试')
      const result = await client.query(
        `DELETE FROM knowledge_library_folders f WHERE f.realm=$1 AND f.folder_id=$2
         AND NOT EXISTS (SELECT 1 FROM knowledge_library_folders c WHERE c.realm=f.realm AND c.parent_id=f.folder_id)
         AND NOT EXISTS (SELECT 1 FROM knowledge_library_files d WHERE d.realm=f.realm AND d.folder_id=f.folder_id)`,
        [input.realm, input.folderId],
      )
      if (result.rowCount === 0) throw new KnowledgeSourceConflictError('资料文件夹不存在或仍含有子目录/文件')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listLibraryFiles(realm: string, userId: string, roles: string[], isAdmin: boolean): Promise<KnowledgeLibraryFile[]> {
    const rows = await this.pool.query<LibraryFileRow>(
      `${libraryFolderAccessCte}
       SELECT doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id,
              extraction_state, ocr_state, created_at::text, revision, ${libraryFileAccessSql("'editor'")} AS can_edit
       FROM knowledge_library_files d WHERE realm=$1 AND ${libraryFileAccessSql()}
       ORDER BY created_at DESC, doc_id`, [realm, userId, roles, 'viewer', isAdmin],
    )
    return rows.rows.map(libraryFile)
  }

  async getLibraryFile(docId: string, realm: string): Promise<KnowledgeLibraryFile | undefined> {
    const result = await this.pool.query<LibraryFileRow>(
      `SELECT doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id,
              extraction_state, ocr_state, created_at::text, revision
       FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2`, [docId, realm],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : libraryFile(row)
  }

  async createLibraryFile(file: KnowledgeLibraryFile, actorContext?: { roles: string[]; isAdmin: boolean }): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, file.realm)
      if (actorContext !== undefined) await this.assertLibraryDestination(client, file.realm, file.folderId, file.ownerUserId, actorContext.roles, actorContext.isAdmin)
      await pinManagedContent(client,{ realm:file.realm,kind:'knowledge-file',referenceId:file.docId,objectKey:file.objectKey,sha256:file.sha256,byteSize:file.byteSize })
      await client.query(
        `INSERT INTO knowledge_library_files
           (doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id, extraction_state, ocr_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [file.docId, file.realm, file.folderId, file.filename, file.mimeType, file.objectKey, file.byteSize, file.sha256,
          file.ownerUserId, file.extractionState, file.ocrState],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async updateLibraryFile(input: { realm: string; docId: string; actorUserId: string; roles: string[]; isAdmin: boolean; expectedRevision: number; filename?: string; folderId?: string | null }): Promise<KnowledgeLibraryFile> {
    assertRevision(input.expectedRevision)
    if (input.filename === undefined && input.folderId === undefined) throw new TypeError('请提供文件名称或目标目录')
    const filename = input.filename === undefined ? undefined : validLibraryName(input.filename)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, input.realm)
      await this.lockSource(client, input.docId)
      const current = (await client.query<LibraryFileRow>(
        `SELECT doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id,
           extraction_state, ocr_state, created_at::text, revision FROM knowledge_library_files WHERE realm=$1 AND doc_id=$2 FOR UPDATE`,
        [input.realm, input.docId],
      )).rows[0]
      if (current === undefined) throw new KnowledgeSourceConflictError('资料文件已不存在，请刷新')
      if (!await this.fileAccess({ realm: input.realm, docId: input.docId, userId: input.actorUserId, roles: input.roles, isAdmin: input.isAdmin, access: 'editor' }, client)) throw forbidden('没有整理该资料文件的权限')
      if (Number(current.revision) !== input.expectedRevision) throw new KnowledgeSourceConflictError('资料文件已变更，请刷新后重试')
      if (filename !== undefined && extname(filename).toLowerCase() !== extname(current.filename).toLowerCase()) throw new TypeError('重命名必须保留原文件扩展名')
      const folderId = input.folderId === undefined ? current.folder_id : input.folderId
      if (folderId !== current.folder_id) await this.assertLibraryDestination(client, input.realm, folderId, input.actorUserId, input.roles, input.isAdmin)
      const row = (await client.query<LibraryFileRow>(
        `UPDATE knowledge_library_files SET filename=$3, folder_id=$4, revision=revision+1 WHERE realm=$1 AND doc_id=$2
         RETURNING doc_id, realm, folder_id, filename, mime_type, object_key, byte_size, sha256, owner_user_id,
           extraction_state, ocr_state, created_at::text, revision`,
        [input.realm, input.docId, filename ?? current.filename, folderId],
      )).rows[0]!
      if (row.filename !== current.filename) {
        // Rename does not change content, embedding or sourceVersion. Update authoritative display
        // metadata and replayable projections under the same source lock, with no embedding call.
        const source = (await client.query<StoredSource>(
          `SELECT doc_id, realm, space, title, source_version, embedding_model, chunks
           FROM knowledge_sources WHERE realm=$1 AND doc_id=$2`, [input.realm, input.docId],
        )).rows[0]
        if (source !== undefined) {
          const chunks = readChunks(source.chunks).map(chunk => ({ ...chunk, metadata: { ...chunk.metadata, filename: row.filename, libraryFile: true } }))
          await client.query('UPDATE knowledge_sources SET title=$3, chunks=$4, updated_at=now() WHERE realm=$1 AND doc_id=$2', [input.realm, input.docId, row.filename, JSON.stringify(chunks)])
          await client.query('UPDATE knowledge_chunks SET title=$3 WHERE realm=$1 AND doc_id=$2', [input.realm, input.docId, row.filename])
          await client.query("INSERT INTO knowledge_graph_outbox (doc_id, realm, op, payload) VALUES ($1,$2,'upsert',$3)", [input.docId, input.realm, JSON.stringify(collectProjection({ title: row.filename, space: source.space, sourceVersion: source.source_version }, chunks))])
          await this.enqueueVector(client, input.docId, input.realm)
        }
      }
      const canEdit = await this.fileAccess({ realm: input.realm, docId: input.docId, userId: input.actorUserId, roles: input.roles, isAdmin: input.isAdmin, access: 'editor' }, client)
      await client.query('COMMIT')
      return { ...libraryFile(row), canEdit }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async removeLibraryFile(docId: string, realm: string): Promise<void> {
    const client=await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client,realm)
      const source=await this.lockSource(client,docId)
      this.assertOwner(source,docId,realm)
      await this.removeSourceState(client,docId,realm)
      await client.query('COMMIT')
    } catch(error) { await client.query('ROLLBACK');throw error }
    finally { client.release() }
  }

  async deleteLibraryFile(input: { realm: string; docId: string; actorUserId: string; roles: string[]; isAdmin: boolean; expectedSha256: string; expectedRevision?: number }): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256)) throw new TypeError('必须提供读取文件时的有效 SHA-256')
    if (input.expectedRevision !== undefined) assertRevision(input.expectedRevision)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, input.realm)
      const source = await this.lockSource(client, input.docId)
      this.assertOwner(source, input.docId, input.realm)
      const files = await client.query<{ sha256: string; revision: string | number }>(
        'SELECT sha256, revision FROM knowledge_library_files WHERE realm=$1 AND doc_id=$2 FOR UPDATE',
        [input.realm, input.docId],
      )
      const file = files.rows[0]
      if (file === undefined) throw new KnowledgeSourceConflictError('资料文件已不存在，请刷新列表')
      if (!await this.fileAccess({
        docId: input.docId, realm: input.realm, userId: input.actorUserId, roles: input.roles,
        isAdmin: input.isAdmin, access: 'editor',
      }, client)) throw forbidden('没有删除该资料文件的权限')
      if (file.sha256 !== input.expectedSha256) throw new KnowledgeSourceConflictError('资料文件内容已变更，请刷新后再删除')
      if (input.expectedRevision !== undefined && Number(file.revision) !== input.expectedRevision) throw new KnowledgeSourceConflictError('资料文件名称或目录已变更，请刷新后再删除')
      await this.removeSourceState(client, input.docId, input.realm)
      // Managed pins release in removeSourceState's transaction. Legacy content
      // stays outside managed GC because its reference history is incomplete.
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async canAccessLibraryFile(input: { docId: string; realm: string; userId: string; roles: string[]; isAdmin: boolean; access?: KnowledgeLibraryAccess }): Promise<boolean> {
    return this.fileAccess(input, this.pool)
  }

  private async fileAccess(input: { docId: string; realm: string; userId: string; roles: string[]; isAdmin: boolean; access?: KnowledgeLibraryAccess }, client: pg.Pool | pg.PoolClient): Promise<boolean> {
    if (input.isAdmin) return true
    const required = input.access ?? 'viewer'
    const result = await client.query<{ allowed: boolean }>(
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

  /** Caller holds the source lock; authoritative state and replayable cleanup intents commit together. */
  private async removeSourceState(client: pg.PoolClient, docId: string, realm: string): Promise<void> {
    const file=(await client.query<{object_key:string}>('SELECT object_key FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2 FOR UPDATE',[docId,realm])).rows[0]
    if(file)await releaseManagedContent(client,{realm,kind:'knowledge-file',referenceId:docId,objectKey:file.object_key})
    // Persist the former resource kind: an old upload cannot bypass deletion by dropping
    // metadata.libraryFile and retrying as a manually managed source with the same ID.
    await client.query(
      `INSERT INTO knowledge_tombstones (doc_id, realm, library_file)
       SELECT $1, $2, EXISTS (SELECT 1 FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2)
         OR EXISTS (SELECT 1 FROM knowledge_sources WHERE doc_id=$1 AND realm=$2 AND chunks @> '[{"metadata":{"libraryFile":true}}]'::jsonb)
       ON CONFLICT (doc_id) DO UPDATE SET removed_at=now(),
         library_file=knowledge_tombstones.library_file OR EXCLUDED.library_file`, [docId, realm],
    )
    await client.query('DELETE FROM knowledge_library_files WHERE doc_id=$1 AND realm=$2', [docId, realm])
    await client.query('DELETE FROM knowledge_chunks WHERE doc_id=$1 AND realm=$2', [docId, realm])
    await client.query('DELETE FROM knowledge_sources WHERE doc_id=$1 AND realm=$2', [docId, realm])
    await client.query("INSERT INTO knowledge_graph_outbox (doc_id, realm, op) VALUES ($1,$2,'remove')", [docId, realm])
    await this.enqueueVector(client, docId, realm)
  }

  async setLibraryGrants(input: { realm: string; resourceType: 'folder' | 'file'; resourceId: string; actorUserId: string; roles: string[]; isAdmin: boolean; grants: KnowledgeLibraryPrincipal[] }): Promise<void> {
    if (input.grants.length > 200 || input.grants.some(grant => !/^[A-Za-z0-9._:-]{1,128}$/u.test(grant.id))) throw new TypeError('分享对象无效')
    if (input.grants.some(grant => grant.type !== 'user' && grant.type !== 'role' || grant.access !== 'viewer' && grant.access !== 'editor')) throw new TypeError('分享权限无效')
    const table = input.resourceType === 'folder' ? 'knowledge_library_folder_grants' : 'knowledge_library_file_grants'
    const idColumn = input.resourceType === 'folder' ? 'folder_id' : 'doc_id'
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.lockLibraryAcl(client, input.realm)
      const resourceTable = input.resourceType === 'folder' ? 'knowledge_library_folders' : 'knowledge_library_files'
      const exists = await client.query(`SELECT 1 FROM ${resourceTable} WHERE realm=$1 AND ${idColumn}=$2 FOR KEY SHARE`, [input.realm, input.resourceId])
      if (exists.rowCount === 0) throw new KnowledgeSourceConflictError('资料对象不存在')
      const canEdit = input.isAdmin || (input.resourceType === 'folder'
        ? await this.canAccessFolder(input.realm, input.resourceId, input.actorUserId, input.roles, 'editor', client)
        : await this.fileAccess({ docId: input.resourceId, realm: input.realm, userId: input.actorUserId, roles: input.roles, isAdmin: false, access: 'editor' }, client))
      if (!canEdit) throw forbidden('只有资料所有者、编辑者或 Realm 管理员可以调整分享权限')
      await client.query(`DELETE FROM ${table} WHERE realm=$1 AND ${idColumn}=$2`, [input.realm, input.resourceId])
      for (const grant of input.grants) {
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

  private async canAccessFolder(realm: string, folderId: string, userId: string, roles: string[], access: KnowledgeLibraryAccess, client: pg.Pool | pg.PoolClient = this.pool): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(
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
