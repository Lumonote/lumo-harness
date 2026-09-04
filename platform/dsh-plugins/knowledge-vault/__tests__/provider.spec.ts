import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VaultKnowledgeProvider } from '../src/provider.ts'

const VAULT_MODE = 'vault/keyword'

function tempVault(): { vault: string; db: string } {
  const base = mkdtempSync(join(tmpdir(), 'vault-provider-'))
  return { vault: base, db: join(base, 'index.sqlite') }
}

function provider(over: Partial<{ vault: string; db: string }> = {}): VaultKnowledgeProvider {
  const { vault, db } = tempVault()
  return new VaultKnowledgeProvider({ vaultRoot: over.vault ?? vault, dbPath: over.db ?? db })
}

describe('vault knowledge provider', () => {
  it('ingests a real vault tree on sync and serves it through sources and query', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    writeFileSync(join(vault, 'notes/a.md'), '---\ntitle: 笔记A\n---\n# 知识库\n\n知识库文档的检索方法。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    const summaries = subject.listSources('local')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.space).toBe('notes')
    expect(summaries[0]!.title).toBe('笔记A')
    expect(summaries[0]!.path).toBe('notes/a.md')
    expect(summaries[0]!.embeddingModel).toBe(VAULT_MODE)
    const hits = subject.query({ realm: 'local', roles: ['viewer'], text: '知识库文档', topK: 3, scope: 'published' })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.docId).toBe(summaries[0]!.docId)
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('is idempotent across repeated syncs', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    writeFileSync(join(vault, 'notes/a.md'), '# 知识库\n\n内容。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    const first = subject.listSources('local')
    await subject.sync()
    const second = subject.listSources('local')
    expect(second).toHaveLength(1)
    expect(second[0]!.sourceVersion).toBe(first[0]!.sourceVersion)
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('bumps sourceVersion when a file changes (mtime second-capped)', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    const file = join(vault, 'notes/a.md')
    writeFileSync(file, '# 一\n\n旧内容。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    const first = subject.listSources('local')
    utimesSync(file, new Date(1_752_100_000_000), new Date(1_752_100_000_000))
    writeFileSync(file, '# 一\n\n新的内容。\n')
    utimesSync(file, new Date(1_752_100_001_000), new Date(1_752_100_001_000))
    await subject.sync()
    const second = subject.listSources('local')
    // 初始 sync 刚写入时的 mtime 秒可能恰好与新值一致——强制第二次 sync 用不同秒
    expect(second[0]!.sourceVersion).toBeGreaterThanOrEqual(1_752_100_001)
    expect(second[0]!.sourceVersion).not.toBe(first[0]!.sourceVersion)
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('removes deleted files from the index on sync', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    writeFileSync(join(vault, 'notes/a.md'), '# 知识库\n\n内容。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    expect(subject.listSources('local')).toHaveLength(1)
    rmSync(join(vault, 'notes/a.md'))
    await subject.sync()
    expect(subject.listSources('local')).toHaveLength(0)
    expect(subject.query({ realm: 'local', roles: ['viewer'], text: '知识库', topK: 3, scope: 'published' })).toHaveLength(0)
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('fails closed with capability unavailable when the vault is missing', async () => {
    const { db } = tempVault()
    const missing = join(tmpdir(), `missing-vault-${process.pid}-${Math.random().toString(36).slice(2)}`)
    // dbPath 与 vaultRoot 解耦：构造器只 mkdir 索引父目录，不碰 vault 本体。
    const subject = new VaultKnowledgeProvider({ vaultRoot: missing, dbPath: db })
    await expect(subject.sync()).rejects.toMatchObject({ code: 'capability_unavailable' })
    subject.close()
    rmSync(db, { force: true })
  })

  it('returns nothing for foreign realms and draft scope', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    writeFileSync(join(vault, 'notes/a.md'), '# 知识库\n\n内容。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    expect(subject.query({ realm: 'other', roles: ['viewer'], text: '知识库', topK: 3, scope: 'published' })).toHaveLength(0)
    expect(subject.query({ realm: 'local', roles: ['viewer'], text: '知识库', topK: 3, scope: 'draft' })).toHaveLength(0)
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('refuses source editing with capability unavailable (vault is the truth, edit in Obsidian)', async () => {
    const { vault, db } = tempVault()
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await expect(subject.upsertSource({
      docId: 'eA==', realm: 'local', space: 'general', title: 'x',
      chunks: [{ text: 'x', metadata: {} }],
    })).rejects.toMatchObject({ code: 'capability_unavailable' })
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('enforces expected source version on remove and deletes the index row when it matches', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    writeFileSync(join(vault, 'notes/a.md'), '# 知识库\n\n内容。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    const summary = subject.listSources('local')[0]!
    await expect(subject.removeSource(summary.docId, 'local', summary.sourceVersion + 1))
      .rejects.toMatchObject({ name: 'KnowledgeSourceConflictError' })
    await subject.removeSource(summary.docId, 'local', summary.sourceVersion)
    expect(subject.listSources('local')).toHaveLength(0)
    subject.close()
    rmSync(vault, { recursive: true, force: true })
  })

  it('reports status with counts and last sync, persisted across reopen', async () => {
    const { vault, db } = tempVault()
    mkdirSync(join(vault, 'notes'))
    writeFileSync(join(vault, 'notes/a.md'), '# 知识库\n\n内容。\n')
    const subject = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    await subject.sync()
    const status = subject.status()
    expect(status.docCount).toBe(1)
    expect(status.chunkCount).toBeGreaterThanOrEqual(1)
    expect(status.mode).toBe('keyword')
    expect(status.error).toBeNull()
    subject.close()
    const reopened = new VaultKnowledgeProvider({ vaultRoot: vault, dbPath: db })
    expect(reopened.status().docCount).toBe(1)
    reopened.close()
    rmSync(vault, { recursive: true, force: true })
  })
})
