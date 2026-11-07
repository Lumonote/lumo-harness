import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { PgKnowledgeProvider } from '../src/pg-provider.ts'
import { schemaDsn } from './pg-schema.ts'
import type { KnowledgeLibraryFile } from '../../../shared/seam-contracts/knowledge.ts'

const dsn=process.env['LUMO_TEST_PG_DSN']
const live=dsn?it:it.skip
live('knowledge quota is atomic across writers, releases on authoritative deletion, and never revives a reference',async()=>{
 const connectionString=await schemaDsn(dsn!,'knowledge_storage_quota')
 const provider=new PgKnowledgeProvider({connectionString,embedding:{dimension:3,async embed(texts){return texts.map(()=>[.1,.2,.3])}},embeddingModel:'quota',allowedRoles:['viewer']})
 await provider.init()
 const db=new pg.Pool({connectionString});const realm=`quota-${randomUUID()}`
 const file=(docId:string):KnowledgeLibraryFile=>({docId,realm,folderId:null,filename:'sample.txt',mimeType:'text/plain',objectKey:'content/'+'a'.repeat(64),byteSize:5,sha256:'a'.repeat(64),ownerUserId:'owner',extractionState:'ready',ocrState:'not_needed',createdAt:new Date().toISOString()})
 try {
  await db.query(`INSERT INTO platform_storage_limits(realm,scope,scope_id,limit_bytes) VALUES($1,'realm','',5)`,[realm])
  const ids=Array.from({length:10},()=>`file-${randomUUID()}`)
  const attempts=await Promise.allSettled(ids.map(id=>provider.createLibraryFile(file(id))))
  expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1)
  for(const rejected of attempts.filter(x=>x.status==='rejected'))expect(rejected.reason.code).toBe('storage_quota_exceeded')
  const found=(await provider.listLibraryFiles(realm,'owner',['viewer'],true))[0]!
  expect((await db.query(`SELECT sum(bytes)::text AS n FROM platform_storage_charges WHERE realm=$1 AND released_at IS NULL`,[realm])).rows[0].n).toBe('5')
  await provider.removeLibraryFile(found.docId,realm)
  expect((await db.query(`SELECT sum(bytes)::text AS n FROM platform_storage_charges WHERE realm=$1 AND released_at IS NULL`,[realm])).rows[0].n).toBeNull()
  await expect(provider.createLibraryFile(file(found.docId))).rejects.toThrow('immutable')
  await provider.createLibraryFile(file(`file-${randomUUID()}`))
 } finally {await db.query(`DELETE FROM knowledge_library_files WHERE realm=$1`,[realm]);await db.query(`DELETE FROM platform_storage_charges WHERE realm=$1`,[realm]);await db.query(`DELETE FROM platform_storage_limits WHERE realm=$1`,[realm]);await db.end();await provider.close()}
})

live('replica startup backfills without holding metadata DDL locks against a live upload', async () => {
  const connectionString = await schemaDsn(dsn!, 'knowledge_storage_startup')
  const config = { connectionString, embedding: { dimension: 3, async embed(texts: string[]) { return texts.map(() => [.1, .2, .3]) } }, embeddingModel: 'quota', allowedRoles: ['viewer'] }
  const writer = new PgKnowledgeProvider(config)
  await writer.init()
  const applicationName = `quota-startup-${randomUUID()}`
  const startupURL = new URL(connectionString)
  startupURL.searchParams.set('application_name', applicationName)
  const replica = new PgKnowledgeProvider({ ...config, connectionString: startupURL.toString() })
  const db = new pg.Pool({ connectionString })
  const realm = `startup-${randomUUID()}`
  const file = (docId: string): KnowledgeLibraryFile => ({ docId, realm, folderId: null, filename: 'sample.txt', mimeType: 'text/plain', objectKey: 'content/' + 'a'.repeat(64), byteSize: 5, sha256: 'a'.repeat(64), ownerUserId: 'owner', extractionState: 'ready', ocrState: 'not_needed', createdAt: new Date().toISOString() })
  const pool = (writer as unknown as { pool: pg.Pool }).pool
  const connect = pool.connect.bind(pool)
  let release!: () => void
  let reached!: (pid: number) => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<number>(resolve => { reached = resolve })
  let upload: Promise<void> | undefined
  let startup: Promise<void> | undefined
  try {
    const historical = file(`historical-${randomUUID()}`)
    await writer.createLibraryFile(historical)
    // Reproduce an upgrade with an authoritative file awaiting its first charge.
    await db.query(`DELETE FROM platform_storage_charges WHERE realm=$1`, [realm])
    pool.connect = ((...args: unknown[]) => {
      if (args.length !== 0) return Reflect.apply(connect, pool, args)
      return connect().then(client => {
        const query = client.query.bind(client)
        client.query = (async (...queryArgs: unknown[]) => {
          if (typeof queryArgs[0] === 'string' && queryArgs[0].trimStart().startsWith('INSERT INTO knowledge_library_files')) {
            const row = await query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
            reached(row.rows[0]!.pid)
            await gate
            client.query = query
          }
          return Reflect.apply(query, client, queryArgs)
        }) as typeof client.query
        return client
      })
    }) as typeof pool.connect
    const current = file(`live-${randomUUID()}`)
    upload = writer.createLibraryFile(current)
    const uploadOutcome = upload.then(() => undefined, error => error)
    const writerPID = await Promise.race([started, uploadOutcome.then(() => { throw new Error('Upload did not reach its authoritative metadata write') })])
    startup = replica.init()
    const startupOutcome = startup.then(() => undefined, error => error)
    const deadline = Date.now() + 5000
    for (;;) {
      const { rows } = await db.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS blocked`, [applicationName, writerPID])
      if (rows[0]!.blocked) break
      if (Date.now() > deadline) throw new Error('Replica did not reach the live upload quota lock')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    release()
    expect(await uploadOutcome).toBeUndefined()
    expect(await startupOutcome).toBeUndefined()
    expect((await db.query(`SELECT sum(bytes)::text AS bytes FROM platform_storage_charges WHERE realm=$1 AND released_at IS NULL`, [realm])).rows[0].bytes).toBe('10')
    expect(await writer.getLibraryFile(current.docId, realm)).toBeDefined()
  } finally {
    release()
    await Promise.allSettled([upload, startup].filter((pending): pending is Promise<void> => pending !== undefined))
    pool.connect = connect
    await db.query(`DELETE FROM knowledge_library_files WHERE realm=$1`, [realm])
    await db.query(`DELETE FROM platform_storage_charges WHERE realm=$1`, [realm])
    await db.query(`DELETE FROM platform_storage_limits WHERE realm=$1`, [realm])
    await db.end()
    await Promise.all([writer.close(), replica.close()])
  }
}, 15000)
