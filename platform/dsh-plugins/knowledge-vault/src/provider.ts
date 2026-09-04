/**
 * Vault 知识源 Provider（单机版）。
 *
 * 与生产 PG/Milvus Provider 的差异（有意为之，不参与共享契约测试）：
 * - 真相源是 Obsidian vault 本体，本 Provider 只维护 sqlite 投影；「同步」= 扫描 → upsert。
 * - 单机为单用户：realm 固定（构造配置，默认 'local'）；外来 realm / draft scope 返回空——
 *   这是「不伪造状态」，不是「支持多租户」。
 * - 编辑守卫：upsertSource 显式拒绝（capability_unavailable）——来源编辑属于 Obsidian 插件；
 *   removeSource 仅删索引（vault 文件由用户管理）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { capabilityUnavailable } from './seam-errors.ts'
import type { KnowledgeHit, KnowledgeIngest, KnowledgeQuery, KnowledgeSourceSummary, KnowledgeSourceWrite } from './seam-contracts.ts'
import { parseFrontmatter, sourcePathToKey } from './mapping.ts'
import { splitMarkdownChunks } from './chunk.ts'
import { VaultIndex, type VaultQueryHit } from './vault-index.ts'

export const VAULT_EMBEDDING_MODEL = 'vault/keyword'
export const VAULT_REALM = 'local'

/** 面板展示用的来源摘要：契约字段 + 人读路径（vault 专属子集，不污染共享契约）。 */
export interface VaultSourceSummary extends KnowledgeSourceSummary {
  path: string
}

export interface ProviderConfig {
  /** Obsidian vault 根目录（真相源） */
  vaultRoot: string
  /** sqlite 索引文件路径 */
  dbPath: string
  realm?: string
  embeddingModel?: string
}

export class VaultKnowledgeProvider {
  readonly realm: string
  readonly vaultRoot: string
  readonly embeddingModel: string
  private readonly index: VaultIndex

  constructor(config: ProviderConfig) {
    this.vaultRoot = config.vaultRoot
    this.realm = config.realm ?? VAULT_REALM
    this.embeddingModel = config.embeddingModel ?? VAULT_EMBEDDING_MODEL
    this.index = new VaultIndex(config.dbPath)
  }

  /** 扫描 vault 并把现状投影进索引；vault 缺失 → capability_unavailable（fail-closed）。 */
  async sync(): Promise<{ docs: number }> {
    if (!existsSync(this.vaultRoot)) {
      throw capabilityUnavailable(`vault 目录不存在：${this.vaultRoot}`)
    }
    const seen = new Set<string>()
    for (const [relativePath, raw, mtimeMs] of this.scanMarkdown(this.vaultRoot)) {
      const key = sourcePathToKey(relativePath, raw, mtimeMs)
      seen.add(key.docId)
      const chunks = splitMarkdownChunks(parseFrontmatter(raw).body)
      if (chunks.length === 0) continue
      this.index.upsertDoc({
        docId: key.docId,
        path: key.path,
        realm: this.realm,
        space: key.space,
        title: key.title,
        sourceVersion: key.sourceVersion,
        chunks,
        updatedAt: Date.now(),
      })
    }
    for (const stale of this.index.listDocs(this.realm)) {
      if (!seen.has(stale.docId)) this.index.removeDoc(stale.docId)
    }
    this.index.markSynced(Date.now(), null)
    return { docs: seen.size }
  }

  rebuild(): Promise<{ docs: number }> {
    return this.sync()
  }

  // ---- 管理面（KnowledgeSourceManager 形状，由 vault 专属语义实现） ----

  listSources(realm: string): VaultSourceSummary[] {
    if (realm !== this.realm) return []
    return this.index.listDocs(this.realm).map(doc => ({
      docId: doc.docId,
      realm: doc.realm,
      space: doc.space,
      title: doc.title,
      sourceVersion: doc.sourceVersion,
      embeddingModel: this.embeddingModel,
      chunkCount: doc.chunks.length,
      updatedAt: new Date(doc.updatedAt).toISOString(),
      path: doc.path,
    }))
  }

  getSource(docId: string, realm: string): KnowledgeIngest | undefined {
    if (realm !== this.realm) return undefined
    const doc = this.index.getDoc(docId)
    if (doc === undefined) return undefined
    return {
      doc: { docId: doc.docId, realm: doc.realm, space: doc.space, title: doc.title, sourceVersion: doc.sourceVersion, embeddingModel: this.embeddingModel },
      chunks: doc.chunks,
    }
  }

  /** 单机来源编辑属于 Obsidian 插件：拒绝写入，绝不落第二个真相源。 */
  upsertSource(_entry: KnowledgeSourceWrite): Promise<never> {
    return Promise.reject(capabilityUnavailable('vault 来源由 Obsidian 插件管理；请在插件中编辑，本接口只读'))
  }

  /** 版本校验后移除索引行（vault 文件删除由用户/插件负责，下次 sync 自然收敛）。 */
  async removeSource(docId: string, realm: string, expectedSourceVersion: number): Promise<void> {
    if (realm !== this.realm) {
      throw new KnowledgeSourceConflictError(`knowledge source ${docId} not in this realm`)
    }
    const current = this.index.getDoc(docId)
    if (current === undefined) throw new KnowledgeSourceConflictError(`knowledge source ${docId} no longer exists`)
    if (current.sourceVersion !== expectedSourceVersion) {
      throw new KnowledgeSourceConflictError(`knowledge source ${docId} changed; reload before deleting`)
    }
    this.index.removeDoc(docId)
  }

  // ---- 检索面（KnowledgeSeam.query 的单机实现） ----

  /** KnowledgeSeam 形状：写入不属于 vault（真相源在 Obsidian 插件）。 */
  ingest(_entry: KnowledgeIngest): Promise<void> {
    return Promise.reject(capabilityUnavailable('vault 来源由 Obsidian 插件管理，合成 seam 不接收写入'))
  }

  /** KnowledgeSeam 形状：从索引移除（vault 文件删除由用户/插件负责，下次 sync 收敛）。 */
  remove(docId: string, realm: string): Promise<void> {
    if (realm !== this.realm) return Promise.reject(capabilityUnavailable(`realm ${realm} 不属于本机 vault`))
    return Promise.resolve(this.index.removeDoc(docId))
  }

  query(request: KnowledgeQuery): KnowledgeHit[] {
    if (request.realm !== this.realm || request.scope !== 'published') return []
    return this.statusAndQuery(request)
  }

  private statusAndQuery(request: KnowledgeQuery): KnowledgeHit[] {
    if (request.topK < 1) return []
    return this.index.query(this.realm, request.text, Math.min(Math.max(request.topK, 1), 20))
      .map((hit: VaultQueryHit) => ({ docId: hit.docId, sourceVersion: hit.sourceVersion, score: hit.score, text: hit.text }))
  }

  status(): { vaultPath: string; mode: string; docCount: number; chunkCount: number; lastSyncAt: number | null; error: string | null } {
    const status = this.index.status()
    return { vaultPath: this.vaultRoot, mode: 'keyword', ...status }
  }

  close(): void {
    this.index.close()
  }

  private *scanMarkdown(root: string): Generator<[string, string, number]> {
    const stack: Array<{ dir: string; prefix: string }> = [{ dir: root, prefix: '' }]
    while (stack.length > 0) {
      const { dir, prefix } = stack.pop()!
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue
        const absolute = join(dir, entry)
        const stat = statSync(absolute)
        if (stat.isDirectory()) {
          stack.push({ dir: absolute, prefix: prefix === '' ? entry : `${prefix}/${entry}` })
        } else if (stat.isFile() && entry.toLowerCase().endsWith('.md')) {
          const rel = prefix === '' ? entry : `${prefix}/${entry}`
          yield [rel.split(sep).join('/'), readFileSync(absolute, 'utf8'), stat.mtimeMs]
        }
      }
    }
  }
}

/** 管理面版本冲突（名称与 pg-provider 一致：服务端按 error.name === 'KnowledgeSourceConflictError' 映射 409）。 */
export class KnowledgeSourceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeSourceConflictError'
  }
}
