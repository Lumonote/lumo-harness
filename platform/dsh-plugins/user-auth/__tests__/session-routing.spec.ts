import {describe,it,expect,vi} from 'vitest'
import {routeSessionTransport,trustedSessionRoutes,SESSION_RUNTIME_PATH} from '../src/session-routing.ts'
import type {AuthenticatedSessionTransport,SessionTransportConfig} from '../src/session-transport.ts'
import type {SessionExecutionRuntime} from '../../../shared/session-execution.ts'

const alice={realm:'r',user_id:'alice',username:'alice',display_name:'Alice',roles:['operator'],session_expires_at:'2099-01-01'}
const ref=`session-${'a'.repeat(32)}`
const config:SessionTransportConfig={authorityUrl:'https://authority.example',nodeId:'node-a',projectId:'p',workspaceRoot:'/srv/sessions',provider:'mock',model:'mock',routing:{routes:{'node-a':'https://a.example','node-b':'https://b.example'},transportSecurity:'tls'}}
function fixture(){
  const node={realm:'r',node_id:'node-b',project_id:'p',process_id:'b-process',endpoint:'https://b.example',fence:7,expires_at:'2099-01-01'}
  const owner={session_ref:ref,realm:'r',owner_user_id:'alice',project_id:'p',node_id:'node-b',parent_session_ref:'',state:'active',created_at:'2026-11-07'}
  let response=()=>new Response(JSON.stringify({accepted:true}))
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    const u=new URL(String(url))
    if(u.hostname==='authority.example')return new Response(JSON.stringify(u.pathname.startsWith('/v1/session-owners')?{owner}:{node}))
    expect(u.href).toBe('https://b.example'+SESSION_RUNTIME_PATH)
    expect(init?.redirect).toBe('error');expect(init?.headers).toEqual({authorization:'Bearer service-secret','content-type':'application/json'})
    const body=JSON.parse(String(init?.body));expect(body.credential).toBe('login-secret');expect(body.destination.process_id).toBe('b-process');expect(body).not.toHaveProperty('principal')
    return response()
  })
  const runtimeAbort=new AbortController()
  const local:AuthenticatedSessionTransport={execute:vi.fn(async()=>({local:true})),stream:vi.fn(async()=>async function*(){yield {local:true}}()),runtime:{processId:'a-process',signal:runtimeAbort.signal,check:vi.fn(async()=>{})} as unknown as SessionExecutionRuntime}
  const authorize=vi.fn(async()=>{});const authority=Object.assign(vi.fn(async()=>alice),{credential:'login-secret'})
  const transport=routeSessionTransport(local,config,'r','service-secret',authorize,fetcher as typeof fetch)
  return {node,owner,fetcher,local,authorize,authority,transport,runtimeAbort,setResponse:(fn:typeof response)=>{response=fn}}
}
describe('pinned current-node Session routing',()=>{
  it('routes an owned request to the current pinned process and revalidates both sides',async()=>{
    const f=fixture()
    await expect(f.transport.execute(alice,'prompt',{sessionId:ref,content:[{type:'text',text:'hi'}]},new AbortController().signal,f.authority)).resolves.toEqual({accepted:true})
    expect(f.local.execute).not.toHaveBeenCalled();expect(f.authority.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(f.fetcher.mock.calls.filter(([url])=>String(url).startsWith('https://b.example'))).toHaveLength(1)
  })
  it.each(['foreign owner','foreign project','foreign Realm','unregistered node','changed endpoint'])('rejects %s before sending a credential',async kind=>{
    const f=fixture()
    if(kind==='foreign owner')f.owner.owner_user_id='bob'
    if(kind==='foreign project')f.owner.project_id='foreign'
    if(kind==='foreign Realm')f.owner.realm='foreign'
    if(kind==='unregistered node')f.owner.node_id='unknown'
    if(kind==='changed endpoint')f.node.endpoint='https://attacker.example'
    await expect(f.transport.execute(alice,'events',{sessionId:ref},new AbortController().signal,f.authority)).rejects.toThrow()
    expect(f.fetcher.mock.calls.every(([url])=>String(url).startsWith('https://authority.example'))).toBe(true)
  })
  it('rejects a revoked login and browser chosen URLs or child addresses',async()=>{
    const f=fixture();f.authority.mockRejectedValueOnce(new Error('revoked'))
    await expect(f.transport.execute(alice,'cancel',{sessionId:ref},new AbortController().signal,f.authority)).rejects.toThrow('revoked')
    expect(f.fetcher).not.toHaveBeenCalled()
    await expect(f.transport.execute(alice,'prompt',{address:{kind:'subagent',sessionId:ref,url:'https://evil'}},new AbortController().signal,f.authority)).rejects.toThrow()
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('streams bounded frames and suppresses data after current authorization is lost',async()=>{
    const f=fixture();f.setResponse(()=>new Response('{"cursor":1}\n{"cursor":2}\n',{headers:{'content-type':'application/x-ndjson'}}))
    const stream=await f.transport.stream(alice,'observeState',{sessionId:ref},new AbortController().signal,f.authority)
    const iterator=stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({value:{cursor:1}})
    f.authority.mockRejectedValueOnce(new Error('revoked'))
    await expect(iterator.next()).rejects.toThrow('revoked')
  })
  it('accepts internal destination only for this exact current process',async()=>{
    const f=fixture()
    await expect(f.transport.internal!.destination(f.node)).rejects.toThrow()
  })
  it('stops remote stream frames when the source execution runtime is fenced',async()=>{
    const f=fixture();f.setResponse(()=>new Response('{"cursor":1}\n{"cursor":2}\n',{headers:{'content-type':'application/x-ndjson'}}))
    const stream=await f.transport.stream(alice,'observeState',{sessionId:ref},new AbortController().signal,f.authority)
    const iterator=stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({value:{cursor:1}})
    f.runtimeAbort.abort(new Error('source execution fenced'))
    await expect(iterator.next()).rejects.toThrow('source execution fenced')
  })
  it('rejects credentials, paths, redirects and plaintext when TLS is required',()=>{
    for(const origin of ['http://b.example','https://user:secret@b.example','https://b.example/path','https://b.example?q=x','https://b.example#x'])expect(()=>trustedSessionRoutes({...config,routing:{routes:{'node-a':origin},transportSecurity:'tls'}})).toThrow()
  })
})
