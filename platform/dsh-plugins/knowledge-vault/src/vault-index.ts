/**
 * Vault 索引层：node:sqlite + FTS5（零第三方依赖；Node 22.13+/24 内置）。
 * 表分三层：sources（源元数据 + 分块 JSON，权威事实）、fts（BM25 全文检索投影）、
 * meta（last_sync_at / last_error）。vault 本体是真相源，这里只有投影——可随时重建。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface VaultChunk {
  text: string
  metadata: Record<string, unknown>
}

/** upsertDoc 入参：分块为对象数组。 */
export interface VaultDocRecord {
  docId: string
  path: string
  realm: string
  space: string
  title: string
  sourceVersion: number
  chunks: VaultChunk[]
  updatedAt: number
}

/** getDoc 返回：分量解析后的对象 + 原始 JSON 字符串（管理面持久展示用）。 */
export interface VaultStoredDoc extends VaultDocRecord {
  chunksJSON: string
}

export interface VaultQueryHit {
  docId: string
  sourceVersion: number
  score: number
  text: string
}

export interface VaultIndexStatus {
  docCount: number
  chunkCount: number
  lastSyncAt: number | null
  error: string | null
}

const DDL = `
CREATE TABLE IF NOT EXISTS knowledge_vault_sources (
  doc_id         TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  realm          TEXT NOT NULL,
  space          TEXT NOT NULL,
  title          TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  chunks_json    TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);
-- trigram：中文连续运转不作字切分，unicode61 对无标点中文词会整串成一个 token（召回不动）。
-- trigram 把文本切成三字 n-gram，天然支持中文子串检索（≥3 字；更短词走 LIKE 兜底）。
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vault_fts USING fts5(
  doc_id UNINDEXED, realm UNINDEXED, source_version UNINDEXED, chunk_index UNINDEXED, heading, text,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS knowledge_vault_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`

const SCHEMA_VERSION = 2

function ftsTerms(userText: string): string[] {
  return userText.trim().split(/\s+/).filter(Boolean)
}

function ftsMatch(userText: string): string {
  const terms = ftsTerms(userText)
  if (terms.length === 0) return ''
  // 每个词做短语匹配（转义内部引号），词间 AND：FTS5 语法注入面收敛在引号里。
  return terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' AND ')
}

export class VaultIndex {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    // 索引目录可能不存在（桌面状态目录首次运行时才建）——数据库路径的父目录随建。
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    // 索引结构版本不一致 → 重建（索引是投影，随时可重建；旧分词器产出不可信）
    const metaExists = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_vault_meta'`).get()
    const stored = metaExists === undefined
      ? undefined
      : (this.db.prepare(`SELECT value FROM knowledge_vault_meta WHERE key = 'schema_version'`).get() as Record<string, unknown> | undefined)
    const storedVersion = stored === undefined ? undefined : Number(stored.value)
    if (storedVersion !== undefined && storedVersion !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS knowledge_vault_sources; DROP TABLE IF EXISTS knowledge_vault_fts; DROP TABLE IF EXISTS knowledge_vault_meta;')
    }
    this.db.exec(DDL)
    this.db.prepare(`INSERT OR REPLACE INTO knowledge_vault_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`).run()
  }

  /** 全量替换一个文档的元数据与分块（事务；旧 FTS 行先删再插，不会重复）。 */
  upsertDoc(record: VaultDocRecord): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM knowledge_vault_fts WHERE doc_id = ?').run(record.docId)
      this.db.prepare(`INSERT OR REPLACE INTO knowledge_vault_sources
        (doc_id, path, realm, space, title, source_version, chunks_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.docId, record.path, record.realm, record.space, record.title,
        record.sourceVersion, JSON.stringify(record.chunks), record.updatedAt,
      )
      const insertChunk = this.db.prepare(`INSERT INTO knowledge_vault_fts
        (doc_id, realm, source_version, chunk_index, heading, text) VALUES (?, ?, ?, ?, ?, ?)`)
      record.chunks.forEach((chunk, index) => {
        insertChunk.run(record.docId, record.realm, record.sourceVersion, String(index), String(chunk.metadata['heading'] ?? ''), chunk.text)
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeDoc(docId: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM knowledge_vault_fts WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM knowledge_vault_sources WHERE doc_id = ?').run(docId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getDoc(docId: string): VaultDocRecord | undefined {
    const row = this.db.prepare(`SELECT doc_id, path, realm, space, title, source_version,
      chunks_json, updated_at FROM knowledge_vault_sources WHERE doc_id = ?`).get(docId) as
      | Record<string, unknown>
      | undefined
    if (row === undefined) return undefined
    return this.toRecord(row)
  }

  listDocs(realm: string): VaultDocRecord[] {
    const rows = this.db.prepare(`SELECT doc_id, path, realm, space, title, source_version,
      chunks_json, updated_at FROM knowledge_vault_sources
      WHERE realm = ? ORDER BY updated_at DESC, doc_id`).all(realm) as Record<string, unknown>[]
    return rows.map(row => this.toRecord(row))
  }

  query(realm: string, userText: string, topK: number): VaultQueryHit[] {
    const terms = ftsTerms(userText)
    if (terms.length === 0) return []
    // trigram 窗口是 3 字：任一词不足 3 字时 MATCH 恒定 0，走 LIKE 兜底（子串语义，无相关性排序）。
    if (terms.some(term => term.length < 3)) return this.likeQuery(realm, terms, topK)
    const match = ftsMatch(userText)
    const rows = this.db.prepare(`SELECT doc_id, source_version, text,
        bm25(knowledge_vault_fts) AS score
      FROM knowledge_vault_fts
      WHERE realm = ? AND knowledge_vault_fts MATCH ?
      ORDER BY score LIMIT ?`).all(realm, match, topK) as Array<Record<string, unknown>>
    return rows.map(row => ({
      docId: String(row.doc_id),
      sourceVersion: Number(row.source_version),
      score: Number(row.score),
      text: String(row.text),
    }))
  }

  /** 短词兜底：对 chunks_json（含正文的 JSON 文本）做逐词 LIKE。 */
  private likeQuery(realm: string, terms: string[], topK: number): VaultQueryHit[] {
    const where = ['realm = ?']
    const params: Array<string> = [realm]
    for (const term of terms) {
      where.push("chunks_json LIKE '%' || ? || '%'")
      params.push(term)
    }
    const rows = this.db.prepare(
      `SELECT doc_id, source_version, chunks_json FROM knowledge_vault_sources
       WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...params, topK) as Array<Record<string, unknown>>
    return rows.map(row => {
      const chunks = JSON.parse(String(row.chunks_json)) as Array<{ text: string }>
      return {
        docId: String(row.doc_id),
        sourceVersion: Number(row.source_version),
        score: 0,
        text: chunks[0]?.text ?? '',
      }
    })
  }

  markSynced(atMs: number, error: string | null): void {
    this.db.prepare(`INSERT OR REPLACE INTO knowledge_vault_meta (key, value) VALUES ('last_sync_at', ?)`).run(String(atMs))
    this.db.prepare(`INSERT OR REPLACE INTO knowledge_vault_meta (key, value) VALUES ('last_error', ?)`).run(error ?? '')
  }

  status(): VaultIndexStatus {
    const docCount = Number((this.db.prepare('SELECT count(*) AS n FROM knowledge_vault_sources').get() as Record<string, unknown>).n)
    const chunkCount = Number((this.db.prepare('SELECT count(*) AS n FROM knowledge_vault_fts').get() as Record<string, unknown>).n)
    const atRow = this.db.prepare(`SELECT value FROM knowledge_vault_meta WHERE key = 'last_sync_at'`).get() as Record<string, unknown> | undefined
    const errorRow = this.db.prepare(`SELECT value FROM knowledge_vault_meta WHERE key = 'last_error'`).get() as Record<string, unknown> | undefined
    return {
      docCount,
      chunkCount,
      lastSyncAt: atRow === undefined ? null : Number(atRow.value),
      error: errorRow === undefined || errorRow.value === '' ? null : String(errorRow.value),
    }
  }

  close(): void {
    this.db.close()
  }

  private toRecord(row: Record<string, unknown>): VaultStoredDoc {
    const chunksJSON = String(row.chunks_json)
    const chunks: VaultChunk[] = JSON.parse(chunksJSON) as VaultChunk[]
    return {
      docId: String(row.doc_id),
      path: String(row.path),
      realm: String(row.realm),
      space: String(row.space),
      title: String(row.title),
      sourceVersion: Number(row.source_version),
      chunks,
      chunksJSON,
      updatedAt: Number(row.updated_at),
    }
  }
}
