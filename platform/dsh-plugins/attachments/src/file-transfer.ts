/** Bounded transient spooling. MinIO remains the durable source; no filesystem
 * path is returned to a caller or made available to Agent tools. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp,open,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentError,AttachmentId,type FileAttachmentRef,type SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'
import { joinRealmKey } from '../../../shared/seam-contracts/object-store.ts'

export function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void work.catch(()=>{});return Promise.reject(signal.reason)}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason)
    signal.addEventListener('abort',abort,{once:true})
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
  })
}
export async function* chunks(source:AsyncIterable<Uint8Array>,signal:AbortSignal):AsyncIterable<Uint8Array>{
  const iterator=source[Symbol.asyncIterator]()
  try{while(true){const item=await bounded(iterator.next(),signal);if(item.done)return;if(!(item.value instanceof Uint8Array))throw new AttachmentError('Attachment stream must contain bytes.','ATTACHMENT_WRITE_FAILED');yield item.value}}
  finally{try{void Promise.resolve(iterator.return?.()).catch(()=>{})}catch{/* caller-owned iterator cleanup must not replace the transfer error */}}
}
export function fileName(value:string|undefined):string{
  if(value!==undefined&&typeof value!=='string')throw new AttachmentError('Attachment filename is invalid.','INVALID_ATTACHMENT_REF')
  const name=(value??'attachment').split(/[\\/]/u).at(-1)!.replace(/[\u0000-\u001f\u007f]/gu,'').trim().slice(0,200)
  return name&&name!=='.'&&name!=='..'?name:'attachment'
}
export function fileIdentity(realm:string,ref:FileAttachmentRef,maxBytes:number):string{
  const prefix=`${realm}/file-content/`,id=String(ref.attachmentId)
  const sha=id.startsWith(prefix)?id.slice(prefix.length):''
  if(!/^[a-f0-9]{64}$/u.test(sha)||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>maxBytes||typeof ref.name!=='string'||fileName(ref.name)!==ref.name)throw new AttachmentError('Attachment reference is invalid for this Realm.','INVALID_ATTACHMENT_REF')
  return sha
}
export async function saveFile(objectStore:ObjectStoreSeam,realm:string,input:SaveFileStreamAttachment,maxBytes:number,signal:AbortSignal):Promise<FileAttachmentRef>{
  signal.throwIfAborted()
  if(!objectStore.putStream)throw new AttachmentError('The object provider cannot stream files.','ATTACHMENT_FILES_UNSUPPORTED')
  const name=fileName(input.name),directory=await mkdtemp(join(tmpdir(),'lumo-file-')),path=join(directory,'upload')
  try{
    const hash=createHash('sha256');let bytes=0
    const handle=await open(path,'wx',0o600)
    try{
      for await(const chunk of chunks(input.data,signal)){
        bytes+=chunk.byteLength
        if(bytes>maxBytes)throw new AttachmentError('Attachment exceeds the configured file-byte limit.','ATTACHMENT_WRITE_FAILED')
        hash.update(chunk)
        for(let offset=0;offset<chunk.byteLength;){signal.throwIfAborted();const written=await handle.write(chunk,offset,Math.min(64*1024,chunk.byteLength-offset));offset+=written.bytesWritten}
      }
    }finally{await handle.close()}
    const sha=hash.digest('hex'),key=`file-content/${sha}`
    const source=createReadStream(path,{highWaterMark:64*1024,signal})
    source.on('error',()=>{})
    try{await bounded(objectStore.putStream(realm,key,source,bytes,'application/octet-stream',signal),signal)}finally{source.destroy()}
    signal.throwIfAborted()
    return {attachmentId:AttachmentId(joinRealmKey(realm,key)),bytes,name}
  }finally{await rm(directory,{recursive:true,force:true})}
}
export async function* readFile(objectStore:ObjectStoreSeam,realm:string,ref:FileAttachmentRef,maxBytes:number,signal:AbortSignal):AsyncIterable<Uint8Array>{
  const sha=fileIdentity(realm,ref,maxBytes)
  signal.throwIfAborted()
  if(!objectStore.getStream)throw new AttachmentError('The object provider cannot stream files.','ATTACHMENT_FILES_UNSUPPORTED')
  const stored=await bounded(objectStore.getStream(realm,`file-content/${sha}`,signal),signal)
  if(!stored)throw new AttachmentError('Attachment object is missing.','ATTACHMENT_NOT_FOUND')
  if(stored.bytes!==ref.bytes||stored.bytes>maxBytes)throw new AttachmentError('Attachment byte length differs from its reference.','ATTACHMENT_CORRUPT')
  const hash=createHash('sha256');let bytes=0
  for await(const chunk of chunks(stored.body,signal)){
    bytes+=chunk.byteLength
    if(bytes>ref.bytes||bytes>maxBytes)throw new AttachmentError('Attachment exceeds its verified size.','ATTACHMENT_CORRUPT')
    hash.update(chunk);yield chunk
  }
  if(bytes!==ref.bytes||hash.digest('hex')!==sha)throw new AttachmentError('Stored attachment failed integrity verification.','ATTACHMENT_CORRUPT')
}
