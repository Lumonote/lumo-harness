import { SessionOwnerClient } from '../../../shared/session-owners.ts'
import { boundedJSON, SessionExecutionClient, SessionExecutionFencedError, type ExecutionNode } from '../../../shared/session-execution.ts'
import type { Principal } from './client.ts'
import type { AuthenticatedSessionTransport, SessionAuthority, SessionTransportConfig } from './session-transport.ts'
import { SessionModelPolicyError } from './session-model-policy.ts'

const streams = new Set(['follow','observeState','observeEvent','observeProjections'])
const unary = new Set(['fork','state','wait','events','page','projections','rename','prompt','cancel','updateQueue','models','selectModel'])
export const SESSION_RUNTIME_PATH = '/lumo/runtime/session'
/** Origins are deployment configuration, never browser input or registration
 * data. A current authority fact must agree with the pinned origin as well. */
export function trustedSessionRoutes(config: SessionTransportConfig): ReadonlyMap<string,string> {
  const routes=new Map<string,string>()
  if(!config.routing) return routes
  if(!['tls','mesh-mtls','development'].includes(config.routing.transportSecurity)||!config.routing.routes||Array.isArray(config.routing.routes)||Object.keys(config.routing.routes).length>100) throw new Error('Invalid Session routing configuration')
  for(const [node,origin] of Object.entries(config.routing.routes)) {
    if(!node.trim()||node.length>256||typeof origin!=='string') throw new Error('Invalid Session routing node')
    const u=new URL(origin)
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.href!==u.origin+'/'||config.routing.transportSecurity==='tls'&&u.protocol!=='https:') throw new Error('Session routes must be exact trusted origins with the configured transport security')
    routes.set(node,u.origin)
  }
  if(!routes.has(config.nodeId)) throw new Error('Session routing must pin the local node origin')
  return routes
}
function refOf(request: Record<string,unknown>): string {
  const address=request.address as Record<string,unknown>|undefined
  if(address && (typeof address!=='object'||Array.isArray(address)||address.kind!=='session'||request.sessionId!==undefined)) throw new Error('Only owned ordinary Session addresses are routable')
  const ref=address?.sessionId??request.sessionId
  if(typeof ref!=='string'||!/^session-[a-f0-9]{32}$/u.test(ref)) throw new Error('A managed Session identity is required')
  return ref
}
export function routeSessionTransport(local: AuthenticatedSessionTransport,config: SessionTransportConfig,realm: string,token: string,authorizeProject: (p:Principal)=>Promise<void>,fetcher:typeof fetch=globalThis.fetch): AuthenticatedSessionTransport {
  const routes=trustedSessionRoutes(config)
  if(!routes.size) return local
  const runtime=local.runtime
  if(!runtime) throw new Error('Session routing requires persistent execution fencing')
  const owners=new SessionOwnerClient(config.authorityUrl,token,fetcher)
  const executions=new SessionExecutionClient(config.authorityUrl,token,fetcher)
  const destination=async(node:ExecutionNode):Promise<void>=>{
    await runtime.check()
    const current=await executions.node(realm,config.nodeId,config.projectId)
    if(node?.realm!==realm||node.node_id!==config.nodeId||node.project_id!==config.projectId||node.process_id!==runtime.processId||node.process_id!==current.process_id||node.fence!==current.fence||node.endpoint!==routes.get(config.nodeId)||current.endpoint!==node.endpoint) throw new SessionExecutionFencedError()
  }
  const routed=async(principal:Principal,action:string,request:Record<string,unknown>,signal:AbortSignal,authority?:SessionAuthority):Promise<Response|undefined>=>{
    signal.throwIfAborted()
    if(principal.realm!==realm||!authority?.credential) throw new SessionExecutionFencedError()
    await runtime.check()
    await authority();await authorizeProject(principal)
    const owner=await owners.get(realm,refOf(request))
    if(owner.state!=='active'||owner.owner_user_id!==principal.user_id||owner.project_id!==config.projectId) throw new SessionExecutionFencedError()
    if(owner.node_id===config.nodeId) return undefined
    const origin=routes.get(owner.node_id)
    if(!origin) throw new SessionExecutionFencedError()
    const node=await executions.node(realm,owner.node_id,config.projectId)
    if(node.endpoint!==origin) throw new SessionExecutionFencedError()
    // No Cookie, browser headers, redirect, caller URL or caller principal is
    // forwarded. Only this exact configured origin receives the credential.
    const response=await fetcher(origin+SESSION_RUNTIME_PATH,{method:'POST',redirect:'error',signal,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action,request,credential:authority.credential,destination:node})})
    if(!response.ok) {
      if (action === 'selectModel' && response.status === 409) {
        const value = await boundedJSON(response, 4096) as { error?: unknown }
        if (value.error === 'session_model_changed' || value.error === 'session_model_busy') throw new SessionModelPolicyError(value.error, 'Refresh the current model selection')
      }
      await response.body?.cancel();throw new SessionExecutionFencedError()
    }
    return response
  }
  const withAuthority=async<T>(authority:SessionAuthority|undefined,signal:AbortSignal,run:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const cancel=new AbortController(); const combined=AbortSignal.any([signal,cancel.signal,AbortSignal.timeout(35_000),...(runtime.signal?[runtime.signal]:[])])
    let checking=false
    const timer=setInterval(()=>{if(!checking){checking=true;void authority?.().catch(()=>cancel.abort()).finally(()=>{checking=false})}},1000);timer.unref()
    try{return await run(combined)}finally{clearInterval(timer);cancel.abort()}
  }
  return {
    runtime,internal:{transport:local,destination},
    async execute(principal,action,request,signal,authority){
      if(action==='create') return local.execute(principal,action,request,signal,authority)
      if(action==='list'){
        if(principal.realm!==realm||Object.keys(request).some(k=>k!=='after')||request.after!==undefined&&typeof request.after!=='string')throw new Error('Invalid Session project list')
        await authority?.();await authorizeProject(principal)
        await runtime.check()
        return owners.listProject(realm,principal.user_id,config.projectId,request.after as string|undefined)
      }
      if(!unary.has(action))throw new Error('Unsupported routed Session action')
      return withAuthority(authority,signal,async active=>{
        const response=await routed(principal,action,request,active,authority)
        if(!response) return local.execute(principal,action,request,active,authority)
        const result=await boundedJSON(response,4*1024*1024)
        await authority?.();await authorizeProject(principal);active.throwIfAborted()
        return result
      })
    },
    async stream(principal,action,request,signal,authority){
      if(!streams.has(action))throw new Error('Unsupported routed Session stream')
      const cancel=new AbortController();const active=AbortSignal.any([signal,cancel.signal,AbortSignal.timeout(30*60_000),...(runtime.signal?[runtime.signal]:[])])
      let checking=false
      const timer=setInterval(()=>{if(!checking){checking=true;void authority?.().catch(()=>cancel.abort()).finally(()=>{checking=false})}},1000);timer.unref()
      try{
        const response=await routed(principal,action,request,active,authority)
        if(!response){clearInterval(timer);return local.stream(principal,action,request,signal,authority)}
        if(!response.body||!response.headers.get('content-type')?.includes('application/x-ndjson'))throw new SessionExecutionFencedError()
        const reader=response.body.getReader()
        return (async function*(){let pending='';const decoder=new TextDecoder();try{for(;;){const chunk=await reader.read();if(chunk.done){if(pending.trim())throw new SessionExecutionFencedError();break}pending+=decoder.decode(chunk.value,{stream:true});if(Buffer.byteLength(pending)>1024*1024)throw new SessionExecutionFencedError();for(;;){const at=pending.indexOf('\n');if(at<0)break;const frame=pending.slice(0,at);pending=pending.slice(at+1);active.throwIfAborted();await authority?.();await authorizeProject(principal);if(frame)yield JSON.parse(frame)}}}finally{clearInterval(timer);cancel.abort();await reader.cancel().catch(()=>{});reader.releaseLock()}})()
      }catch(error){clearInterval(timer);cancel.abort();throw error}
    },
  }
}
