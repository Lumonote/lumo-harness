import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import * as JsonlPersistence from '../../../../deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import TypertRegistry from '../../../../deepseek-harness/packages/typert/registry/lib/index.js'
import RemoteAccess from '../../../../deepseek-harness/packages/api/remote-access/lib/index.js'
import Gateway from '../../../../deepseek-harness/packages/api/gateway/lib/index.js'
import { Peer } from '../../../../deepseek-harness/packages/client/connection/lib/index.js'
import Controller from '../../../../deepseek-harness/packages/api/session-controller/lib/index.js'
import QueryEngine from '../../../../deepseek-harness/packages/session-query/session-query/lib/index.js'
import { z } from '../../../../deepseek-harness/node_modules/zod/index.js'
import { SessionMeterRegistry } from '../../../shared/seam-contracts/meter-attribution.ts'
import type { SessionOwner } from '../../../shared/session-owners.ts'
import type { Principal } from '../src/client.ts'
import { createSessionTransport } from '../src/session-transport.ts'
import { attachmentBytes, attachmentMediaType, attachmentName, attachmentReferences, attachmentText, parsePublicAttachmentReceipt, USER_SESSION_ATTACHMENT_TOOL, validateSessionAttachments } from '../src/session-attachments.ts'
import { SESSION_ATTACHMENT_DOCUMENT_TYPES } from '../../../shared/seam-contracts/session-attachments.ts'

const closers:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close()})
const alice:Principal={realm:'r',user_id:'alice',username:'alice',display_name:'Alice',roles:['viewer'],session_expires_at:'2099-01-01'}
const signal=new AbortController().signal
const source=(value:string|Uint8Array)=>(async function*(){yield typeof value==='string'?Buffer.from(value):value})()
function wordDocument(text:string):Buffer {
 const script=String.raw`import io,sys,zipfile
from xml.sax.saxutils import escape
body=escape(sys.argv[1]);out=io.BytesIO()
with zipfile.ZipFile(out,'w') as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+body+'</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(out.getvalue())`
 const result=spawnSync(process.env['LUMO_PPT_PYTHON']||(process.platform==='win32'?'python':'python3'),['-I','-c',script,text],{timeout:5000,maxBuffer:2*1024*1024})
 if(result.error||result.status!==0)throw result.error??Error(result.stderr.toString())
 return result.stdout
}

async function storage(){
 const temp=await realpath(await mkdtemp(join(tmpdir(),'owned-attachments-')));closers.push(()=>rm(temp,{recursive:true,force:true}))
 return {temp,owners:new Map<string,SessionOwner>(),receipts:new Map<string,Record<string,unknown>>(),files:new Map<string,Uint8Array>(),reservations:0,uploads:0,inherited:[] as string[][]}
}
type Storage=Awaited<ReturnType<typeof storage>>
async function fixture(durable:Storage,enabled=true){
 const ctx=new Context();let alive=true;const dispose=async()=>{if(alive){alive=false;await ctx.fiber.dispose()}};closers.push(dispose)
 const requests:GenerateOptions[]=[];let revoked=false,projectRevoked=false,executionRevoked=false,nextCall:{name:string;args:object;before?:()=>void}|undefined,onRead:(()=>void)|undefined,beforeReceiptOperation:((operation:string)=>Promise<void>)|undefined,onSave:((ref:{attachmentId:string;name:string;bytes:number})=>void)|undefined
 const authority=Object.assign(async()=>{if(revoked)throw Error('revoked');return {...alice,roles:[...alice.roles]}},{credential:'login-secret'})
 const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{
  const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)):{}
  if(path.includes('/session-execution/nodes/'))return new Response(JSON.stringify({node:{...body,fence:1,expires_at:'2099-01-01'}}))
  if(path.includes('/session-execution/sessions/'))return executionRevoked?new Response('{}',{status:409}):new Response(JSON.stringify({lease:{...body,session_ref:path.split('/')[4],node_fence:1,fencing_token:1,expires_at:'2099-01-01'}}))
  if(path.startsWith('/v1/session-attachments/')){
   const ref=path.split('/')[3]!,owner=durable.owners.get(ref)
   if(!owner||owner.owner_user_id!==body.owner_user_id||owner.realm!==body.realm||owner.project_id!==body.project_id)return new Response('{}',{status:404})
   await beforeReceiptOperation?.(body.operation)
   if(body.operation==='list')return new Response(JSON.stringify({receipts:[...durable.receipts].filter(([key,r])=>key.startsWith(ref+':')&&!r.retired_at).map(([,r])=>r)}))
   if(body.operation==='retire'){const r=durable.receipts.get(ref+':'+body.receipt_id);if(!r)return new Response('{}',{status:404});r.retired_at??='2026-11-09T01:00:00Z';return new Response(JSON.stringify({receipts:[r]}))}
   if(body.operation==='create'){const r={...body.receipt,receipt_id:'att_'+String(++durable.uploads).padStart(48,'0'),created_at:'2026-11-07T00:00:00Z'};durable.receipts.set(ref+':'+r.receipt_id,r);return new Response(JSON.stringify({receipts:[r]}))}
   if(body.operation==='get'){const r=durable.receipts.get(ref+':'+body.receipt_id);return new Response(JSON.stringify({receipts:r?[r]:[]}),{status:r?200:404})}
   if(body.operation==='inherit'){durable.inherited.push(body.receipt_ids);for(const id of body.receipt_ids){const r=durable.receipts.get(body.source_session+':'+id);if(!r)return new Response('{}',{status:404});durable.receipts.set(ref+':'+id,r)};return new Response(JSON.stringify({receipts:body.receipt_ids.map((id:string)=>durable.receipts.get(ref+':'+id))}))}
  }
  if(path==='/v1/session-owners'){const owner:SessionOwner={...body,session_ref:'session-'+String(++durable.reservations).padStart(32,'0'),state:'reserved',created_at:'2026-11-07T00:00:00Z'};durable.owners.set(owner.session_ref,owner);return new Response(JSON.stringify({owner,creation_token:'c'.repeat(64)}))}
  const owner=durable.owners.get(path.split('/')[3]!)!;if(path.endsWith('/activate'))owner.state='active';return new Response(JSON.stringify({owner}))
 }
 await ctx.plugin(TypertRegistry);await mountAgentLoopTestDependencies(ctx,{workingDirectory:true});await ctx.plugin(JsonlPersistence,{root:join(durable.temp,'sessions'),compression:'none'});await ctx.plugin(AgentLoop,{agents:[]})
 ctx.llm.registerAdapter(['mock'],new(class extends LlmAdapter{override async*stream(options:GenerateOptions):AsyncIterable<StreamChunk>{requests.push(options);const call=nextCall;nextCall=undefined;if(call){call.before?.();const id=ToolCallId('read-'+requests.length),args=JSON.stringify(call.args);yield {type:'tool-call-delta',index:0,id,name:call.name,argumentsDelta:args};yield {type:'block-end',index:0,block:{type:'tool-call',id,name:call.name,arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}}}else{yield {type:'text-delta',index:0,text:'Answer'};yield {type:'finish',reason:{kind:'stop'}}}}})())
 await ctx.plugin(RemoteAccess);await ctx.plugin(Gateway)
 ctx.provide('connection',{createPeer:options=>new Peer(ctx,options)} as never);ctx.provide('meteringScope',new SessionMeterRegistry());ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'mock',model:'mock'}),saveSelection:async()=>{}} as never)
 const save=(data:Uint8Array,name:string,image=false)=>{const sha=createHash('sha256').update(data).digest('hex'),attachmentId='r/'+(image?'content':'file-content')+'/'+sha;durable.files.set(attachmentId,data);const ref={attachmentId,name,bytes:data.length,...(image?{mediaType:'image/png',width:1,height:1}:{})};onSave?.(ref);return ref}
 ctx.provide('attachments',{
  imageLimits:{maxImageBytes:8388608,maxImagesPerMessage:4,maxMessageImageBytes:33554432,maxImagePixels:1000,maxImageDimension:1000,mediaTypes:['image/png']},
  saveFileStream:async(input:{data:AsyncIterable<Uint8Array>;name:string;signal:AbortSignal})=>save(await attachmentBytes(input.data,1048576,input.signal),input.name),
  readFileStream:async function*(ref:{attachmentId:string}){onRead?.();yield durable.files.get(ref.attachmentId)!},
  saveImages:async(inputs:Array<{data:Uint8Array;name:string}>)=>inputs.map(input=>save(input.data,input.name,true)),
  readImage:async(ref:{attachmentId:string})=>({ref,data:durable.files.get(ref.attachmentId)!}),
  admitPromptContent:async(content:Array<Record<string,unknown>>)=>content.map(part=>part.type==='image'?{type:'image',attachment:save(Buffer.from(String(part.data),'base64'),String(part.name),true)}:part),
 } as never)
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},resolve:()=>undefined,bindPrompt:()=>({commit(){},[Symbol.dispose](){}}),retirePrompt(){}} as never);ctx.provide('workspaceRegistry',{archivedSessionIds:[],get:()=>undefined} as never)
 new QueryEngine(ctx);class TestController extends Controller{initialize(){return this[Service.init]()}};await new TestController(ctx,{nativeOpen:false}).initialize()
 const part=z.union([z.object({type:z.literal('text'),text:z.string()}),z.object({type:z.literal('image'),mediaType:z.string(),data:z.string(),name:z.string().optional()})]);const schema=z.object({sessionId:z.string(),requestId:z.string(),content:z.array(part),mode:z.literal('queue')})
 ctx.typert.register({package:'@lumo/owned-attachment-test',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:[{id:'@lumo/owned-attachment-test#session/prompt',service:'sessionController',namespace:'session',method:'prompt',invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'strict',typeSymbol:'@lumo/owned#Prompt',create:()=>schema}}],cancellation:{parameter:'signal'},result:{mode:'strict',typeSymbol:'@lumo/owned#Result',create:()=>z.object({accepted:z.literal(true)})}}]})
 const config={authorityUrl:'http://owner',nodeId:'n',projectId:'p',workspaceRoot:join(durable.temp,'workspaces'),provider:'mock',model:'mock',...(enabled?{attachments:{realm:'r'}}:{})}
 const transport=createSessionTransport(ctx,config,'service-secret',async()=>{if(revoked||projectRevoked)throw Error('revoked')},fetcher,{realm:'r',writerHolder:'writer',endpoint:''})
 const create=async()=>(await transport.execute(alice,'create',{},signal,authority) as {sessionId:string}).sessionId
 const upload=async(ref:string,text:string|Uint8Array,name='notes.txt',mime='text/plain')=>transport.uploadAttachment!(alice,ref,{name,mediaType:mime},source(text),signal,authority)
 let promptID=0
 const send=async(ref:string,content:unknown[],call?:{name:string;args:object;before?:()=>void})=>{nextCall=call;await transport.execute(alice,'prompt',{sessionId:ref,requestId:'prompt-'+(++promptID)+'-'+Date.now(),content,mode:'queue'},signal,authority);await ctx.agents.get(SessionId(ref))!.whenIdle();await ctx.sessionPersistence.flush()}
 return {ctx,transport,authority,create,upload,send,requests,dispose,onReceiptOperation:(cb:typeof beforeReceiptOperation)=>{beforeReceiptOperation=cb},revoke:()=>{revoked=true},revokeProject:()=>{projectRevoked=true},revokeExecution:()=>{executionRevoked=true},onRead:(cb:()=>void)=>{onRead=cb},onSave:(cb:typeof onSave)=>{onSave=cb},events:(id:string)=>ctx.agents.get(SessionId(id))!.session.snapshotEvents()}
}

describe('owned attachment receipt application with real AgentLoop and JSONL restart',()=>{
 it('retires future admission while retaining native history reads and inherited receipts after restart',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,'RETIRED-HISTORY')
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}])
  const retired=await f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority) as {receipt:{retired_at:string}}
  expect(retired.receipt.retired_at).toBeTruthy();expect(retired.receipt).not.toHaveProperty('native_ref')
  await expect(f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority)).resolves.toEqual(retired)
  await expect(f.transport.execute(alice,'attachmentList',{sessionId:id},signal,f.authority)).resolves.toEqual({receipts:[]})
  await expect(f.send(id,[{type:'attachment',receipt_id:r.receipt_id}])).rejects.toMatchObject({code:'session_attachment_retired'})
  expect(Buffer.from((await f.transport.readAttachment!(alice,id,r.receipt_id,signal,f.authority)).data).toString()).toBe('RETIRED-HISTORY')
  await f.dispose();const resumed=await fixture(d)
  await resumed.send(id,[{type:'text',text:'read retired history'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(resumed.events(id))).toContain('RETIRED-HISTORY')
  const fork=await resumed.transport.execute(alice,'fork',{sessionId:id},signal,resumed.authority) as {sessionId:string}
  expect(d.receipts.get(fork.sessionId+':'+r.receipt_id)).toHaveProperty('retired_at')
  await resumed.send(fork.sessionId,[{type:'text',text:'read inherited retired history'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(resumed.events(fork.sessionId))).toContain('RETIRED-HISTORY')
  await expect(resumed.send(fork.sessionId,[{type:'attachment',receipt_id:r.receipt_id}])).rejects.toMatchObject({code:'session_attachment_retired'})
 })
 it.each(['prompt','retireAttachment'] as const)('serializes attachment retirement with an in-flight %s and releases the admission guard',async action=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,'SERIAL')
  let entered!:()=>void,release!:()=>void
  const waiting=new Promise<void>(resolve=>{entered=resolve}),held=new Promise<void>(resolve=>{release=resolve})
  f.onReceiptOperation(async operation=>{if(operation===(action==='prompt'?'get':'retire')){entered();await held}})
  const pending=action==='prompt'?f.send(id,[{type:'attachment',receipt_id:r.receipt_id}]):f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority)
  try{await waiting
   const competing=action==='prompt'?f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority):f.send(id,[{type:'attachment',receipt_id:r.receipt_id}])
   await expect(competing).rejects.toMatchObject({code:'session_attachment_busy'})
  }finally{release();await pending;f.onReceiptOperation(undefined)}
  await expect(f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority)).resolves.toHaveProperty('receipt.retired_at')
 })
 it('refuses attachment management after owner/project revocation and validates exact fields',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,'SCOPED')
  await expect(f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id,url:'https://private'},signal,f.authority)).rejects.toMatchObject({code:'session_attachment_invalid'})
  await expect(f.transport.execute({...alice,user_id:'bob'},'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority)).rejects.toThrow('ownership')
  expect(d.receipts.get(id+':'+r.receipt_id)).not.toHaveProperty('retired_at')
  f.revokeProject()
  await expect(f.transport.execute(alice,'retireAttachment',{sessionId:id,receipt_id:r.receipt_id},signal,f.authority)).rejects.toThrow('revoked')
  expect(d.receipts.get(id+':'+r.receipt_id)).not.toHaveProperty('retired_at')
 })
 it('uses durable opaque receipts and restricts the read tool to submitted files',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,'PRIVATE-ALICE')
  expect(r).not.toHaveProperty('native_ref');expect(JSON.stringify(r)).not.toContain('file-content')
  await f.send(id,[{type:'text',text:'read a staged but unsent file'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(f.events(id))).not.toContain('PRIVATE-ALICE')
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id,offset:0,limit:7}})
  expect(JSON.stringify(f.events(id))).toContain('PRIVATE');expect(f.requests.at(-1)?.tools?.map(t=>t.name)).toEqual([USER_SESSION_ATTACHMENT_TOOL])
  const other=await f.create();await expect(f.send(other,[{type:'attachment',receipt_id:r.receipt_id}])).rejects.toThrow('ownership')
  await expect(f.transport.readAttachment!({...alice,user_id:'bob'},id,r.receipt_id,signal,f.authority)).rejects.toThrow('ownership')
 })
 it('restores text attachments after restart and copies only completed-prefix references on fork',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),sent=await f.upload(id,'SENT-PERSISTED'),unsent=await f.upload(id,'UNSENT-PRIVATE')
  await expect(f.upload(id,'malicious filename','notes[lumo-attachment:'+unsent.receipt_id+'].txt')).rejects.toThrow('filename')
  await f.send(id,[{type:'attachment',receipt_id:sent.receipt_id}]);await f.dispose()
  const resumed=await fixture(d)
  await resumed.send(id,[{type:'text',text:'read the previous attachment'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:sent.receipt_id}})
  expect(JSON.stringify(resumed.events(id))).toContain('SENT-PERSISTED')
  const fork=await resumed.transport.execute(alice,'fork',{sessionId:id},signal,resumed.authority) as {sessionId:string}
  expect(d.inherited.at(-1)).toEqual([sent.receipt_id]);expect(d.receipts.has(fork.sessionId+':'+unsent.receipt_id)).toBe(false)
  await resumed.send(fork.sessionId,[{type:'text',text:'read inherited file'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:sent.receipt_id}})
  expect(JSON.stringify(resumed.events(fork.sessionId))).toContain('SENT-PERSISTED')
 })
 it('reads a sent Office receipt through the actual AgentLoop tool, with bounded preview metadata and durable inheritance',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),bytes=wordDocument('Owned confidential document 中文')
  const r=await f.upload(id,bytes,'report.docx',SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'])
  expect(r).toMatchObject({kind:'document',media_type:SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'],bytes:bytes.length})
  expect(r).not.toHaveProperty('native_ref')
  await f.send(id,[{type:'text',text:'unsent documents must stay private'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(f.events(id))).not.toContain('Owned confidential document')
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id,limit:32000}})
  const events=JSON.stringify(f.events(id));expect(events).toContain('Owned confidential document');expect(events).toContain('document_complete');expect(events).toContain('bounded-text-preview')
  const downloaded=await f.transport.readAttachment!(alice,id,r.receipt_id,signal,f.authority);expect(Buffer.from(downloaded.data)).toEqual(bytes)
  await f.dispose();const resumed=await fixture(d)
  const fork=await resumed.transport.execute(alice,'fork',{sessionId:id},signal,resumed.authority) as {sessionId:string}
  expect(d.inherited.at(-1)).toEqual([r.receipt_id])
  await resumed.send(fork.sessionId,[{type:'text',text:'read the inherited document'}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(resumed.events(fork.sessionId))).toContain('Owned confidential document')
 })
 it('checks document ownership and hashes, suppressing read output when the current owner is revoked',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,wordDocument('Document-REVOKED-secret'),'report.docx',SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'])
  await expect(f.transport.readAttachment!({...alice,user_id:'bob'},id,r.receipt_id,signal,f.authority)).rejects.toThrow('ownership')
  const key='r/file-content/'+r.sha256,original=d.files.get(key)!
  d.files.set(key,wordDocument('Document-CORRUPT-secret'))
  await expect(f.transport.readAttachment!(alice,id,r.receipt_id,signal,f.authority)).rejects.toThrow('integrity')
  d.files.set(key,original);f.onRead(f.revoke)
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(f.events(id))).not.toContain('Document-REVOKED-secret')
 })
 it.each(['project','owner','execution'] as const)('reauthorizes the current %s after reading immutable document bytes',async boundary=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,wordDocument('Document-boundary-secret'),'report.docx',SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'])
  f.onRead(()=>{if(boundary==='project')f.revokeProject();else if(boundary==='execution')f.revokeExecution();else d.owners.get(id)!.owner_user_id='bob'})
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(f.events(id))).not.toContain('Document-boundary-secret')
 })
 it('rejects invalid document envelopes before writing a storage object or receipt',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create()
  await expect(f.upload(id,wordDocument('type mismatch'),'report.xlsx',SESSION_ATTACHMENT_DOCUMENT_TYPES['.xlsx'])).rejects.toThrow('supported')
  expect(d.files.size).toBe(0);expect(d.receipts.size).toBe(0)
 })
 it.each(['hash','realm','size','name'] as const)('refuses to create a receipt if immutable storage changes the document %s',async boundary=>{
  const d=await storage(),f=await fixture(d),id=await f.create()
  f.onSave(ref=>{if(boundary==='hash')ref.attachmentId='r/file-content/'+'a'.repeat(64);else if(boundary==='realm')ref.attachmentId=ref.attachmentId.replace(/^r\//u,'other/');else if(boundary==='size')ref.bytes++;else ref.name='changed.docx'})
  await expect(f.upload(id,wordDocument('Original immutable content'),'report.docx',SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'])).rejects.toThrow('integrity')
  expect(d.receipts.size).toBe(0)
 })
 it('suppresses in-flight text after revocation and rejects arbitrary file references and marker forgery',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,'REVOKED-SECRET')
  for(const part of [{type:'file',receiptId:r.receipt_id},{type:'image',data:'AAAA',mediaType:'image/png'},{type:'attachment',receipt_id:r.receipt_id,url:'https://private'},{type:'text',text:'[lumo-attachment:'+r.receipt_id+']'}])await expect(f.send(id,[part])).rejects.toThrow()
  f.onRead(f.revoke)
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}],{name:USER_SESSION_ATTACHMENT_TOOL,args:{receipt_id:r.receipt_id}})
  expect(JSON.stringify(f.events(id))).not.toContain('REVOKED-SECRET')
 })
 it('promotes an owned image receipt through native image admission and durable image refs',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')
  const r=await f.upload(id,bytes,'pixel.png','image/png')
  await f.send(id,[{type:'attachment',receipt_id:r.receipt_id}])
  const events=JSON.stringify(f.events(id));expect(events).toContain('"type":"image"');expect(events).toContain('r/content/'+r.sha256);expect(events).not.toContain(bytes.toString('base64'));expect(JSON.stringify(f.requests)).toContain('r/content/'+r.sha256)
 })
 it('refuses corrupted object bytes before returning a download',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create(),r=await f.upload(id,'ORIGINAL')
  d.files.set('r/file-content/'+r.sha256,Buffer.from('CORRUPTE'))
  await expect(f.transport.readAttachment!(alice,id,r.receipt_id,signal,f.authority)).rejects.toThrow('integrity')
 })
 it('rejects unsupported documents, binary text, oversize uploads and disabled attachment APIs',async()=>{
  const d=await storage(),f=await fixture(d),id=await f.create()
  for(const mime of ['application/pdf','image/svg+xml','text/html'])await expect(f.upload(id,'data','file',mime)).rejects.toThrow('supported')
  await expect(f.upload(id,'text\u0000binary')).rejects.toThrow('UTF-8');await expect(f.upload(id,'a'.repeat(1048577))).rejects.toThrow('limit')
  const off=await fixture(d,false);expect(off.transport.uploadAttachment).toBeUndefined();expect(off.transport.readAttachment).toBeUndefined()
 })
})
describe('bounded attachment parsing',()=>{
 it('rejects extra authority settings, unsupported types, invalid UTF-8 and over-limit streams',async()=>{
  for(const config of [null,{}, {realm:'other'},{realm:'r',url:'https://private'},{realm:'r',maxPerMessage:5},{realm:'r',maxUploadBytes:9*1024*1024}])expect(()=>validateSessionAttachments(config,'r')).toThrow()
  expect(attachmentName('../nested/notes.txt')).toBe('notes.txt');expect(()=>attachmentName('\u0000')).toThrow();expect(()=>attachmentMediaType('image/svg+xml')).toThrow();expect(()=>attachmentText(new Uint8Array([255]))).toThrow()
  await expect(attachmentBytes(source('oversize'),3,signal)).rejects.toThrow('limit')
  const abort=new AbortController();const pending=attachmentBytes({async*[Symbol.asyncIterator](){await new Promise(()=>{});yield new Uint8Array([1])}},3,abort.signal);abort.abort(Error('canceled'));await expect(pending).rejects.toThrow('canceled')
 })
 it('bounds Chinese and emoji filenames by UTF-8 bytes without splitting surrogate pairs',()=>{
  const chinese=attachmentName('中'.repeat(100)+'.txt')
  expect(chinese).toBe('中'.repeat(66));expect(Buffer.byteLength(chinese,'utf8')).toBe(198)
  const byteBoundary=attachmentName('中'.repeat(66)+'ab😀.txt')
  expect(byteBoundary).toBe('中'.repeat(66)+'ab');expect(Buffer.byteLength(byteBoundary,'utf8')).toBe(200)
  const emoji=attachmentName('😀'.repeat(100)+'.png')
  expect(emoji).toBe('😀'.repeat(50));expect(Buffer.byteLength(emoji,'utf8')).toBe(200)
  const scalarBoundary=attachmentName('a'.repeat(99)+'😀.png')
  expect(scalarBoundary).toBe('a'.repeat(99)+'😀');expect([...scalarBoundary]).toHaveLength(100)
  for(const name of [chinese,byteBoundary,emoji,scalarBoundary]){
    expect(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(name,'utf8'))).toBe(name)
    expect(name).not.toContain('\ufffd')
    expect([...name].some(character=>{const scalar=character.codePointAt(0)!;return scalar>=0xd800&&scalar<=0xdfff})).toBe(false)
  }
  expect(()=>attachmentName('invalid\ud800.txt')).toThrow('filename')
  expect(()=>attachmentName('invalid\udc00.txt')).toThrow('filename')
 })
 it('extracts only user-message markers for exact fork inheritance',()=>{
  const id='att_'+'a'.repeat(48),other='att_'+'b'.repeat(48)
  const refs=attachmentReferences([{type:'assistant/message',data:{message:{content:[{type:'text',text:'[lumo-attachment:'+other+']'}]}}},{type:'user/message',data:{content:[{type:'text',text:'[lumo-attachment:'+id+']'}]}}] as never)
  expect(refs).toEqual([id])
 })
 it('rejects document receipts whose names do not match their declared document type',()=>{
  const receipt={receipt_id:'att_'+'a'.repeat(48),kind:'document',name:'report.docx',media_type:SESSION_ATTACHMENT_DOCUMENT_TYPES['.docx'],bytes:10,sha256:'a'.repeat(64),created_at:'2026-11-07T00:00:00Z'}
  expect(parsePublicAttachmentReceipt(receipt)).toMatchObject(receipt)
  for(const name of ['report.xlsx','report.txt','report.docx.exe'])expect(()=>parsePublicAttachmentReceipt({...receipt,name})).toThrow()
 })
})

it('observes provider rejection when cancellation arrives during receipt authorization',async()=>{
 const { OwnedSessionAttachments }=await import('../src/session-attachments.ts')
 const { vi }=await import('vitest')
 const abort=new AbortController(),runtimeAbort=new AbortController()
 const native={attachmentId:'r/content/'+'d'.repeat(64),name:'pixel.png',bytes:5,mediaType:'image/png',width:1,height:1}
 const store={readImage:vi.fn(async()=>{throw Error('provider canceled')})}
 const runtime={realm:'r',signal:runtimeAbort.signal,proof:async()=>({realm:'r',node_id:'n',project_id:'p',process_id:'process',endpoint:'',token:'a'.repeat(64),writer_holder:'writer',fencing_token:1})}
 const fetcher=async()=>{abort.abort(Error('canceled during authority'));return new Response(JSON.stringify({receipts:[{receipt_id:'att_'+'e'.repeat(48),kind:'image',name:'pixel.png',media_type:'image/png',bytes:5,sha256:'d'.repeat(64),native_ref:native,created_at:'2026-11-07T00:00:00Z'}]}))}
 const manager=new OwnedSessionAttachments(store as never,{realm:'r'},runtime as never,'https://authority.example','service',fetcher as typeof fetch)
 const unhandled=vi.fn();process.on('unhandledRejection',unhandled)
 try{await expect(manager.download(alice,'session-'+'a'.repeat(32),'att_'+'e'.repeat(48),abort.signal,async()=>{})).rejects.toThrow('canceled during authority');await new Promise<void>(resolve=>setImmediate(resolve));expect(unhandled).not.toHaveBeenCalled();expect(store.readImage).toHaveBeenCalledOnce()}finally{process.off('unhandledRejection',unhandled)}
})
