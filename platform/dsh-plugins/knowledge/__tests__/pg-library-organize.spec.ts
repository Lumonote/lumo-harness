import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeLibraryFile } from '../../../shared/seam-contracts/knowledge.ts'
import { KnowledgeSourceConflictError, PgKnowledgeProvider } from '../src/pg-provider.ts'
import { schemaDsn } from './pg-schema.ts'

const DSN = process.env['KNOWLEDGE_TEST_DSN'] ?? process.env['LUMO_TEST_PG_DSN']
const test = DSN ? it : it.skip

async function fixture() {
  const connectionString = await schemaDsn(DSN!, 'knowledge_library_organize_test')
  const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [0.1, 0.2, 0.3]))
  const provider = new PgKnowledgeProvider({ connectionString, embedding: { dimension: 3, embed }, embeddingModel: 'm1', allowedRoles: ['viewer'] })
  await provider.init()
  const realm = `organize-${randomUUID()}`
  const db = new pg.Pool({ connectionString })
  async function folder(name: string = randomUUID(), ownerUserId = 'owner', parentId: string | null = null) {
    return provider.createLibraryFolder({ realm, name, ownerUserId, parentId, roles: ['viewer'], isAdmin: true })
  }
  async function file(folderId: string | null = null, ownerUserId = 'owner') {
    const record: KnowledgeLibraryFile = { docId: `file-${randomUUID()}`, realm, folderId, filename: '报告.txt', mimeType: 'text/plain',
      objectKey: `${realm}/content/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), byteSize: 12, ownerUserId,
      extractionState: 'ready', ocrState: 'not_needed', createdAt: new Date().toISOString() }
    await provider.createLibraryFile(record)
    await provider.upsertSource({ docId: record.docId, realm, space: 'library', title: record.filename, chunks: [{ text: '业务报告', metadata: { libraryFile: true, filename: record.filename } }] })
    return (await provider.getLibraryFile(record.docId, realm))!
  }
  const actor = { realm, actorUserId: 'owner', roles: ['viewer'], isAdmin: false }
  async function grant(resourceType: 'file' | 'folder', resourceId: string, id: string, access: 'viewer' | 'editor') {
    await provider.setLibraryGrants({ ...actor, isAdmin: true, resourceType, resourceId, grants: [{ type: 'user', id, access }] })
  }
  async function close() {
    await provider.close()
    for (const table of ['knowledge_library_file_grants', 'knowledge_library_files', 'knowledge_library_folder_grants', 'knowledge_chunks', 'knowledge_sources', 'knowledge_tombstones', 'knowledge_graph_outbox', 'knowledge_vector_outbox']) await db.query(`DELETE FROM ${table} WHERE realm=$1`, [realm])
    // Remove deepest folders first after moves rather than depending on creation order.
    await db.query(`WITH RECURSIVE paths AS (
      SELECT folder_id, parent_id, 0 AS depth FROM knowledge_library_folders WHERE realm=$1 AND parent_id IS NULL
      UNION ALL SELECT f.folder_id, f.parent_id, p.depth+1 FROM knowledge_library_folders f JOIN paths p ON f.parent_id=p.folder_id WHERE f.realm=$1
    ) SELECT folder_id FROM paths ORDER BY depth DESC`, [realm]).then(async result => {
      for (const row of result.rows) await db.query('DELETE FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2', [realm, row.folder_id])
    })
    await db.end()
  }
  return { provider, realm, db, embed, folder, file, actor, grant, close }
}

describe('资料库重命名和移动（真实 PG）', () => {
  test('文件改名更新权威来源与投影显示信息，保留对象、SHA、内容版本和embedding', async () => {
    const f = await fixture()
    try {
      const file = await f.file()
      f.embed.mockClear()
      const renamed = await f.provider.updateLibraryFile({ ...f.actor, docId: file.docId, expectedRevision: 1, filename: '年度报告.txt' })
      expect(renamed).toMatchObject({ filename: '年度报告.txt', revision: 2, objectKey: file.objectKey, sha256: file.sha256, canEdit: true })
      expect(f.embed).not.toHaveBeenCalled()
      expect(await f.provider.getSource(file.docId, f.realm)).toMatchObject({ doc: { title: '年度报告.txt', sourceVersion: 1 }, chunks: [{ text: '业务报告', metadata: { filename: '年度报告.txt', libraryFile: true } }] })
      expect((await f.db.query('SELECT title FROM knowledge_chunks WHERE realm=$1 AND doc_id=$2', [f.realm, file.docId])).rows).toEqual([{ title: '年度报告.txt' }])
      expect((await f.db.query('SELECT payload FROM knowledge_graph_outbox WHERE realm=$1 AND doc_id=$2 ORDER BY seq DESC LIMIT 1', [f.realm, file.docId])).rows[0].payload).toMatchObject({ title: '年度报告.txt', libraryFile: true })
    } finally { await f.close() }
  })

  test('目录改名和移动按revision保护，拒绝非法名、同名、自身和子树循环', async () => {
    const f = await fixture()
    try {
      const root = await f.folder('root')
      const child = await f.folder('child', 'owner', root.folderId)
      const target = await f.folder('target')
      const renamed = await f.provider.updateLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 1, name: 'renamed', parentId: target.folderId })
      expect(renamed).toMatchObject({ name: 'renamed', parentId: target.folderId, revision: 2, canEdit: true })
      await expect(f.provider.updateLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 1, name: 'stale' })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      for (const name of ['', '../escape', 'bad\u0000name']) await expect(f.provider.updateLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 2, name })).rejects.toBeInstanceOf(TypeError)
      await expect(f.provider.updateLibraryFolder({ ...f.actor, folderId: target.folderId, expectedRevision: 1, parentId: child.folderId })).rejects.toBeInstanceOf(TypeError)
      await expect(f.provider.updateLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 2, parentId: child.folderId })).rejects.toBeInstanceOf(TypeError)
      await f.folder('other', 'owner', target.folderId)
      await expect(f.provider.updateLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 2, name: 'OTHER' })).rejects.toMatchObject({ code: '23505' })
      expect((await f.provider.listLibraryFolders(f.realm, 'owner', ['viewer'], false)).find(item => item.folderId === child.folderId)).toMatchObject({ name: 'renamed', revision: 2 })
      await expect(f.provider.deleteLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 1 })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
    } finally { await f.close() }
  })

  test('移动文件要求源与目标editor，支持根目录，移动后立即重算继承可见性', async () => {
    const f = await fixture()
    try {
      const source = await f.folder('source')
      const target = await f.folder('target')
      const file = await f.file(source.folderId, 'other-file-owner')
      await f.grant('folder', source.folderId, 'mover', 'editor')
      await f.grant('folder', target.folderId, 'mover', 'viewer')
      await expect(f.provider.updateLibraryFile({ ...f.actor, actorUserId: 'mover', docId: file.docId, expectedRevision: 1, folderId: target.folderId })).rejects.toMatchObject({ code: 'forbidden' })
      await f.grant('folder', target.folderId, 'mover', 'editor')
      const moved = await f.provider.updateLibraryFile({ ...f.actor, actorUserId: 'mover', docId: file.docId, expectedRevision: 1, folderId: target.folderId })
      expect(moved).toMatchObject({ folderId: target.folderId, revision: 2, canEdit: true })
      const toRoot = await f.provider.updateLibraryFile({ ...f.actor, actorUserId: 'mover', docId: file.docId, expectedRevision: 2, folderId: null })
      expect(toRoot).toMatchObject({ folderId: null, revision: 3, canEdit: false })
      expect(await f.provider.listLibraryFiles(f.realm, 'mover', ['viewer'], false)).toEqual([])
      expect(await f.provider.query({ realm: f.realm, roles: ['viewer'], userId: 'mover', text: '报告', topK: 10, scope: 'published' })).toEqual([])
    } finally { await f.close() }
  })

  test('目录移动会即时切换整个子树ACL且保留文件直接分享', async () => {
    const f = await fixture()
    try {
      const source = await f.folder('source')
      const child = await f.folder('child', 'owner', source.folderId)
      const target = await f.folder('target')
      const file = await f.file(child.folderId)
      await f.grant('folder', source.folderId, 'old-reader', 'viewer')
      await f.grant('folder', target.folderId, 'new-reader', 'viewer')
      await f.grant('file', file.docId, 'direct-reader', 'viewer')
      await f.provider.updateLibraryFolder({ ...f.actor, folderId: child.folderId, expectedRevision: 1, parentId: target.folderId })
      expect(await f.provider.listLibraryFiles(f.realm, 'old-reader', ['viewer'], false)).toEqual([])
      expect((await f.provider.listLibraryFiles(f.realm, 'new-reader', ['viewer'], false)).map(item => item.docId)).toEqual([file.docId])
      expect((await f.provider.listLibraryFiles(f.realm, 'direct-reader', ['viewer'], false)).map(item => item.docId)).toEqual([file.docId])
    } finally { await f.close() }
  })

  test('拒绝viewer、跨realm目标、陈旧或非法revision及扩展名变更，失败不改变文件', async () => {
    const f = await fixture()
    let foreignRealm: string | undefined
    try {
      const file = await f.file()
      await f.grant('file', file.docId, 'reader', 'viewer')
      await expect(f.provider.updateLibraryFile({ ...f.actor, actorUserId: 'reader', docId: file.docId, expectedRevision: 1, filename: '不可编辑.txt' })).rejects.toMatchObject({ code: 'forbidden' })
      for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(f.provider.updateLibraryFile({ ...f.actor, docId: file.docId, expectedRevision, filename: 'bad.txt' })).rejects.toBeInstanceOf(TypeError)
      await expect(f.provider.updateLibraryFile({ ...f.actor, docId: file.docId, expectedRevision: 2, filename: 'stale.txt' })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      await expect(f.provider.updateLibraryFile({ ...f.actor, docId: file.docId, expectedRevision: 1, filename: '报告.html' })).rejects.toBeInstanceOf(TypeError)
      foreignRealm = `${f.realm}-foreign`
      const foreign = await f.provider.createLibraryFolder({ realm: foreignRealm, parentId: null, name: 'foreign', ownerUserId: 'owner', roles: ['viewer'], isAdmin: true })
      await expect(f.provider.updateLibraryFile({ ...f.actor, isAdmin: true, docId: file.docId, expectedRevision: 1, folderId: foreign.folderId })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      expect(await f.provider.getLibraryFile(file.docId, f.realm)).toMatchObject({ filename: '报告.txt', folderId: null, revision: 1 })
    } finally { if (foreignRealm) await f.db.query('DELETE FROM knowledge_library_folders WHERE realm=$1', [foreignRealm]); await f.close() }
  })

  test('并发目录循环移动只允许一项成功；并发文件整理使用同一revision只允许一项成功', async () => {
    const f = await fixture()
    try {
      const left = await f.folder('left')
      const right = await f.folder('right')
      const moves = await Promise.allSettled([
        f.provider.updateLibraryFolder({ ...f.actor, folderId: left.folderId, expectedRevision: 1, parentId: right.folderId }),
        f.provider.updateLibraryFolder({ ...f.actor, folderId: right.folderId, expectedRevision: 1, parentId: left.folderId }),
      ])
      expect(moves.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(moves.filter(item => item.status === 'rejected')).toHaveLength(1)
      const file = await f.file()
      const renames = await Promise.allSettled(['one.txt', 'two.txt'].map(filename => f.provider.updateLibraryFile({ ...f.actor, docId: file.docId, expectedRevision: 1, filename })))
      expect(renames.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      const rejected = renames.find(item => item.status === 'rejected')
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(KnowledgeSourceConflictError)
      expect((await f.provider.getLibraryFile(file.docId, f.realm))?.revision).toBe(2)
      await expect(f.provider.deleteLibraryFile({ ...f.actor, docId: file.docId, expectedSha256: file.sha256, expectedRevision: 1 })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      await expect(f.provider.deleteLibraryFile({ ...f.actor, docId: file.docId, expectedSha256: file.sha256, expectedRevision: 2 })).resolves.toBeUndefined()
    } finally { await f.close() }
  })

  test('迟到上传在注册文件事务内重新检查目标目录权限，撤权完成后拒绝落库', async () => {
    const f = await fixture()
    const pool = (f.provider as unknown as { pool: pg.Pool }).pool
    const original = pool.connect.bind(pool)
    let release!: () => void
    let markStarted!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let held = false
    let pending: Promise<void> | undefined
    try {
      const target = await f.folder('upload-target')
      await f.grant('folder', target.folderId, 'uploader', 'editor')
      expect(await f.provider.canAccessLibraryFolder({ realm: f.realm, folderId: target.folderId, userId: 'uploader', roles: ['viewer'], isAdmin: false, access: 'editor' })).toBe(true)
      const record: KnowledgeLibraryFile = { docId: `upload-${randomUUID()}`, realm: f.realm, folderId: target.folderId, filename: 'late.txt', mimeType: 'text/plain', objectKey: `${f.realm}/content/${'b'.repeat(64)}`, sha256: 'b'.repeat(64), byteSize: 1, ownerUserId: 'uploader', extractionState: 'ready', ocrState: 'not_needed', createdAt: new Date().toISOString() }
      pool.connect = ((...args: unknown[]) => {
        if (args.length === 0 && !held) { held = true; markStarted(); return barrier.then(() => original()) }
        return Reflect.apply(original, pool, args)
      }) as typeof pool.connect
      pending = f.provider.createLibraryFile(record, { roles: ['viewer'], isAdmin: false })
      const outcome = pending.then(() => undefined, error => error)
      await Promise.race([started, outcome.then(() => { throw new Error('upload did not reach registration gate') })])
      await f.provider.setLibraryGrants({ ...f.actor, resourceType: 'folder', resourceId: target.folderId, grants: [] })
      release()
      expect(await outcome).toMatchObject({ code: 'forbidden' })
      expect(await f.provider.getLibraryFile(record.docId, f.realm)).toBeUndefined()
    } finally { release(); await pending?.catch(() => undefined); pool.connect = original; await f.close() }
  })
})
