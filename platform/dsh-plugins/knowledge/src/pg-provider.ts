/**
 * KnowledgeSeam 的 pgvector Provider（Local-lite / 低规模 Standalone 用）。
 * 接口契约：platform/shared/seam-contracts/knowledge.ts —— Provider 必须通过契约断言。
 * 安全边界（§5.4.1）：realm 过滤条件由 Provider 强制注入；角色越权直接拒绝。
 */
import pg from 'pg'
import {
  type KnowledgeDoc,
  type KnowledgeHit,
  type KnowledgeIngest,
  type KnowledgeQuery,
  type KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'
import { DDL, type ChunkRow } from './schema.ts'

export interface PgProviderConfig {
  connectionString: string
  /** 允许检索知识库的角色名单（OPA 单点评估的下沉实现；不在名单内 → 拒绝） */
  allowedRoles: string[]
}

export class PgKnowledgeProvider implements KnowledgeSeam {
  private pool: pg.Pool
  private readonly allowedRoles: ReadonlySet<string>

  constructor(config: PgProviderConfig) {
    this.pool = new pg.Pool({ connectionString: config.connectionString })
    this.allowedRoles = new Set(config.allowedRoles)
  }

  /** 幂等初始化：建表 + 建索引（安装时/启动时均可调用） */
  async init(): Promise<void> {
    await this.pool.query(DDL)
  }

  /**
   * 生成向量 —— ∎ P2 实现项：接入 ctx.llm 的 embedding Provider 或批量网关。
   * 版本化硬规矩（§5.4.4）由调用方保证 embedding_model 一致；此处目前显式不可用（铁律 21）。
   */
  private async embed(_text: string, _model: string): Promise<number[]> {
    throw new Error('PgKnowledgeProvider: embedding 未接入（P2 实现项）。ingest/query 入口已就绪')
  }

  async ingest(entry: KnowledgeIngest): Promise<void> {
    const { doc, chunks } = entry
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const [i, chunk] of chunks.entries()) {
        const vector = await this.embed(chunk.text, doc.embeddingModel)
        await client.query(
          `INSERT INTO knowledge_chunks
             (chunk_id, doc_id, realm, space, title, source_version, embedding_model, chunk_index, text, vector)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (doc_id, chunk_index) DO UPDATE SET
             text = EXCLUDED.text, vector = EXCLUDED.vector, source_version = EXCLUDED.source_version`,
          [`${doc.docId}:${i}`, doc.docId, doc.realm, doc.space, doc.title, doc.sourceVersion,
           doc.embeddingModel, i, chunk.text, JSON.stringify(vector)],
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
    const vector = await this.embed(request.text, 'query')
    const rows = await this.pool.query<ChunkRow>(
      `SELECT chunk_id, doc_id, realm, space, title, source_version, embedding_model, text,
              1 - (vector <=> $1::vector) AS distance
       FROM knowledge_chunks
       WHERE realm = $2 AND vector IS NOT NULL
       ORDER BY vector <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(vector), request.realm, request.topK],
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
