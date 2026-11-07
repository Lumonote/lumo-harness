import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { KnowledgeHit, KnowledgeLibraryFile, KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import { authenticatedKnowledgeRequest } from '../../../shared/seam-contracts/knowledge.ts'
import { PgKnowledgeProvider } from '../src/pg-provider.ts'
import { schemaDsn } from './pg-schema.ts'

const DSN = process.env['KNOWLEDGE_TEST_DSN'] ?? process.env['LUMO_TEST_PG_DSN']
const test = DSN ? it : it.skip
const embedding = { dimension: 3, async embed(texts: readonly string[]) { return texts.map(() => [0.1, 0.2, 0.3]) } }
async function fixture() {
  const connectionString = await schemaDsn(DSN!, 'knowledge_user_project_test')
  const db = new pg.Pool({ connectionString })
  const hits: KnowledgeHit[] = []
  let duringQuery: (() => Promise<void>) | undefined
  const projection: KnowledgeSeam = { async ingest() {}, async remove() {}, async rebuild() {}, async query() { await duringQuery?.(); return hits } }
  const provider = new PgKnowledgeProvider({ connectionString, embedding, embeddingModel: 'm1', allowedRoles: ['viewer', 'editor'], vectorProjection: projection })
  await provider.init()
  await db.query(`CREATE TABLE IF NOT EXISTS projects(id text PRIMARY KEY,realm text,status text);
    CREATE TABLE IF NOT EXISTS project_members(project_id text,user_id text,role text);
    CREATE TABLE IF NOT EXISTS project_spaces(space_id text PRIMARY KEY,project_id text,realm text);
    CREATE TABLE IF NOT EXISTS governance_users(realm text,id text,status text);
    TRUNCATE projects,project_members,project_spaces,governance_users,knowledge_chunks,knowledge_sources,knowledge_tombstones,
      knowledge_library_files,knowledge_library_file_grants,knowledge_library_folders,knowledge_library_folder_grants,
      knowledge_graph_outbox,knowledge_vector_outbox CASCADE;
    INSERT INTO projects VALUES('p','r','active'),('other','r','active'),('foreign','r2','active');
    INSERT INTO project_members VALUES('p','alice','viewer'),('p','bob','viewer'),('other','alice','owner'),('foreign','alice','owner');
    INSERT INTO project_spaces VALUES('s','p','r'),('s-other','other','r'),('s-foreign','foreign','r2');
    INSERT INTO governance_users VALUES('r','alice','active'),('r','bob','active'),('r2','alice','active');`)
  // Uploads establish file authority before extraction publishes a source.
  // A library-marked source without that row is correctly rejected as stale.
  const file: KnowledgeLibraryFile = { docId: 'private', realm: 'r', folderId: null, filename: 'Private.txt', mimeType: 'text/plain', objectKey: 'hash', sha256: 'a'.repeat(64), byteSize: 1, ownerUserId: 'alice', extractionState: 'ready', ocrState: 'not_needed', createdAt: new Date().toISOString() }
  await provider.createLibraryFile(file)
  for (const [docId, realm, space] of [['allowed', 'r', 's'], ['private', 'r', 's'], ['other-project', 'r', 's-other'], ['unbound', 'r', 'unbound'], ['foreign', 'r2', 's-foreign']]) {
    const text = `content-${docId}`
    await provider.ingest({ doc: { docId, realm, space, title: docId, sourceVersion: 1, embeddingModel: 'm1' }, chunks: [{ text, metadata: docId === 'private' ? { libraryFile: true } : {} }] })
    hits.push({ docId, sourceVersion: 1, text, score: 1 })
  }
  const query = (userId = 'alice', extra = {}) => provider.query({ ...authenticatedKnowledgeRequest({ realm: 'r', userId, roles: ['viewer'] }, { projectId: 'p', text: 'q', topK: 10 }), ...extra })
  return { db, provider, query, during: (callback: () => Promise<void>) => { duringQuery = callback }, close: async () => { await provider.close(); await db.end() } }
}

describe('current-user project knowledge authority (real PG)', () => {
  test('isolates project Spaces and current private-file ACLs', async () => {
    const f = await fixture()
    try {
      expect((await f.query()).map(hit => hit.docId)).toEqual(['allowed', 'private'])
      expect((await f.query('bob')).map(hit => hit.docId)).toEqual(['allowed'])
      expect(await f.query('alice', { spaces: ['s-other'] })).toEqual([])
      expect(await f.query('alice', { spaces: [] })).toEqual([])
      await expect(f.query('bob', { projectId: 'other' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.query('alice', { projectId: 'foreign' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.query('alice', { userId: undefined })).rejects.toMatchObject({ code: 'forbidden' })
      await f.db.query(`DELETE FROM project_members WHERE project_id='p' AND user_id='alice'`)
      await expect(f.query()).rejects.toMatchObject({ code: 'forbidden' })
    } finally { await f.close() }
  })
  for (const mutation of [
    `DELETE FROM project_members WHERE project_id='p' AND user_id='alice'`,
    `UPDATE governance_users SET status='disabled' WHERE realm='r' AND id='alice'`,
    `UPDATE projects SET status='archived' WHERE id='p'`,
    `DELETE FROM project_spaces WHERE space_id='s'`,
  ]) test(`rechecks final authority after candidates: ${mutation}`, async () => {
    const f = await fixture()
    try { f.during(async () => { await f.db.query(mutation) }); expect(await f.query()).toEqual([]) }
    finally { await f.close() }
  })
  test('does not return a file after its sharing ACL is revoked during recall', async () => {
    const f = await fixture()
    try {
      const grant = { realm: 'r', resourceType: 'file' as const, resourceId: 'private', actorUserId: 'alice', roles: ['viewer'], isAdmin: false }
      await f.provider.setLibraryGrants({ ...grant, grants: [{ type: 'user', id: 'bob', access: 'viewer' }] })
      expect((await f.query('bob')).map(hit => hit.docId)).toContain('private')
      f.during(async () => { await f.provider.setLibraryGrants({ ...grant, grants: [] }) })
      expect((await f.query('bob')).map(hit => hit.docId)).toEqual(['allowed'])
    } finally { await f.close() }
  })
  test('refuses a query when project authority tables are missing', async () => {
    const f = await fixture()
    try {
      await f.db.query('DROP TABLE project_members')
      await expect(f.query()).rejects.toMatchObject({ code: '42P01' })
    } finally { await f.close() }
  })
})
