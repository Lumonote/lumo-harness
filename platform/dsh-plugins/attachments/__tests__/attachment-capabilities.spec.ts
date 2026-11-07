import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { MinioAttachmentStore } from '../src/minio-attachment-store.ts'
import { objectStore, testEnabled, tinyPng, uniqueRealm } from './minio-helper.ts'

const live = testEnabled() ? it : it.skip
function provider(realm:string, maxFileBytes?:number) {
  const ctx = new Context()
  ctx.provide('objectStore', objectStore())
  return new MinioAttachmentStore(ctx, { realm, maxFileBytes })
}
async function read(source:AsyncIterable<Uint8Array>):Promise<Buffer> {
  const parts:Buffer[]=[]
  for await (const chunk of source) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts)
}
const bytes = (body:Uint8Array) => (async function*(){ yield body })()

describe(`remote attachment capabilities (real MinIO ${testEnabled()?'configured':'not configured: skipped'})`, () => {
  live('persists empty/binary files and reads the same opaque reference on another provider', async () => {
    const realm=uniqueRealm(), first=provider(realm), reopened=provider(realm)
    const data=Buffer.from([0,255,3,0,13,10]), ref=await first.saveFile({data,name:'../../notes.bin'})
    expect(ref.name).toBe('notes.bin')
    expect(String(ref.attachmentId)).toBe(`${realm}/file-content/${createHash('sha256').update(data).digest('hex')}`)
    expect(await read(reopened.readFileStream(ref))).toEqual(data)
    expect(first.fileHostPath(ref)).toBeUndefined()
    const empty=await first.saveFile({data:Buffer.alloc(0)})
    expect(empty.bytes).toBe(0)
    expect(await read(reopened.readFileStream(empty))).toEqual(Buffer.alloc(0))
    await expect(read(provider(uniqueRealm()).readFileStream(ref))).rejects.toMatchObject({code:'INVALID_ATTACHMENT_REF'})
  })

  live('uploads a true multipart stream and verifies the complete streamed result without buffering it', async () => {
    const realm=uniqueRealm(), first=provider(realm), expected=createHash('sha256')
    const size=9*1024*1024+17, chunk=Buffer.alloc(64*1024,0xa5)
    const ref=await first.saveFileStream({name:'multipart.bin',data:(async function*(){
      for(let offset=0;offset<size;offset+=chunk.length){const next=chunk.subarray(0,Math.min(chunk.length,size-offset));expected.update(next);yield next}
    })()})
    expect(ref.bytes).toBe(size)
    const actual=createHash('sha256');let count=0
    for await (const part of provider(realm).readFileStream(ref)) {count+=part.byteLength;actual.update(part)}
    expect(count).toBe(size)
    expect(actual.digest('hex')).toBe(expected.digest('hex'))
  },30_000)

  live('fails closed for file limits, cancellation, missing objects and same-length corruption', async () => {
    const realm=uniqueRealm(), first=provider(realm,4)
    await expect(first.saveFile({data:Buffer.from('12345')})).rejects.toMatchObject({code:'ATTACHMENT_WRITE_FAILED'})
    await expect(first.saveFileStream({data:bytes(Buffer.from('ok')),signal:AbortSignal.abort(new Error('cancelled'))})).rejects.toThrow('cancelled')
    const missing:FileAttachmentRef={attachmentId:AttachmentId(`${realm}/file-content/${'0'.repeat(64)}`),name:'missing',bytes:0}
    await expect(read(first.readFileStream(missing))).rejects.toMatchObject({code:'ATTACHMENT_NOT_FOUND'})
    const ref=await first.saveFile({data:Buffer.from('good')})
    await expect(read(first.readFileStream({...ref,bytes:3}))).rejects.toMatchObject({code:'ATTACHMENT_CORRUPT'})
    const key=String(ref.attachmentId).slice(realm.length+1)
    await objectStore().put(realm,key,Buffer.from('evil'))
    await expect(read(first.readFileStream(ref))).rejects.toMatchObject({code:'ATTACHMENT_CORRUPT'})
  })

  live('validates stream sizes including the SDK zero-size shortcut and protects managed keys', async () => {
    const io=objectStore(),realm=uniqueRealm()
    for (const [size,data] of [[0,'x'],[1,''],[1,'xx']] as const) {
      const key=`stream-invalid-${size}-${data.length}`
      await expect(io.putStream(realm,key,bytes(Buffer.from(data)),size)).rejects.toThrow()
      expect(await io.stat(realm,key)).toBeUndefined()
    }
    await expect(io.putStream(realm,`managed-content/v1/x/${'0'.repeat(64)}`,bytes(Buffer.from('x')),1)).rejects.toThrow('durable lifecycle')
  })

  live('rejects forged image dimensions/media and foreign Realm references', async () => {
    const realm=uniqueRealm(),first=provider(realm),ref=await first.saveImage({data:await tinyPng(),mediaType:'image/png'})
    await expect(first.readImage({...ref,width:ref.width+1})).rejects.toMatchObject({code:'ATTACHMENT_CORRUPT'})
    await expect(first.readImage({...ref,mediaType:'image/jpeg'})).rejects.toMatchObject({code:'ATTACHMENT_CORRUPT'})
    await expect(provider(uniqueRealm()).readImage(ref)).rejects.toMatchObject({code:'INVALID_ATTACHMENT_REF'})
  })

  live('uses upstream request-image policies and stable variants across instances without granting host paths', async () => {
    const realm=uniqueRealm(),first=provider(realm)
    const source=await sharp({create:{width:64,height:32,channels:4,background:{r:12,g:34,b:56,alpha:0.5}}}).toColourspace('rgb16').png().toBuffer()
    const ref=await first.saveImage({data:source,mediaType:'image/png'})
    const target={width:22,height:11,maxBytes:4096},version=await first.readImageRequest(ref,target)
    expect(version.attachment).toEqual(ref)
    expect(version.width*version.height).toBeLessThanOrEqual(target.width*target.height)
    expect(version.bytes).toBe(version.data.byteLength)
    expect(version.bytes).toBeLessThanOrEqual(target.maxBytes)
    expect(version).toMatchObject({depth:'uchar',space:'srgb',hasAlpha:true})
    expect(await sharp(version.data).metadata()).toMatchObject({depth:'uchar',space:'srgb',hasAlpha:true})
    const again=await provider(realm).readImageRequest(ref,target)
    expect(again).toEqual(version)
    const smaller=await first.readImageRequest(ref,{width:8,height:4,maxBytes:4096})
    expect(String(smaller.variantId)).not.toBe(String(version.variantId))
    expect(smaller.width*smaller.height).toBeLessThanOrEqual(32)
    expect(first.imageHostPath(ref)).toBeUndefined()
    await expect(first.readImageRequest(ref,{width:0,height:4,maxBytes:100})).rejects.toMatchObject({code:'INVALID_ATTACHMENT_REF'})
    await expect(first.readImageRequest(ref,target,AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
  })
})
