import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { boundedJSON, type SessionExecutionRuntime } from '../../../shared/session-execution.ts'
import { SESSION_ATTACHMENT_MAX_BYTES, sessionAttachmentID, type SessionAttachmentConfig, type SessionAttachmentReceipt, type SessionAttachmentUpload, type SessionAttachmentDownload } from '../../../shared/seam-contracts/session-attachments.ts'
import type { Principal } from './client.ts'

export const USER_SESSION_ATTACHMENT_TOOL = 'user_attachment_read'
const textTypes = new Set(['text/plain','text/markdown','text/csv','application/json'])
const imageTypes = new Set(['image/png','image/jpeg','image/webp','image/gif'])
interface StoredReceipt extends SessionAttachmentReceipt { native_ref: FileAttachmentRef | ImageAttachmentRef }
export function validateSessionAttachments(value: unknown, realm?: string): asserts value is SessionAttachmentConfig | undefined {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session attachments require explicit configuration')
  const c=value as Record<string,unknown>
  if(Object.keys(c).some(k=>!['realm','maxUploadBytes','maxTextBytes','maxPerMessage'].includes(k))||typeof c.realm!=='string'||!c.realm.trim()||realm!==undefined&&c.realm!==realm)throw new Error('Session attachments must pin the deployment realm')
  for(const [key,max] of [['maxUploadBytes',SESSION_ATTACHMENT_MAX_BYTES],['maxTextBytes',1024*1024],['maxPerMessage',4]] as const)if(c[key]!==undefined&&(!Number.isSafeInteger(c[key])||Number(c[key])<1||Number(c[key])>max))throw new Error('Session attachment limits exceed the bounded profile')
  if(Number(c.maxTextBytes??1024*1024)>Number(c.maxUploadBytes??SESSION_ATTACHMENT_MAX_BYTES))throw new Error('Text limit exceeds upload limit')
}
export function attachmentName(value: unknown): string {
  if(typeof value!=='string'||!value.trim()||value.length>1000)throw new Error('Attachment filename is required')
  const leaf=value.split(/[\\/]/u).at(-1)!.replace(/[\p{Cc}\p{Cf}]/gu,'').trim()
  let name='',bytes=0,count=0
  // Match the receipt store's byte bound without cutting a Unicode scalar.
  for(const character of leaf){
    const scalar=character.codePointAt(0)!
    if(scalar>=0xd800&&scalar<=0xdfff)throw new Error('Invalid attachment filename')
    const size=Buffer.byteLength(character,'utf8')
    if(count>=100||bytes+size>200)break
    name+=character;bytes+=size;count++
  }
  if(!name||name==='.'||name==='..'||name.includes('[lumo-attachment:'))throw new Error('Invalid attachment filename')
  return name
}
export function attachmentMediaType(value: unknown): string {
  if(typeof value!=='string')throw new Error('An explicit supported attachment media type is required')
  const mime=value.toLowerCase()
  if(!textTypes.has(mime)&&!imageTypes.has(mime))throw new Error('Only UTF-8 plain text, Markdown, CSV, JSON and PNG/JPEG/WebP/GIF are supported')
  return mime
}
export async function attachmentBytes(source: AsyncIterable<Uint8Array>, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[]=[];let size=0
  const iterator=source[Symbol.asyncIterator]()
  try{for(;;){signal.throwIfAborted();const next=await abortable(Promise.resolve(iterator.next()),signal);if(next.done)break;if(!(next.value instanceof Uint8Array))throw new Error('Binary attachment required');size+=next.value.length;if(size>max)throw new Error('Attachment exceeds the upload byte limit');chunks.push(next.value)}signal.throwIfAborted();if(size===0)throw new Error('Empty attachment is not supported');return Buffer.concat(chunks)}
  finally{void iterator.return?.().catch(()=>{})}
}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{if(signal.aborted){void promise.catch(()=>{});return Promise.reject(signal.reason)}return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))})}
export function attachmentText(bytes:Uint8Array):string{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.length||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text))throw new Error('Attachment must contain safe UTF-8 text');return text}
function publicReceipt(r:StoredReceipt):SessionAttachmentReceipt{return {receipt_id:r.receipt_id,kind:r.kind,name:r.name,media_type:r.media_type,bytes:r.bytes,sha256:r.sha256,created_at:r.created_at}}
export function parsePublicAttachmentReceipt(value:unknown):SessionAttachmentReceipt {
 const r=value as SessionAttachmentReceipt
 if(!r||typeof r!=='object'||Array.isArray(r)||!sessionAttachmentID.test(r.receipt_id)||!['text','image'].includes(r.kind)||typeof r.name!=='string'||attachmentName(r.name)!==r.name||typeof r.media_type!=='string'||attachmentMediaType(r.media_type)!==r.media_type||r.kind==='text'&&r.media_type!=='text/plain'||r.kind==='image'&&!imageTypes.has(r.media_type)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>SESSION_ATTACHMENT_MAX_BYTES||!/^[a-f0-9]{64}$/u.test(r.sha256)||typeof r.created_at!=='string'||!Number.isFinite(Date.parse(r.created_at)))throw new Error('Invalid public attachment receipt')
 return {receipt_id:r.receipt_id,kind:r.kind,name:r.name,media_type:r.media_type,bytes:r.bytes,sha256:r.sha256,created_at:r.created_at}
}
function receipt(value:unknown):StoredReceipt{
  const r=value as StoredReceipt
  if(!r||!sessionAttachmentID.test(r.receipt_id)||!['text','image'].includes(r.kind)||typeof r.name!=='string'||typeof r.media_type!=='string'||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>SESSION_ATTACHMENT_MAX_BYTES||!/^[a-f0-9]{64}$/u.test(r.sha256)||!r.native_ref||r.native_ref.bytes!==r.bytes||typeof r.native_ref.attachmentId!=='string')throw new Error('Invalid persistent attachment receipt')
  return r
}
export function attachmentReferences(events:readonly SessionEvent[]):string[]{
 const ids=new Set<string>()
 for(const event of events){if(event.type!=='user/message')continue;for(const part of event.data.content){if(part.type!=='text')continue;for(const m of part.text.matchAll(/\[lumo-attachment:(att_[a-f0-9]{48})\]/gu))ids.add(m[1]!)}}
 return [...ids]
}
/** Bytes are immutable in AttachmentStore; PG receipts supply the mutable
 * ownership boundary. Neither object IDs nor URLs are accepted from callers. */
export class OwnedSessionAttachments {
 private transfers=0
 constructor(private store:AttachmentStore,private config:SessionAttachmentConfig,private runtime:SessionExecutionRuntime,private authorityURL:string,private token:string,private fetcher:typeof fetch=globalThis.fetch){validateSessionAttachments(config,runtime.realm)}
 private async call(principal:Principal,ref:string,operation:string,fields:Record<string,unknown>={}):Promise<StoredReceipt[]>{
  const proof=await this.runtime.proof(ref)
  const response=await this.fetcher(this.authorityURL.replace(/\/+$/u,'')+'/v1/session-attachments/'+encodeURIComponent(ref),{method:'POST',redirect:'error',signal:AbortSignal.any([this.runtime.signal,AbortSignal.timeout(5000)]),headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify({...proof,owner_user_id:principal.user_id,operation,...fields})})
  if(!response.ok){await response.body?.cancel();throw new Error('Attachment ownership or execution lease is unavailable')}
  const value=await boundedJSON(response,256*1024);if(!Array.isArray(value.receipts)||value.receipts.length>100)throw new Error('Invalid attachment authority response');return value.receipts.map(receipt)
 }
 async get(principal:Principal,ref:string,id:unknown):Promise<StoredReceipt>{if(!sessionAttachmentID.test(String(id)))throw new Error('A server attachment receipt is required');const rows=await this.call(principal,ref,'get',{receipt_id:id});if(rows.length!==1)throw new Error('Attachment receipt unavailable');return rows[0]!}
 async upload(principal:Principal,ref:string,metadata:SessionAttachmentUpload,source:AsyncIterable<Uint8Array>,signal:AbortSignal,authorize:()=>Promise<void>):Promise<SessionAttachmentReceipt>{
  if(this.transfers>=2)throw new Error('Attachment transfer capacity reached');this.transfers++
  const active=AbortSignal.any([signal,this.runtime.signal,AbortSignal.timeout(30_000)])
  try{
   await authorize();const name=attachmentName(metadata.name),mime=attachmentMediaType(metadata.mediaType)
   const data=await attachmentBytes(source,Math.min(this.config.maxUploadBytes??SESSION_ATTACHMENT_MAX_BYTES,textTypes.has(mime)?this.config.maxTextBytes??1024*1024:SESSION_ATTACHMENT_MAX_BYTES),active)
   let native:FileAttachmentRef|ImageAttachmentRef
   if(textTypes.has(mime)){attachmentText(data);native=await abortable(this.store.saveFileStream({data:(async function*(){yield data})(),name,signal:active}),active)}
   else native=(await abortable(this.store.saveImages([{data,mediaType:mime as ImageMediaType,name}]),active))[0]!
   if(native.bytes>(this.config.maxUploadBytes??SESSION_ATTACHMENT_MAX_BYTES))throw new Error('Normalized image exceeds the attachment limit')
   await authorize();active.throwIfAborted()
   const rows=await this.call(principal,ref,'create',{receipt:{kind:textTypes.has(mime)?'text':'image',name:native.name??name,media_type:textTypes.has(mime)?'text/plain':(native as ImageAttachmentRef).mediaType,bytes:native.bytes,sha256:native.attachmentId.split('/').at(-1),native_ref:native}})
   await authorize();return publicReceipt(rows[0]!)
  }finally{this.transfers--}
 }
 async download(principal:Principal,ref:string,id:string,signal:AbortSignal,authorize:()=>Promise<void>):Promise<SessionAttachmentDownload>{
  if(this.transfers>=2)throw new Error('Attachment transfer capacity reached');this.transfers++
  const active=AbortSignal.any([signal,this.runtime.signal,AbortSignal.timeout(30_000)])
  try{await authorize();const r=await this.get(principal,ref,id);let data:Uint8Array
   if(r.kind==='image')data=(await abortable(this.store.readImage(r.native_ref as ImageAttachmentRef,active),active)).data
   else data=await attachmentBytes(this.store.readFileStream(r.native_ref as FileAttachmentRef,active),this.config.maxTextBytes??1024*1024,active)
   if(data.length!==r.bytes||createHash('sha256').update(data).digest('hex')!==r.sha256)throw new Error('Attachment integrity mismatch');if(r.kind==='text')attachmentText(data)
   await authorize();active.throwIfAborted();return {data,name:r.name,mediaType:r.media_type}
  }finally{this.transfers--}
 }
 async promote(principal:Principal,ref:string,content:unknown,signal:AbortSignal,authorize:()=>Promise<void>):Promise<unknown[]>{
  if(!Array.isArray(content)||content.length>32)throw new Error('A bounded text and receipt message is required')
  const result:unknown[]=[];const seen=new Set<string>()
  for(const value of content){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid message part');const part=value as Record<string,unknown>
   if(part.type==='text'&&typeof part.text==='string'&&!part.text.includes('[lumo-attachment:')&&Object.keys(part).every(k=>['type','text'].includes(k))){result.push({type:'text',text:part.text});continue}
   if(part.type!=='attachment'||typeof part.receipt_id!=='string'||Object.keys(part).some(k=>!['type','receipt_id'].includes(k))||seen.has(part.receipt_id)||seen.size>=(this.config.maxPerMessage??4))throw new Error('Message attachments require unique server receipts')
   seen.add(part.receipt_id);await authorize();const r=await this.get(principal,ref,part.receipt_id)
   result.push({type:'text',text:'\n[lumo-attachment:'+r.receipt_id+'] '+r.name+' ('+r.media_type+', '+r.bytes+' bytes)'+(r.kind==='text'?' — use user_attachment_read with this receipt_id to read the attached UTF-8 text.':'')+'\n'})
   if(r.kind==='image'){const binary=await this.download(principal,ref,r.receipt_id,signal,authorize);result.push({type:'image',mediaType:r.media_type,name:r.name,data:Buffer.from(binary.data).toString('base64')})}
  }
  await authorize();return result
 }
 async inherit(principal:Principal,ref:string,parent:string,events:readonly SessionEvent[]):Promise<void>{await this.call(principal,ref,'inherit',{source_session:parent,receipt_ids:attachmentReferences(events)})}
 install(agent:Agent,ref:string,currentPrincipal:()=>Promise<Principal>):void{
  agent.ctx.tools.register({name:USER_SESSION_ATTACHMENT_TOOL,description:'只读读取本会话已发送的 UTF-8 文本附件。仅接受消息中的服务器 receipt_id，分页返回。',parameters:{type:'object',additionalProperties:false,required:['receipt_id'],properties:{receipt_id:{type:'string',pattern:'^att_[a-f0-9]{48}$'},offset:{type:'integer',minimum:0,maximum:1048576},limit:{type:'integer',minimum:1,maximum:32000}}},output:{schema:{type:'object',required:['text','offset','next_offset','total_chars'],properties:{text:{type:'string'},offset:{type:'integer'},next_offset:{type:'integer'},total_chars:{type:'integer'}}},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async(args,exec)=>{
   if(exec.agent!==agent||!args||typeof args!=='object'||Array.isArray(args))throw new Error('Exact owned Session and receipt required');const input=args as Record<string,unknown>
   if(Object.keys(input).some(k=>!['receipt_id','offset','limit'].includes(k))||typeof input.receipt_id!=='string'||!sessionAttachmentID.test(input.receipt_id)||input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||Number(input.offset)<0||Number(input.offset)>1048576)||input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>32000))throw new Error('Invalid attachment text read')
   if(!attachmentReferences(agent.session.snapshotEvents()).includes(input.receipt_id))throw new Error('Attachment must be sent in this Session before model access')
   const principal=await currentPrincipal();const r=await this.get(principal,ref,input.receipt_id);if(r.kind!=='text')throw new Error('This tool reads only UTF-8 text; images use native image content')
   const binary=await this.download(principal,ref,r.receipt_id,exec.signal,async()=>{await currentPrincipal()});const text=attachmentText(binary.data),offset=Number(input.offset??0),limit=Number(input.limit??16000);if(offset>text.length)throw new Error('Offset exceeds attachment length');const end=Math.min(text.length,offset+limit);await currentPrincipal();return {text:text.slice(offset,end),offset,next_offset:end<text.length?end:-1,total_chars:text.length}
  }})
 }
}
