import { afterEach,describe,it,expect,vi } from 'vitest'
import { createAuthProxy,listenAuthProxy,closeAuthProxy } from '../src/proxy.ts'
import type { AuthenticatedSessionTransport } from '../src/session-transport.ts'
import { GovernanceApiError, type GovernanceAuthClient } from '../src/client.ts'
import { SessionRequestError } from '../src/session-request-errors.ts'
const principal={realm:'r',user_id:'alice',username:'alice',display_name:'Alice',roles:['viewer'],session_expires_at:'2099-01-01'}
const ref='session-'+'a'.repeat(32),id='att_'+'b'.repeat(48)
const closers:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close()})
async function fixture(){
 let revoked=false
 const client={session:vi.fn(async(credential:string)=>{if(revoked||credential!=='login-secret')throw new GovernanceApiError(401,'invalid_session','invalid');return principal}),authorizeSessionProject:vi.fn(async()=>{})} as unknown as GovernanceAuthClient
 const upload=vi.fn(async(_principal,sessionID,metadata,source:AsyncIterable<Uint8Array>,_signal,authority)=>{await authority();expect(sessionID).toBe(ref);let bytes=0;for await(const value of source)bytes+=value.length;return {receipt_id:id,kind:'text',name:metadata.name,media_type:'text/plain',bytes,sha256:'c'.repeat(64),created_at:'2026-11-07T00:00:00Z'}})
 const read=vi.fn(async(_principal,sessionID,receiptID,_signal,authority)=>{await authority();expect(sessionID).toBe(ref);expect(receiptID).toBe(id);return {name:'notes.txt',mediaType:'text/plain',data:Buffer.from('PRIVATE-TEXT')}})
 const destination=vi.fn(async(value)=>{if(value?.process_id!=='current-process')throw Error('fenced')})
 const local:AuthenticatedSessionTransport={execute:vi.fn(),stream:vi.fn(),uploadAttachment:upload,readAttachment:read}
 const transport:AuthenticatedSessionTransport={...local,internal:{transport:local,destination}}
 const server=createAuthProxy({host:'127.0.0.1',port:0,secureCookie:false,clusterMode:true,realm:'r',projectId:'p',identityAssertionSecret:'a'.repeat(32),upstreamPort:1,client,sessionTransport:transport,serverRuntimeToken:'service-secret',logger:{info(){},warn(){},error(){}}})
 const port=await listenAuthProxy(server,'127.0.0.1',0);closers.push(()=>closeAuthProxy(server));return {base:'http://127.0.0.1:'+port,upload,read,destination,client,revoke:()=>{revoked=true}}
}
const publicHeaders={'cookie':'lumo_auth_session=login-secret','x-lumo-auth-request':'1','content-type':'text/plain','x-lumo-attachment-name':'notes.txt'}
function envelope(credential='login-secret',process='current-process'){return Buffer.from(JSON.stringify({credential,destination:{process_id:process},metadata:{name:'notes.txt',mediaType:'text/plain'}})).toString('base64url')}
const group=process.env['LUMO_AUTH_PROXY_TEST']==='1'?describe:describe.skip
group('independent owned attachment binary HTTP ingress',()=>{
 it('accepts a binary body larger than the JSON API limit and returns safe download headers',async()=>{
  const f=await fixture(),response=await fetch(f.base+'/lumo/session-attachments/'+ref,{method:'POST',headers:publicHeaders,body:'x'.repeat(100000)})
  expect(response.status).toBe(201);expect(await response.json()).toMatchObject({receipt_id:id,bytes:100000});expect(f.upload).toHaveBeenCalledOnce()
  const download=await fetch(f.base+'/lumo/session-attachments/'+ref+'/'+id,{headers:{cookie:publicHeaders.cookie}})
  expect(download.status).toBe(200);expect(await download.text()).toBe('PRIVATE-TEXT');expect(download.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''notes.txt");expect(download.headers.get('x-content-type-options')).toBe('nosniff');expect(download.headers.get('cache-control')).toBe('no-store');expect(f.read).toHaveBeenCalledOnce()
 })
 it('requires CSRF header and current cookie and rejects query/path/encoding metadata',async()=>{
  const f=await fixture()
  for(const [headers,status] of [[{...publicHeaders,'x-lumo-auth-request':''},403],[{...publicHeaders,'content-encoding':'gzip'},415],[{...publicHeaders,'x-lumo-attachment-name':'..%2F%00'},400]] as const){const response=await fetch(f.base+'/lumo/session-attachments/'+ref,{method:'POST',headers,body:'text'});expect(response.status).toBe(status)}
  const query=await fetch(f.base+'/lumo/session-attachments/'+ref+'?url=https://private',{method:'POST',headers:publicHeaders,body:'text'});expect(query.status).toBe(400);expect(f.upload).not.toHaveBeenCalled()
  f.revoke();const revoked=await fetch(f.base+'/lumo/session-attachments/'+ref+'/'+id,{headers:{cookie:publicHeaders.cookie},redirect:'manual'});expect([401,303]).toContain(revoked.status);expect(f.read).not.toHaveBeenCalled()
 })
 it('authenticates the target independently and rejects stale destinations or forged browser headers',async()=>{
  const f=await fixture(),path=f.base+'/lumo/runtime/session-attachments/'+ref
  for(const headers of [ {'content-type':'text/plain','x-lumo-attachment-envelope':envelope()}, {'content-type':'text/plain','authorization':'Bearer service-secret','x-lumo-attachment-envelope':envelope('forged'),'cookie':publicHeaders.cookie,'x-lumo-user':'alice'}, {'content-type':'text/plain','authorization':'Bearer service-secret','x-lumo-attachment-envelope':envelope('login-secret','stale-process')} ]){const response=await fetch(path,{method:'POST',headers,body:'text'});expect([401,403]).toContain(response.status)}
  expect(f.upload).not.toHaveBeenCalled()
  const accepted=await fetch(path,{method:'POST',headers:{'content-type':'text/plain','authorization':'Bearer service-secret','x-lumo-attachment-envelope':envelope()},body:'text'});expect(accepted.status).toBe(201);expect(f.upload).toHaveBeenCalledOnce();expect(f.destination.mock.calls.length).toBeGreaterThan(1)
 })
 it.each(['session_attachment_too_large','session_attachment_busy','session_attachment_unavailable','session_attachment_denied','storage_quota_exceeded'] as const)('preserves safe %s status without reflecting dependency detail',async code=>{
  const f=await fixture(),failure=new SessionRequestError(code,7);f.upload.mockRejectedValueOnce(failure)
  const response=await fetch(f.base+'/lumo/session-attachments/'+ref,{method:'POST',headers:publicHeaders,body:'text'})
  expect(response.status).toBe(failure.status);expect(await response.json()).toEqual({error:code,retryable:failure.retryable});expect(response.headers.get('retry-after')).toBe(code==='session_attachment_busy'?'7':null)
  f.upload.mockRejectedValueOnce(Object.assign(Error('service-secret private-bucket'),{code:'storage_quota_exceeded',status:507}))
  const hostile=await fetch(f.base+'/lumo/session-attachments/'+ref,{method:'POST',headers:publicHeaders,body:'text'});expect(hostile.status).toBe(403);expect(await hostile.text()).not.toMatch(/service-secret|private-bucket|storage_quota/u)
 })
})
