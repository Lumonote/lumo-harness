import { randomUUID } from 'node:crypto'
import pg from 'pg'
import * as Minio from 'minio'
import { afterEach,describe,expect,it } from 'vitest'
import { PgManagedContentStore,type ManagedContentBackend,type ManagedContentConfig } from '../src/managed-content.ts'
import { MinioObjectStore } from '../src/minio-store.ts'
import { PgKnowledgeProvider } from '../../knowledge/src/pg-provider.ts'
import { schemaDsn } from '../../knowledge/__tests__/pg-schema.ts'
import { pinManagedContent,releaseManagedContent } from '../../../shared/managed-content.ts'
import { contentDigest,parseManagedContentKey,type ManagedContentReceipt } from '../../../shared/seam-contracts/managed-content.ts'
import { joinRealmKey } from '../../../shared/seam-contracts/object-store.ts'
import { minioOptions,testEnabled,uniqueRealm } from './minio-helper.ts'

const DSN=process.env['LUMO_TEST_PG_DSN']??process.env['KNOWLEDGE_TEST_DSN']
const live=DSN&&testEnabled()?it:it.skip
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(config:Partial<ManagedContentConfig>={}) {
  const connectionString=await schemaDsn(DSN!,'managed_content_lifecycle_test')
  const options=minioOptions(),realm=uniqueRealm()
  const objects=new MinioObjectStore(options);await objects.init()
  const minio=new Minio.Client(options)
  const backend:ManagedContentBackend={
    put:async(r,key,body,contentType)=>{await minio.putObject(options.bucket,joinRealmKey(r,key),body,body.length,contentType?{'Content-Type':contentType}:undefined)},
    delete:async(r,key)=>{await minio.removeObject(options.bucket,joinRealmKey(r,key))},
  }
  const settings={connectionString,storageId:`test:${options.bucket}`,retentionMs:0,graceMs:0,...config}
  const lifecycle=new PgManagedContentStore(settings,backend);cleanup.push(()=>lifecycle.close());await lifecycle.init()
  const db=new pg.Pool({connectionString});cleanup.push(()=>db.end())
  const knowledge=new PgKnowledgeProvider({connectionString,allowedRoles:['viewer'],embeddingModel:'test',embedding:{dimension:3,embed:async texts=>texts.map(()=>[0.1,0.2,0.3])}})
  cleanup.push(()=>knowledge.close());await knowledge.init()
  const reference=()=>({realm,kind:'knowledge-file' as const,referenceId:`file-${randomUUID()}`})
  const put=async(text='content')=>{const ref=reference();return lifecycle.put(ref,text,'text/plain')}
  const file=(receipt:ManagedContentReceipt,docId=receipt.referenceId)=>({docId,realm,folderId:null,filename:'Example.txt',mimeType:'text/plain',objectKey:receipt.objectKey,
    byteSize:receipt.byteSize,sha256:receipt.sha256,ownerUserId:'alice',extractionState:'ready' as const,ocrState:'not_needed' as const,createdAt:new Date().toISOString()})
  const remove=async(receipt:ManagedContentReceipt,docId=receipt.referenceId)=>knowledge.deleteLibraryFile({realm,docId,actorUserId:'alice',roles:['viewer'],isAdmin:false,expectedSha256:receipt.sha256,expectedRevision:1})
  const relative=(receipt:ManagedContentReceipt)=>parseManagedContentKey(realm,receipt.objectKey)!.relativeKey
  return {realm,objects,lifecycle,db,backend,settings,knowledge,reference,put,file,remove,relative,
    other:(override:Partial<ManagedContentConfig>={},io=backend)=>{const service=new PgManagedContentStore({...settings,...override},io);cleanup.push(()=>service.close());return service}}
}

describe('managed content lifecycle with real PostgreSQL and MinIO',()=>{
  live('pins knowledge files atomically, supports shared references and keeps physical deletion off by default',async()=>{
    const f=await fixture(),receipt=await f.put()
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
    await f.knowledge.createLibraryFile(f.file(receipt))
    const second=`file-${randomUUID()}`
    await f.knowledge.createLibraryFile(f.file(receipt,second))
    await f.remove(receipt)
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
    await f.remove(receipt,second)
    expect(await f.lifecycle.collect(f.realm)).toMatchObject({deletionEnabled:false,candidates:1,deleted:0})
    expect((await f.objects.get(f.realm,f.relative(receipt)))?.body.toString()).toBe('content')
    const gc=f.other({deleteEnabled:true})
    expect(await gc.collect(f.realm)).toMatchObject({candidates:1,deleted:1,failed:0})
    expect(await f.objects.get(f.realm,f.relative(receipt))).toBeUndefined()
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
    await expect(f.knowledge.createLibraryFile(f.file(receipt,`file-${randomUUID()}`))).rejects.toThrow('not ready')
  })
  live('retains legacy content and other backing stores while explicitly collecting abandoned managed uploads',async()=>{
    const f=await fixture(),legacy=await f.objects.putContent(f.realm,'legacy')
    const receipt=await f.put()
    await f.lifecycle.abandon(receipt)
    expect(await f.other({deleteEnabled:true,storageId:'different-bucket'}).collect(f.realm)).toMatchObject({candidates:0,deleted:0})
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({deleted:1})
    expect((await f.objects.get(f.realm,legacy.slice(f.realm.length+1)))?.body.toString()).toBe('legacy')
    expect(await f.objects.stat(f.realm,f.relative(receipt))).toBeUndefined()
  })
  live('uses stable idempotent reservations and rejects reuse with different bytes or after collection',async()=>{
    const f=await fixture(),ref=f.reference()
    const first=await f.lifecycle.put(ref,'same'),second=await f.lifecycle.put(ref,'same')
    expect(second).toEqual(first)
    await expect(f.lifecycle.put(ref,'different')).rejects.toThrow('different bytes')
    await f.lifecycle.abandon(ref)
    await f.other({deleteEnabled:true}).collect(f.realm)
    await expect(f.lifecycle.put(ref,'same')).rejects.toThrow('sealed')
    expect((await f.db.query('SELECT count(*)::int n FROM managed_content_objects WHERE realm=$1',[f.realm])).rows[0].n).toBe(1)
  })
  live('enforces both minimum retention and the last-release grace period',async()=>{
    const f=await fixture({retentionMs:60000,graceMs:60000}),receipt=await f.put()
    await f.lifecycle.abandon(receipt)
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
    await f.db.query(`UPDATE managed_content_objects SET retain_until=now()-interval '1 second' WHERE realm=$1`,[f.realm])
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
    await f.db.query(`UPDATE managed_content_objects SET collect_after=now()-interval '1 second' WHERE realm=$1`,[f.realm])
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({deleted:1})
  })
  live('keeps failed or timed-out external writes protected and requires a new upload identity',async()=>{
    const f=await fixture({ioTimeoutMs:100}),ref=f.reference()
    const failed=f.other({}, {...f.backend,put:async()=>{throw new Error('write failed')}})
    await expect(failed.put(ref,'bytes')).rejects.toThrow('write failed')
    expect(await failed.abandon(ref)).toBe(false)
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({candidates:0})
    await expect(f.lifecycle.put(ref,'bytes')).rejects.toThrow('pending')
    const receipt=await f.lifecycle.put(f.reference(),'bytes')
    expect((await f.objects.get(f.realm,f.relative(receipt)))?.body.toString()).toBe('bytes')
    let finish!:()=>void,completed!:()=>void
    const barrier=new Promise<void>(resolve=>{finish=resolve}),lateWritten=new Promise<void>(resolve=>{completed=resolve})
    const pending=f.reference(),hanging=f.other({}, {...f.backend,put:async(r,key,bytes,type)=>{await barrier;await f.backend.put(r,key,bytes,type);completed()}})
    try {await expect(hanging.put(pending,'pending')).rejects.toThrow('timed out')}
    finally {finish()}
    await lateWritten
    await expect(f.lifecycle.put(pending,'pending')).rejects.toThrow('pending')
    expect(await hanging.abandon(pending)).toBe(false)
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
  })
  live('a denied metadata transaction rolls back its pin and explicit compensation only releases the reservation',async()=>{
    const f=await fixture(),receipt=await f.put()
    await expect(f.knowledge.createLibraryFile({...f.file(receipt),folderId:'missing'},{roles:['viewer'],isAdmin:false})).rejects.toThrow('不存在')
    expect((await f.db.query('SELECT count(*)::int n FROM managed_content_references WHERE realm=$1',[f.realm])).rows[0].n).toBe(0)
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
    expect(await f.lifecycle.abandon(receipt)).toBe(true)
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({deleted:1})
  })
  live('does not compensate away a committed file pin after an ambiguous caller outcome',async()=>{
    const f=await fixture(),receipt=await f.put()
    await f.knowledge.createLibraryFile(f.file(receipt))
    expect(await f.lifecycle.abandon(receipt)).toBe(false)
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({candidates:0})
    await f.knowledge.removeLibraryFile(receipt.referenceId,f.realm)
    expect(await f.lifecycle.candidates(f.realm)).toHaveLength(1)
    expect(await f.knowledge.getLibraryFile(receipt.referenceId,f.realm)).toBeUndefined()
    expect((await f.db.query('SELECT released_at FROM managed_content_references WHERE realm=$1',[f.realm])).rows[0].released_at).not.toBeNull()
  })
  live('a metadata delete rollback preserves its live pin and file',async()=>{
    const f=await fixture(),receipt=await f.put()
    await f.knowledge.createLibraryFile(f.file(receipt))
    await expect(f.remove({...receipt,sha256:'0'.repeat(64)})).rejects.toThrow('已变更')
    expect(await f.knowledge.getLibraryFile(receipt.referenceId,f.realm)).toBeDefined()
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({candidates:0})
  })
  live('serializes a pending pin with GC and rechecks zero references after the transaction commits',async()=>{
    const f=await fixture(),receipt=await f.put(),gc=f.other({deleteEnabled:true})
    await f.lifecycle.abandon(receipt)
    const tx=await f.db.connect()
    try {
      await tx.query('BEGIN')
      await pinManagedContent(tx,{realm:f.realm,kind:'knowledge-file',referenceId:'additional-reference',objectKey:receipt.objectKey,sha256:receipt.sha256,byteSize:receipt.byteSize})
      expect(await gc.collect(f.realm)).toMatchObject({candidates:1,deleted:0})
      await tx.query('COMMIT')
      expect(await gc.collect(f.realm)).toMatchObject({candidates:0})
      await tx.query('BEGIN')
      await releaseManagedContent(tx,{realm:f.realm,kind:'knowledge-file',referenceId:'additional-reference',objectKey:receipt.objectKey})
      await tx.query('COMMIT')
      expect(await gc.collect(f.realm)).toMatchObject({deleted:1})
    } finally {await tx.query('ROLLBACK');tx.release()}
  })
  live('durably fences pinning before MinIO deletion and retries ambiguous successful deletes without reviving the object',async()=>{
    const f=await fixture(),receipt=await f.put()
    await f.lifecycle.abandon(receipt)
    let reached!:()=>void,finish!:()=>void
    const started=new Promise<void>(resolve=>{reached=resolve}),barrier=new Promise<void>(resolve=>{finish=resolve})
    const gc=f.other({deleteEnabled:true},{...f.backend,delete:async(r,k)=>{reached();await barrier;await f.backend.delete(r,k);throw new Error('delete response lost')}})
    const collecting=gc.collect(f.realm)
    await started
    await expect(f.knowledge.createLibraryFile(f.file(receipt))).rejects.toThrow('not ready')
    expect((await f.db.query('SELECT state FROM managed_content_objects WHERE realm=$1',[f.realm])).rows[0].state).toBe('deleting')
    finish()
    expect(await collecting).toMatchObject({failed:1,deleted:0})
    expect(await f.objects.get(f.realm,f.relative(receipt))).toBeUndefined()
    await expect(f.lifecycle.put(receipt,'content')).rejects.toThrow('sealed')
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({deleted:1})
  })
  live('retains the deleting fence after storage failure and allows only idempotent GC retries',async()=>{
    const f=await fixture(),receipt=await f.put()
    await f.lifecycle.abandon(receipt)
    expect(await f.other({deleteEnabled:true},{...f.backend,delete:async()=>{throw new Error('offline')}}).collect(f.realm)).toMatchObject({failed:1})
    expect((await f.objects.get(f.realm,f.relative(receipt)))?.body.toString()).toBe('content')
    await expect(f.knowledge.createLibraryFile(f.file(receipt))).rejects.toThrow('not ready')
    expect(await f.other({deleteEnabled:true}).collect(f.realm)).toMatchObject({deleted:1})
  })
  live('rejects cross-realm or mismatched digest/size pins and never releases another object',async()=>{
    const f=await fixture(),receipt=await f.put()
    for(const changed of [{realm:'other'},{sha256:contentDigest('forged')},{byteSize:999}]) await expect(f.knowledge.createLibraryFile({...f.file(receipt),...changed})).rejects.toThrow()
    const tx=await f.db.connect()
    try {
      await tx.query('BEGIN')
      await expect(releaseManagedContent(tx,{realm:f.realm,kind:'knowledge-file',referenceId:'missing',objectKey:receipt.objectKey})).rejects.toThrow('missing')
      await tx.query('ROLLBACK')
    }finally{tx.release()}
    expect(await f.lifecycle.candidates(f.realm)).toEqual([])
  })
})
