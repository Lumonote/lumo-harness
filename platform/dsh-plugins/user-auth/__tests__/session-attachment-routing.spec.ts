import { describe,it,expect,vi } from 'vitest'
import { routeSessionTransport } from '../src/session-routing.ts'
import type { AuthenticatedSessionTransport, SessionTransportConfig } from '../src/session-transport.ts'
import type { SessionExecutionRuntime } from '../../../shared/session-execution.ts'
import { parsePublicAttachmentReceipt } from '../src/session-attachments.ts'
const principal={realm:'r',user_id:'alice',username:'alice',display_name:'Alice',roles:['viewer'],session_expires_at:'2099-01-01'}
const ref='session-'+'a'.repeat(32),id='att_'+'b'.repeat(48)
const config:SessionTransportConfig={authorityUrl:'https://authority.example',nodeId:'a',projectId:'p',workspaceRoot:'/workspaces',provider:'mock',model:'mock',attachments:{realm:'r',maxUploadBytes:1024,maxTextBytes:1024},routing:{routes:{a:'https://a.example',b:'https://b.example'},transportSecurity:'tls'}}
const source=(text:string)=>(async function*(){yield Buffer.from(text)})()
function fixture(){
 const node={realm:'r',node_id:'b',project_id:'p',process_id:'process-b',endpoint:'https://b.example',fence:4,expires_at:'2099-01-01'}
 const owner={session_ref:ref,realm:'r',owner_user_id:'alice',project_id:'p',node_id:'b',state:'active',parent_session_ref:'',created_at:'2026-11-07'}
 const receipt={receipt_id:id,kind:'text',name:'notes.txt',media_type:'text/plain',bytes:5,sha256:'c'.repeat(64),created_at:'2026-11-07T00:00:00Z'}
 const controller=new AbortController();let revoke=false;let readResponse=()=>new Response('hello',{headers:{'content-type':'text/plain','x-lumo-attachment-name':'notes.txt'}})
 const authority=Object.assign(vi.fn(async()=>{if(revoke)throw Error('revoked');return principal}),{credential:'login-secret'})
 const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  const parsed=new URL(String(url));if(parsed.hostname==='authority.example')return new Response(JSON.stringify(parsed.pathname.includes('/session-owners/')?{owner}:{node}))
  expect(parsed.origin).toBe('https://b.example');expect(init?.redirect).toBe('error');const headers=init!.headers as Record<string,string>;expect(headers.authorization).toBe('Bearer service-secret');expect(headers).not.toHaveProperty('cookie')
  const envelope=JSON.parse(Buffer.from(headers['x-lumo-attachment-envelope']!,'base64url').toString('utf8'));expect(envelope.credential).toBe('login-secret');expect(envelope.destination).toEqual(node);expect(envelope).not.toHaveProperty('principal')
  if(init?.method==='POST'){expect(parsed.pathname).toBe('/lumo/runtime/session-attachments/'+ref);expect(envelope.metadata).toEqual({name:'notes.txt',mediaType:'text/plain'});expect(Buffer.from(init.body as Buffer).toString()).toBe('hello');return new Response(JSON.stringify(receipt),{status:201})}
  expect(parsed.pathname).toBe('/lumo/runtime/session-attachments/'+ref+'/'+id);return readResponse()
 })
 const local:AuthenticatedSessionTransport={execute:vi.fn(),stream:vi.fn(),uploadAttachment:vi.fn(),readAttachment:vi.fn(),runtime:{processId:'process-a',signal:controller.signal,check:vi.fn(async()=>{})} as unknown as SessionExecutionRuntime}
 const transport=routeSessionTransport(local,config,'r','service-secret',async()=>{},fetcher as typeof fetch)
 return {transport,local,node,owner,receipt,authority,fetcher,controller,revoke:()=>{revoke=true},readResponse:(fn:typeof readResponse)=>{readResponse=fn}}
}
describe('bounded binary attachment routing',()=>{
 it('uses a separate fixed binary endpoint with target-only credential and exact process envelope',async()=>{
  const f=fixture();await expect(f.transport.uploadAttachment!(principal,ref,{name:'notes.txt',mediaType:'text/plain'},source('hello'),new AbortController().signal,f.authority)).resolves.toEqual(f.receipt)
  const binary=await f.transport.readAttachment!(principal,ref,id,new AbortController().signal,f.authority);expect(Buffer.from(binary.data).toString()).toBe('hello');expect(binary.name).toBe('notes.txt');expect(f.local.uploadAttachment).not.toHaveBeenCalled();expect(f.local.readAttachment).not.toHaveBeenCalled()
 })
 it.each(['owner','realm','project','node','endpoint'])('does not forward a credential after %s mismatch',async kind=>{
  const f=fixture();if(kind==='owner')f.owner.owner_user_id='bob';if(kind==='realm')f.owner.realm='other';if(kind==='project')f.owner.project_id='other';if(kind==='node')f.owner.node_id='unknown';if(kind==='endpoint')f.node.endpoint='https://private.example'
  await expect(f.transport.uploadAttachment!(principal,ref,{name:'notes.txt',mediaType:'text/plain'},source('hello'),new AbortController().signal,f.authority)).rejects.toThrow();expect(f.fetcher.mock.calls.every(([u])=>String(u).startsWith('https://authority.example'))).toBe(true)
 })
 it('discards remote bytes after login revocation and limits upload and download streams',async()=>{
  const f=fixture();f.readResponse(()=>{f.revoke();return new Response('PRIVATE',{headers:{'content-type':'text/plain','x-lumo-attachment-name':'notes.txt'}})})
  await expect(f.transport.readAttachment!(principal,ref,id,new AbortController().signal,f.authority)).rejects.toThrow('revoked')
  const g=fixture();await expect(g.transport.uploadAttachment!(principal,ref,{name:'notes.txt',mediaType:'text/plain'},source('a'.repeat(1025)),new AbortController().signal,g.authority)).rejects.toThrow('limit');g.readResponse(()=>new Response('a'.repeat(1025),{headers:{'content-type':'text/plain','x-lumo-attachment-name':'notes.txt'}}));await expect(g.transport.readAttachment!(principal,ref,id,new AbortController().signal,g.authority)).rejects.toThrow('limit')
 })
 it('strips private native references and refuses malformed public receipt metadata',()=>{
  const f=fixture();expect(parsePublicAttachmentReceipt({...f.receipt,native_ref:{attachmentId:'/private'}})).toEqual(f.receipt)
  for(const value of [{...f.receipt,receipt_id:'https://private'},{...f.receipt,name:'../private'},{...f.receipt,media_type:'text/html'},{...f.receipt,bytes:9*1024*1024}])expect(()=>parsePublicAttachmentReceipt(value)).toThrow()
 })
})
