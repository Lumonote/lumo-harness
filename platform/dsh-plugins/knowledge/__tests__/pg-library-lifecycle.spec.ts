import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeLibraryFile, KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphNode, GraphSeam } from '../../../shared/seam-contracts/graph.ts'
import { GraphProjector } from '../src/graph-projector.ts'
import { KnowledgeSourceConflictError, PgKnowledgeProvider } from '../src/pg-provider.ts'
import { schemaDsn } from './pg-schema.ts'

const DSN = process.env['KNOWLEDGE_TEST_DSN'] ?? process.env['LUMO_TEST_PG_DSN']
const test = DSN ? it : it.skip
const digest = 'a'.repeat(64)
const embedding = { dimension: 3, async embed(texts: readonly string[]) { return texts.map(() => [0.1, 0.2, 0.3]) } }

async function fixture(vectorProjection?: KnowledgeSeam, embeddingClient = embedding) {
  const connectionString = await schemaDsn(DSN!, 'knowledge_library_lifecycle_test')
  const provider = new PgKnowledgeProvider({ connectionString, embedding: embeddingClient, embeddingModel: 'm1', allowedRoles: ['viewer', 'editor'], vectorProjection })
  await provider.init()
  const realm = `library-${randomUUID()}`
  const db = new pg.Pool({ connectionString })
  const folders: string[] = []
  async function folder(ownerUserId = 'owner', parentId: string | null = null) {
    const result = await provider.createLibraryFolder({ realm, parentId, name: randomUUID(), ownerUserId, roles: ['editor'], isAdmin: true })
    folders.push(result.folderId)
    return result.folderId
  }
  async function file(input: Partial<KnowledgeLibraryFile> = {}, indexed = true) {
    const result: KnowledgeLibraryFile = {
      docId: `file-${randomUUID()}`, realm, folderId: null, filename: '报告.txt', mimeType: 'text/plain',
      objectKey: `sha256/${digest}`, byteSize: 9, sha256: digest, ownerUserId: 'owner',
      extractionState: 'ready', ocrState: 'not_needed', createdAt: new Date().toISOString(), ...input,
    }
    await provider.createLibraryFile(result)
    if (indexed) await provider.upsertSource({
      docId: result.docId, realm: result.realm, space: 'library', title: result.filename,
      chunks: [{ text: '私有业务报告', metadata: { libraryFile: true } }],
    })
    return result
  }
  const deletion = (docId: string, actorUserId = 'owner', roles = ['viewer'], expectedSha256 = digest) =>
    provider.deleteLibraryFile({ realm, docId, actorUserId, roles, expectedSha256, isAdmin: false })
  const query = (userId?: string, roles = ['viewer']) => provider.query({ realm, userId, roles, text: '报告', topK: 50, scope: 'published' })
  async function close() {
    await provider.close()
    for (const table of ['knowledge_library_file_grants', 'knowledge_library_files', 'knowledge_library_folder_grants', 'knowledge_chunks', 'knowledge_sources', 'knowledge_tombstones', 'knowledge_graph_outbox', 'knowledge_vector_outbox']) {
      await db.query(`DELETE FROM ${table} WHERE realm=$1`, [realm])
    }
    for (const folderId of folders.reverse()) await db.query('DELETE FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2', [realm, folderId])
    await db.end()
  }
  return { provider, realm, db, connectionString, folder, file, deletion, query, close }
}

describe('资料库文件完整生命周期（真实 PG；未配置 DSN 时跳过）', () => {
  test('删除文件原子失效来源、分片、分享，写入墓碑和持久清理意图，并允许删除空目录', async () => {
    const f = await fixture()
    try {
      const folderId = await f.folder()
      const file = await f.file({ folderId })
      await f.provider.setLibraryGrants({ realm: f.realm, resourceType: 'file', resourceId: file.docId, actorUserId: 'owner', roles: ['viewer'], isAdmin: false, grants: [{ type: 'user', id: 'reader', access: 'viewer' }] })
      expect(await f.query('reader')).toHaveLength(1)
      await f.deletion(file.docId)
      expect(await f.provider.getLibraryFile(file.docId, f.realm)).toBeUndefined()
      expect(await f.provider.getSource(file.docId, f.realm)).toBeUndefined()
      expect(await f.query('reader')).toEqual([])
      for (const table of ['knowledge_chunks', 'knowledge_library_file_grants']) {
        expect((await f.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE realm=$1 AND doc_id=$2`, [f.realm, file.docId])).rows[0].n).toBe(0)
      }
      expect((await f.db.query('SELECT 1 FROM knowledge_tombstones WHERE realm=$1 AND doc_id=$2', [f.realm, file.docId])).rowCount).toBe(1)
      expect((await f.db.query("SELECT op FROM knowledge_graph_outbox WHERE realm=$1 AND doc_id=$2 ORDER BY seq DESC LIMIT 1", [f.realm, file.docId])).rows[0].op).toBe('remove')
      expect((await f.db.query('SELECT 1 FROM knowledge_vector_outbox WHERE realm=$1 AND doc_id=$2', [f.realm, file.docId])).rowCount).toBe(1)
      await f.provider.deleteLibraryFolder({ realm: f.realm, folderId, actorUserId: 'owner', roles: ['viewer'], isAdmin: false })
    } finally { await f.close() }
  })

  test('拒绝查看者、陌生用户、跨 Realm 和陈旧 SHA 的删除，回滚不破坏来源', async () => {
    const f = await fixture()
    try {
      const file = await f.file()
      await f.provider.setLibraryGrants({ realm: f.realm, resourceType: 'file', resourceId: file.docId, actorUserId: 'owner', roles: ['viewer'], isAdmin: false, grants: [{ type: 'user', id: 'reader', access: 'viewer' }] })
      for (const actor of ['reader', 'stranger']) await expect(f.deletion(file.docId, actor)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.provider.deleteLibraryFile({ realm: `${f.realm}-other`, docId: file.docId, actorUserId: 'owner', roles: ['viewer'], isAdmin: true, expectedSha256: digest })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.deletion(file.docId, 'owner', ['viewer'], 'b'.repeat(64))).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      await expect(f.deletion(file.docId, 'owner', ['viewer'], 'bad')).rejects.toBeInstanceOf(TypeError)
      expect(await f.provider.getLibraryFile(file.docId, f.realm)).toBeDefined()
      expect(await f.provider.getSource(file.docId, f.realm)).toBeDefined()
      expect(await f.query('owner')).toHaveLength(1)
      expect((await f.db.query('SELECT 1 FROM knowledge_tombstones WHERE realm=$1', [f.realm])).rowCount).toBe(0)
    } finally { await f.close() }
  })

  test('支持直接角色编辑与继承目录编辑；未签名身份不会因角色共享获得检索', async () => {
    const f = await fixture()
    try {
      const parent = await f.folder()
      const child = await f.folder('another-owner', parent)
      await f.provider.setLibraryGrants({ realm: f.realm, resourceType: 'folder', resourceId: parent, actorUserId: 'owner', roles: ['viewer'], isAdmin: false, grants: [{ type: 'user', id: 'folder-editor', access: 'editor' }] })
      const inherited = await f.file({ folderId: child, ownerUserId: 'file-owner' })
      const direct = await f.file()
      await f.provider.setLibraryGrants({ realm: f.realm, resourceType: 'file', resourceId: direct.docId, actorUserId: 'owner', roles: ['viewer'], isAdmin: false, grants: [{ type: 'role', id: 'editor', access: 'editor' }] })
      expect((await f.query(undefined, ['editor']))).toEqual([])
      expect((await f.query('role-user', ['editor'])).map(hit => hit.docId)).toEqual([direct.docId])
      await f.deletion(inherited.docId, 'folder-editor')
      await f.deletion(direct.docId, 'role-user', ['editor'])
      expect(await f.provider.getSource(inherited.docId, f.realm)).toBeUndefined()
      expect(await f.provider.getSource(direct.docId, f.realm)).toBeUndefined()
    } finally { await f.close() }
  })

  test('无文本来源、提取失败和不支持格式的文件仍可删除', async () => {
    const f = await fixture()
    try {
      for (const extractionState of ['pending', 'failed', 'unsupported'] as const) {
        const file = await f.file({ extractionState }, false)
        await expect(f.deletion(file.docId)).resolves.toBeUndefined()
        expect(await f.provider.getLibraryFile(file.docId, f.realm)).toBeUndefined()
        await expect(f.deletion(file.docId)).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      }
    } finally { await f.close() }
  })

  test('上传嵌入计算挂起期间删除文件，迟到的 ingest 和 upsert 均不得复活来源或墓碑', async () => {
    for (const operation of ['upsert', 'ingest'] as const) {
      let unblock!: () => void
      let markStarted!: () => void
      const blocked = new Promise<void>(resolve => { unblock = resolve })
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const f = await fixture(undefined, { dimension: 3, async embed(texts: readonly string[]) {
        markStarted()
        await blocked
        return embedding.embed(texts)
      } })
      let pending: Promise<unknown> | undefined
      try {
        const file = await f.file({ extractionState: 'pending' }, false)
        const entry = { docId: file.docId, realm: f.realm, space: 'library', title: file.filename,
          chunks: [{ text: '删除后不得恢复的报告', metadata: { libraryFile: true } }] }
        pending = operation === 'upsert' ? f.provider.upsertSource(entry) : f.provider.ingest({
          doc: { docId: entry.docId, realm: entry.realm, space: entry.space, title: entry.title, sourceVersion: 1, embeddingModel: 'm1' }, chunks: entry.chunks,
        })
        const outcome = pending.then(() => undefined, error => error)
        await Promise.race([started, outcome.then(() => { throw new Error('write did not reach embedding') })])
        await f.deletion(file.docId)
        unblock()
        expect(await outcome).toBeInstanceOf(KnowledgeSourceConflictError)
        expect(await f.provider.getSource(file.docId, f.realm)).toBeUndefined()
        expect((await f.db.query('SELECT library_file FROM knowledge_tombstones WHERE doc_id=$1 AND realm=$2', [file.docId, f.realm])).rows).toEqual([{ library_file: true }])
        expect((await f.db.query('SELECT 1 FROM knowledge_chunks WHERE doc_id=$1 AND realm=$2', [file.docId, f.realm])).rowCount).toBe(0)
        expect((await f.db.query('SELECT op FROM knowledge_graph_outbox WHERE doc_id=$1 AND realm=$2 ORDER BY seq', [file.docId, f.realm])).rows).toEqual([{ op: 'remove' }])
        // Dropping the library marker must not let a stale job reuse the deleted file's ID.
        await expect(f.provider.upsertSource({ ...entry, chunks: [{ text: '伪装成手工来源', metadata: {} }] })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
        await expect(f.provider.ingest({ doc: { docId: entry.docId, realm: entry.realm, space: 'manual', title: '', sourceVersion: 99, embeddingModel: 'm1' }, chunks: [{ text: '无标签旧写入', metadata: {} }] })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      } finally { unblock(); await pending?.catch(() => undefined); await f.close() }
    }
  })

  test('拒绝无文件的资料来源，正常手工新建和同 ID 重建仍可用，编辑资料保留文件标记', async () => {
    const f = await fixture()
    try {
      const docId = `manual-${randomUUID()}`
      const entry = { docId, realm: f.realm, space: 'manual', title: '手工来源', chunks: [{ text: '手工内容', metadata: {} }] }
      const created = await f.provider.upsertSource(entry)
      await f.provider.removeSource(docId, f.realm, created.sourceVersion)
      await expect(f.provider.upsertSource(entry)).resolves.toMatchObject({ docId })
      await expect(f.provider.upsertSource({ ...entry, docId: `missing-${randomUUID()}`, chunks: [{ text: '缺少资料文件', metadata: { libraryFile: true } }] })).rejects.toBeInstanceOf(KnowledgeSourceConflictError)
      const file = await f.file()
      await f.provider.upsertSource({ ...entry, docId: file.docId, expectedSourceVersion: 1 })
      expect((await f.provider.getSource(file.docId, f.realm))?.chunks[0]?.metadata.libraryFile).toBe(true)
    } finally { await f.close() }
  })

  test('搜索先读取候选、随后发生删除时，最终权限过滤不会把消失的文件误当成公开来源', async () => {
    const f = await fixture()
    const pool = (f.provider as unknown as { pool: pg.Pool }).pool
    const original = pool.query.bind(pool)
    try {
      const file = await f.file()
      pool.query = (async (sql: string, values: unknown[]) => {
        const result = await original(sql, values)
        if (sql.includes('AS distance')) await f.deletion(file.docId)
        return result
      }) as typeof pool.query
      expect(await f.query('owner')).toEqual([])
      expect(await f.provider.getSource(file.docId, f.realm)).toBeUndefined()
      pool.query = original
      const orphan = await f.file()
      await f.provider.removeLibraryFile(orphan.docId, f.realm)
      expect(await f.query('owner')).toEqual([])
    } finally { pool.query = original; await f.close() }
  })

  test('列表在一次数据库查询内计算多级 ACL 和 canEdit，保持 Realm 隔离', async () => {
    const f = await fixture()
    try {
      const root = await f.folder()
      const child = await f.folder('child-owner', root)
      const hidden = await f.folder('secret-owner')
      await f.provider.setLibraryGrants({ realm: f.realm, resourceType: 'folder', resourceId: root, actorUserId: 'owner', roles: ['viewer'], isAdmin: false, grants: [{ type: 'user', id: 'reader', access: 'viewer' }, { type: 'role', id: 'editor', access: 'editor' }] })
      const inherited = await f.file({ folderId: child, ownerUserId: 'file-owner' }, false)
      await f.file({ folderId: hidden, ownerUserId: 'secret-owner' }, false)
      const direct = await f.file({ ownerUserId: 'someone-else' }, false)
      await f.provider.setLibraryGrants({ realm: f.realm, resourceType: 'file', resourceId: direct.docId, actorUserId: 'someone-else', roles: ['viewer'], isAdmin: false, grants: [{ type: 'user', id: 'reader', access: 'editor' }] })
      const pool = (f.provider as unknown as { pool: pg.Pool }).pool
      const calls = vi.spyOn(pool, 'query')
      const visibleFolders = await f.provider.listLibraryFolders(f.realm, 'reader', ['viewer'], false)
      expect(calls).toHaveBeenCalledTimes(1)
      expect(visibleFolders.map(item => item.folderId).sort()).toEqual([root, child].sort())
      expect(visibleFolders.every(item => item.canEdit === false)).toBe(true)
      calls.mockClear()
      const visibleFiles = await f.provider.listLibraryFiles(f.realm, 'reader', ['viewer'], false)
      expect(calls).toHaveBeenCalledTimes(1)
      expect(visibleFiles.map(item => [item.docId, item.canEdit]).sort()).toEqual([[direct.docId, true], [inherited.docId, false]].sort())
      expect((await f.provider.listLibraryFiles(f.realm, 'role-editor', ['editor'], false)).map(item => [item.docId, item.canEdit])).toEqual([[inherited.docId, true]])
      expect((await f.provider.listLibraryFolders(f.realm, 'role-editor', ['editor'], false)).every(item => item.canEdit === true)).toBe(true)
      expect(await f.provider.listLibraryFiles(`${f.realm}-other`, 'reader', ['viewer'], true)).toEqual([])
      calls.mockRestore()
    } finally { await f.close() }
  })

  test('远端向量清理失败时立即阻止旧命中，并通过持久 outbox 幂等恢复', async () => {
    let remoteHits: Awaited<ReturnType<KnowledgeSeam['query']>> = []
    let fail = false
    const projection: KnowledgeSeam = {
      async ingest(entry) { remoteHits = entry.chunks.map(chunk => ({ docId: entry.doc.docId, sourceVersion: entry.doc.sourceVersion, text: chunk.text, score: 0 })) },
      async query() { return remoteHits },
      async remove() { if (fail) throw new Error('remote unavailable'); remoteHits = [] },
      async rebuild() {},
    }
    const f = await fixture(projection)
    try {
      const file = await f.file()
      await f.provider.drainVectorProjection()
      expect(await f.query('owner')).toHaveLength(1)
      await f.deletion(file.docId)
      fail = true
      await expect(f.provider.drainVectorProjection()).rejects.toThrow('remote unavailable')
      expect(remoteHits).toHaveLength(1)
      expect(await f.query('owner')).toEqual([])
      expect((await f.db.query('SELECT 1 FROM knowledge_vector_outbox WHERE realm=$1', [f.realm])).rowCount).toBe(1)
      fail = false
      expect(await f.provider.drainVectorProjection()).toBeGreaterThanOrEqual(1)
      expect(remoteHits).toEqual([])
      expect((await f.db.query('SELECT 1 FROM knowledge_vector_outbox WHERE realm=$1', [f.realm])).rowCount).toBe(0)
      expect(await f.provider.drainVectorProjection()).toBe(0)
    } finally { await f.close() }
  })

  test('两个图投影实例不能越过被锁的早期 upsert 提前处理 remove', async () => {
    const f = await fixture()
    let unblock!: () => void
    let markStarted!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const nodes = new Map<string, GraphNode>()
    const graph: GraphSeam = {
      async upsertNodes(items) { markStarted(); await blocked; for (const node of items) nodes.set(node.id, node) },
      async upsertEdges() {}, async removeNode(id) { nodes.delete(id) },
      async neighborhood() { return { origin: '', nodes: [], edges: [], depth: 0, truncated: false } },
    }
    const first = new GraphProjector({ connectionString: f.connectionString }, graph)
    const second = new GraphProjector({ connectionString: f.connectionString }, graph)
    let pending: Promise<number> | undefined
    try {
      const file = await f.file()
      await f.deletion(file.docId)
      pending = first.drain()
      await Promise.race([started, pending.then(() => { throw new Error('projector did not reach the blocked graph write') })])
      expect(await second.drain()).toBe(0)
      unblock()
      expect(await pending).toBe(1)
      expect(nodes.has(file.docId)).toBe(true)
      expect(await second.drain()).toBe(1)
      expect(nodes.has(file.docId)).toBe(false)
      expect(await second.drain()).toBe(0)
    } finally { unblock(); await pending; await first.close(); await second.close(); await f.close() }
  })
})
