import { describe,expect,it } from 'vitest'
import { contentDigest,isManagedContentKey,managedContentKey,parseManagedContentKey } from '../../../shared/seam-contracts/managed-content.ts'
import { MinioObjectStore } from '../src/minio-store.ts'
import { PgManagedContentStore } from '../src/managed-content.ts'

const id='11111111-2222-4333-8444-555555555555'
describe('managed content namespace boundary',()=>{
  it('uses an isolated immutable upload identity and rejects cross-realm parsing',()=>{
    const digest=contentDigest('same bytes'),key=managedContentKey('realm',id,digest)
    expect(key).toBe(`realm/managed-content/v1/${id}/${digest}`)
    expect(parseManagedContentKey('realm',key)).toEqual({objectId:id,sha256:digest,relativeKey:key.slice(6)})
    expect(parseManagedContentKey('other',key)).toBeUndefined()
    expect(parseManagedContentKey('realm',`realm/content/${digest}`)).toBeUndefined()
    expect(()=>managedContentKey('../realm',id,digest)).toThrow()
    expect(()=>managedContentKey('realm','../unsafe',digest)).toThrow()
    expect(isManagedContentKey(key)).toBe(true)
  })
  it('does not permit generic object writes or deletes inside the managed namespace',async()=>{
    const store=new MinioObjectStore({endPoint:'127.0.0.1',port:1,accessKey:'x',secretKey:'y',bucket:'test'})
    await expect(store.put('r',`managed-content/v1/${id}/${contentDigest('x')}`,'x')).rejects.toMatchObject({code:'invalid'})
    await expect(store.delete('r',`managed-content/v1/${id}/${contentDigest('x')}`)).rejects.toMatchObject({code:'invalid'})
    expect(store.managedContent).toBeUndefined()
  })
  it('rejects invalid storage identity, destructive switches and durations before connecting',()=>{
    const backend={put:async()=>{},delete:async()=>{}}
    for(const config of [{connectionString:'x',storageId:''},{connectionString:'x',storageId:'s',deleteEnabled:'true'},
      {connectionString:'x',storageId:'s',retentionMs:-1},{connectionString:'x',storageId:'s',ioTimeoutMs:0}]) {
      expect(()=>new PgManagedContentStore(config as never,backend)).toThrow()
    }
  })
})
