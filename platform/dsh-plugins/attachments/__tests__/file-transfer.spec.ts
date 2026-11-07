import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createHash } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { MinioAttachmentStore } from '../src/minio-attachment-store.ts'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'

function fixture(options: {maxFileBytes?:number;maxConcurrentTransfers?:number;transferTimeoutMs?:number}={}){
  const objects=new Map<string,Buffer>(),ctx=new Context()
  const io={
    putStream:vi.fn(async(realm:string,key:string,body:AsyncIterable<Uint8Array>,size:number)=>{const parts:Buffer[]=[];for await(const part of body)parts.push(Buffer.from(part));const bytes=Buffer.concat(parts);expect(bytes.length).toBe(size);objects.set(`${realm}/${key}`,bytes)}),
    getStream:vi.fn(async(realm:string,key:string)=>{const body=objects.get(`${realm}/${key}`);return body===undefined?undefined:{bytes:body.length,body:(async function*(){for(let offset=0;offset<body.length;offset+=3)yield body.subarray(offset,offset+3)})()}}),
  }
  ctx.provide('objectStore',io as unknown as ObjectStoreSeam)
  const store=new MinioAttachmentStore(ctx,{realm:'a',...options})
  return {store,io,objects}
}
async function read(source:AsyncIterable<Uint8Array>){const parts:Buffer[]=[];for await(const part of source)parts.push(Buffer.from(part));return Buffer.concat(parts)}
describe('bounded file attachment transfer',()=>{
  it('streams exact bytes into a Realm-scoped opaque reference and verifies streamed reads',async()=>{
    const f=fixture(),body=Buffer.from([0,255,1,8,0,13]),ref=await f.store.saveFileStream({name:'C:\\private\\file.bin',data:(async function*(){yield body.subarray(0,2);yield body.subarray(2)})()})
    expect(ref).toEqual({attachmentId:`a/file-content/${createHash('sha256').update(body).digest('hex')}`,name:'file.bin',bytes:body.length})
    expect(await read(f.store.readFileStream(ref))).toEqual(body)
    expect(f.store.fileHostPath(ref)).toBeUndefined()
    const empty=await f.store.saveFile({data:Buffer.alloc(0)})
    expect(await read(f.store.readFileStream(empty))).toEqual(Buffer.alloc(0))
  })
  it('rejects oversize/cancelled/stalled uploads without publishing a reference and bounds capacity',async()=>{
    const f=fixture({maxFileBytes:3,transferTimeoutMs:100,maxConcurrentTransfers:1})
    await expect(f.store.saveFile({data:Buffer.from('1234')})).rejects.toMatchObject({code:'ATTACHMENT_WRITE_FAILED'})
    expect(f.io.putStream).not.toHaveBeenCalled()
    const signal=AbortSignal.abort(new Error('cancelled'))
    await expect(f.store.saveFileStream({data:(async function*(){yield Buffer.from('x')})(),signal})).rejects.toThrow('cancelled')
    let entered!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve})
    const pending=f.store.saveFileStream({data:{[Symbol.asyncIterator]:()=>({next:()=>{entered();return new Promise(()=>{})}})}})
    await started
    await expect(f.store.saveFile({data:Buffer.from('x')})).rejects.toThrow('capacity')
    await expect(f.store.validateImage({data:Buffer.from('x'),mediaType:'image/png'})).rejects.toThrow('capacity')
    await expect(pending).rejects.toThrow()
    expect(f.io.putStream).not.toHaveBeenCalled()
    expect((await f.store.saveFile({data:Buffer.from('ok')})).bytes).toBe(2)
  })
  it('rejects foreign Realm/file identities before I/O and detects same-length corrupt bytes',async()=>{
    const f=fixture(),ref=await f.store.saveFile({data:Buffer.from('right')})
    await expect(read(f.store.readFileStream({...ref,attachmentId:AttachmentId(String(ref.attachmentId).replace(/^a\//u,'b/'))}))).rejects.toMatchObject({code:'INVALID_ATTACHMENT_REF'})
    expect(f.io.getStream).not.toHaveBeenCalled()
    f.objects.set(String(ref.attachmentId),Buffer.from('wrong'))
    await expect(read(f.store.readFileStream(ref))).rejects.toMatchObject({code:'ATTACHMENT_CORRUPT'})
    f.io.getStream.mockClear()
    await expect(f.store.readImage({attachmentId:AttachmentId(`b/content/${'0'.repeat(64)}`),bytes:0,width:1,height:1,mediaType:'image/png'})).rejects.toMatchObject({code:'INVALID_ATTACHMENT_REF'})
    expect(f.io.getStream).not.toHaveBeenCalled()
  })
  it('rejects invalid deployment limits before any attachment I/O',()=>{
    for(const value of [0,-1,1.5,NaN,Infinity]){
      expect(()=>fixture({maxFileBytes:value})).toThrow('Invalid attachment limit')
      expect(()=>fixture({maxConcurrentTransfers:value})).toThrow('Invalid attachment limit')
      expect(()=>fixture({transferTimeoutMs:value})).toThrow('Invalid attachment limit')
    }
    const ctx=new Context();ctx.provide('objectStore',{} as ObjectStoreSeam)
    expect(()=>new MinioAttachmentStore(ctx,{realm:'a',normalizedImageMaxBytes:NaN})).toThrow('Invalid attachment limit')
  })
})
