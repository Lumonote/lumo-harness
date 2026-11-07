import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { KnowledgeLibraryFile } from '../../../shared/seam-contracts/knowledge.ts'
import { PgKnowledgeProvider } from '../src/pg-provider.ts'
import { schemaDsn } from './pg-schema.ts'

const DSN = process.env['KNOWLEDGE_TEST_DSN'] ?? process.env['LUMO_TEST_PG_DSN']
const test = DSN ? it : it.skip
const embedding = { dimension: 3, async embed(texts: readonly string[]) { return texts.map(() => [0.1, 0.2, 0.3]) } }

async function fixture() {
  const connectionString = await schemaDsn(DSN!, 'knowledge_library_grants_test')
  const config = { connectionString, embedding, embeddingModel: 'm1', allowedRoles: ['viewer', 'editor'] }
  const editor = new PgKnowledgeProvider(config)
  const owner = new PgKnowledgeProvider(config)
  await editor.init()
  const db = new pg.Pool({ connectionString })
  const realm = `grant-race-${randomUUID()}`
  const folders: string[] = []
  async function folder(ownerUserId: string, parentId: string | null = null) {
    const result = await owner.createLibraryFolder({ realm, name: randomUUID(), parentId, ownerUserId, roles: ['viewer'], isAdmin: true })
    folders.push(result.folderId)
    return result.folderId
  }
  async function file(folderId: string | null) {
    const record: KnowledgeLibraryFile = {
      docId: `file-${randomUUID()}`, realm, folderId, filename: 'Private.txt', mimeType: 'text/plain',
      objectKey: 'sha256/example', sha256: 'a'.repeat(64), byteSize: 1, ownerUserId: 'file-owner',
      extractionState: 'ready', ocrState: 'not_needed', createdAt: new Date().toISOString(),
    }
    await owner.createLibraryFile(record)
    return record.docId
  }
  async function close() {
    await Promise.all([editor.close(), owner.close()])
    for (const table of ['knowledge_library_file_grants', 'knowledge_library_folder_grants', 'knowledge_library_files']) await db.query(`DELETE FROM ${table} WHERE realm=$1`, [realm])
    for (const id of folders.reverse()) await db.query('DELETE FROM knowledge_library_folders WHERE realm=$1 AND folder_id=$2', [realm, id])
    await db.end()
  }
  return { editor, owner, realm, folder, file, close }
}

/**
 * Pause only an explicit transaction checkout, not pool.query's callback-based
 * checkouts. In the broken implementation this point comes after its permission
 * preflight; in the fixed implementation it comes before the locked recheck.
 */
function gateTransaction(provider: PgKnowledgeProvider) {
  const pool = (provider as unknown as { pool: pg.Pool }).pool
  const original = pool.connect.bind(pool)
  let release!: () => void
  let reached!: () => void
  let held = false
  const barrier = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { reached = resolve })
  pool.connect = ((...args: unknown[]) => {
    if (args.length === 0 && !held) {
      held = true; reached()
      return barrier.then(() => original())
    }
    return Reflect.apply(original, pool, args)
  }) as typeof pool.connect
  return { started, release, restore: () => { pool.connect = original } }
}

describe('资料分享撤权的并发边界（真实 PG）', () => {
  for (const inherited of [false, true]) {
    for (const resourceType of ['file', 'folder'] as const) {
      test(`${inherited ? '祖先目录' : '直接'} editor 权限被撤回后，旧的 ${resourceType} 分享请求不能重新授权自身`, async () => {
        const f = await fixture()
        let gate: ReturnType<typeof gateTransaction> | undefined
        let pending: Promise<void> | undefined
        try {
          const root = await f.folder('folder-owner')
          const child = await f.folder('child-owner', root)
          const docId = await f.file(child)
          const target = resourceType === 'file' ? docId : child
          const grantType = inherited ? 'folder' : resourceType
          const grantID = inherited ? root : target
          const grantOwner = inherited ? 'folder-owner' : resourceType === 'file' ? 'file-owner' : 'child-owner'
          const writer = { realm: f.realm, resourceType: grantType, resourceId: grantID, actorUserId: grantOwner, roles: ['viewer'], isAdmin: false }
          await f.owner.setLibraryGrants({ ...writer, grants: [{ type: 'user', id: 'editor', access: 'editor' }] })
          gate = gateTransaction(f.editor)
          pending = f.editor.setLibraryGrants({ realm: f.realm, resourceType, resourceId: target, actorUserId: 'editor', roles: ['viewer'], isAdmin: false, grants: [{ type: 'user', id: 'editor', access: 'editor' }] })
          // Attach rejection handling before releasing the barrier.
          const outcome = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
          await Promise.race([gate.started, outcome.then(() => { throw new Error('stale request did not reach transaction gate') })])
          await f.owner.setLibraryGrants({ ...writer, grants: [] })
          gate.release()
          const result = await outcome
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error).toMatchObject({ code: 'forbidden' })
          expect(await f.owner.listLibraryGrants(f.realm, resourceType, target)).toEqual([])
          expect(await f.owner.listLibraryGrants(f.realm, grantType, grantID)).toEqual([])
          if (resourceType === 'file') expect(await f.owner.canAccessLibraryFile({ realm: f.realm, docId: target, userId: 'editor', roles: ['viewer'], isAdmin: false, access: 'editor' })).toBe(false)
          else expect(await f.owner.canAccessLibraryFolder({ realm: f.realm, folderId: target, userId: 'editor', roles: ['viewer'], isAdmin: false, access: 'editor' })).toBe(false)
        } finally {
          gate?.release()
          await pending?.catch(() => {})
          gate?.restore()
          await f.close()
        }
      })
    }
  }
})
