import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VaultIndex, type VaultDocRecord } from '../src/vault-index.ts'

function tempDb(): string {
  const path = join(tmpdir(), `knowledge-vault-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`)
  return path
}

const doc = (over: Partial<VaultDocRecord> = {}): VaultDocRecord => ({
  docId: 'bm90ZXMvYQ==',
  path: 'notes/a.md',
  realm: 'local',
  space: 'notes',
  title: 'A',
  sourceVersion: 1,
  updatedAt: 1_752_000_000_000,
  chunks: [{ text: '知识库文档的检索方法', metadata: { heading: '方法' } }],
  ...over,
})

describe('vault index (node:sqlite + FTS5)', () => {
  it('inserts a doc and retrieves it via a Chinese BM25 phrase query', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc())
    const hits = index.query('local', '知识库文档', 3)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.docId).toBe('bm90ZXMvYQ==')
    expect(hits[0]!.sourceVersion).toBe(1)
    expect(hits[0]!.text).toBe('知识库文档的检索方法')
    expect(hits[0]!.score).toBeLessThan(0) // bm25 负分制
    index.close()
    rmSync(db, { force: true })
  })

  it('replaces chunks on update without duplication', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc())
    index.upsertDoc(doc({ sourceVersion: 2, chunks: [{ text: '新的内容', metadata: { heading: '新' } }] }))
    expect(index.query('local', '知识库文档', 3)).toHaveLength(0)
    expect(index.query('local', '新的内容', 3)).toHaveLength(1)
    expect(JSON.parse(index.getDoc('bm90ZXMvYQ==')!.chunksJSON)).toHaveLength(1)
    index.close()
    rmSync(db, { force: true })
  })

  it('removes a doc from both the source row and the FTS index', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc())
    index.removeDoc('bm90ZXMvYQ==')
    expect(index.listDocs('local')).toHaveLength(0)
    expect(index.query('local', '知识库文档', 3)).toHaveLength(0)
    index.close()
    rmSync(db, { force: true })
  })

  it('scopes queries to the requested realm', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc({ docId: 'bm90ZXMvYQ==', path: 'notes/a.md', realm: 'local' }))
    index.upsertDoc(doc({ docId: 'bm90ZXMvYg==', path: 'notes/b.md', realm: 'other' }))
    expect(index.query('other', '知识库文档', 3)).toHaveLength(1)
    index.close()
    rmSync(db, { force: true })
  })

  it('orders by relevance and honors topK', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc({ docId: 'ZG9jLTE=', path: 'doc-1.md', chunks: [{ text: '向量检索与知识库文档', metadata: {} }] }))
    index.upsertDoc(doc({ docId: 'ZG9jLTI=', path: 'doc-2.md', chunks: [{ text: '知识库文档', metadata: {} }] }))
    const hits = index.query('local', '向量检索 知识库', 1)
    expect(hits[0]!.docId).toBe('ZG9jLTE=')
    expect(hits).toHaveLength(1)
    index.close()
    rmSync(db, { force: true })
  })

  it('falls back to LIKE for terms shorter than trigram windows', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc({ docId: 'ZG9jLQ==', path: 'doc-.md', chunks: [{ text: '连接器需要审批。', metadata: {} }] }))
    const hits = index.query('local', '审批', 3)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]!.docId).toBe('ZG9jLQ==')
    index.close()
    rmSync(db, { force: true })
  })

  it('reports doc/chunk counts and last sync from meta', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc())
    index.upsertDoc(doc({ docId: 'cmVhZG1l', path: 'README.md', space: 'general', sourceVersion: 2 }))
    index.markSynced(1_752_000_000_000, null)
    const status = index.status()
    expect(status.docCount).toBe(2)
    expect(status.chunkCount).toBe(2)
    expect(status.lastSyncAt).toBe(1_752_000_000_000)
    expect(status.error).toBeNull()
    index.close()
    rmSync(db, { force: true })
  })

  it('survives a reopen on the same file', () => {
    const db = tempDb()
    const index = new VaultIndex(db)
    index.upsertDoc(doc())
    index.close()
    const reopened = new VaultIndex(db)
    expect(reopened.listDocs('local')).toHaveLength(1)
    reopened.close()
    expect(existsSync(db)).toBe(true)
    rmSync(db, { force: true })
  })
})
