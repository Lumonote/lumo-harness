import { attachmentBytes, attachmentMediaType, attachmentName, parsePublicAttachmentReceipt } from './session-attachments.ts'
import { SESSION_ATTACHMENT_MAX_BYTES, SESSION_ATTACHMENT_RUNTIME_PATH, type SessionAttachmentDownload, type SessionAttachmentReceipt, type SessionAttachmentUpload } from '../../../shared/seam-contracts/session-attachments.ts'
import { SessionOwnerClient } from '../../../shared/session-owners.ts'
import { boundedJSON, SessionExecutionClient, SessionExecutionFencedError, type ExecutionNode } from '../../../shared/session-execution.ts'
import type { Principal } from './client.ts'
import type { AuthenticatedSessionTransport, SessionAuthority, SessionTransportConfig } from './session-transport.ts'
import { SessionModelPolicyError } from './session-model-policy.ts'
import { SessionRequestError, sessionUpstreamError, publicSessionRequestError } from './session-request-errors.ts'
import { SessionMigrationClient, SessionMigrationError, migrationActions } from './session-migration.ts'

const streams = new Set(['follow','observeState','observeEvent','observeProjections'])
const unary = new Set(['fork','state','wait','events','page','projections','rename','prompt','cancel','updateQueue','models','selectModel','interactionList','interactionAnswer','checkpoint','recover'])
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
  const migrations=new SessionMigrationClient(config.authorityUrl,token,fetcher)
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
    if(config.migration&&action!=='recover') {
      const receipt=await migrations.get(realm,owner.session_ref,undefined,signal)
      if(receipt?.state==='checkpointed')throw new SessionMigrationError('session_migration_frozen')
    }
    let destinationNode=owner.node_id
    if(action==='recover') {
      if(!config.migration||typeof request.migrationId!=='string')throw new SessionMigrationError('session_migration_invalid')
      const receipt=await migrations.get(realm,owner.session_ref,request.migrationId,signal)
      if(!receipt||receipt.realm!==realm||receipt.owner_user_id!==principal.user_id||receipt.project_id!==config.projectId)throw new SessionMigrationError('session_migration_invalid')
      destinationNode=receipt.target_node_id
    }
    if(destinationNode===config.nodeId) return undefined
    const origin=routes.get(destinationNode)
    if(!origin) throw new SessionExecutionFencedError()
    const node=await executions.node(realm,destinationNode,config.projectId)
    if(node.endpoint!==origin) throw new SessionExecutionFencedError()
    // No Cookie, browser headers, redirect, caller URL or caller principal is
    // forwarded. Only this exact configured origin receives the credential.
    const response=await fetcher(origin+SESSION_RUNTIME_PATH,{method:'POST',redirect:'error',signal,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action,request,credential:authority.credential,destination:node})})
    if(!response.ok) {
      let code:unknown
      try{code=(await boundedJSON(response,4096)).error}catch{throw new SessionExecutionFencedError()}
      if(action==='selectModel'&&response.status===409&&(code==='session_model_changed'||code==='session_model_busy'))throw new SessionModelPolicyError(code,'Refresh the current model selection')
      const failure=publicSessionRequestError(code,response.status,response.headers.get('retry-after'))
      if(failure)throw failure
      if(typeof code==='string'&&['session_migration_busy','session_migration_frozen','session_migration_unavailable','session_migration_invalid','session_migration_unknown'].includes(code))throw new SessionMigrationError(code as ConstructorParameters<typeof SessionMigrationError>[0])
      throw new SessionExecutionFencedError()
    }
    return response
  }
  const withAuthority=async<T>(authority:SessionAuthority|undefined,signal:AbortSignal,run:(signal:AbortSignal)=>Promise<T>,timeout=35_000):Promise<T>=>{
    const cancel=new AbortController(); const combined=AbortSignal.any([signal,cancel.signal,AbortSignal.timeout(timeout),...(runtime.signal?[runtime.signal]:[])])
    let checking=false
    const timer=setInterval(()=>{if(!checking){checking=true;void authority?.().catch(()=>cancel.abort()).finally(()=>{checking=false})}},1000);timer.unref()
    try{return await run(combined)}finally{clearInterval(timer);cancel.abort()}
  }
  let attachmentTransfers=0
  const attachmentTarget=async(principal:Principal,ref:string,authority?:SessionAuthority)=>{
    if(principal.realm!==realm||!authority?.credential)throw new SessionExecutionFencedError()
    refOf({sessionId:ref});await runtime.check();await authority();await authorizeProject(principal)
    const owner=await owners.get(realm,ref)
    if(owner.state!=='active'||owner.realm!==realm||owner.owner_user_id!==principal.user_id||owner.project_id!==config.projectId)throw new SessionExecutionFencedError()
    if(owner.node_id===config.nodeId)return undefined
    const origin=routes.get(owner.node_id);if(!origin)throw new SessionExecutionFencedError()
    const node=await executions.node(realm,owner.node_id,config.projectId)
    if(node.endpoint!==origin)throw new SessionExecutionFencedError()
    return {origin,node}
  }
  const attachmentEnvelope=(credential:string,destination:ExecutionNode,metadata?:SessionAttachmentUpload)=>{
    const value=Buffer.from(JSON.stringify({credential,destination,...(metadata?{metadata}:{})})).toString('base64url')
    if(value.length>8192)throw new SessionExecutionFencedError()
    return value
  }
  return {
    runtime,internal:{transport:local,destination},
    ...(local.uploadAttachment&&local.readAttachment?{
      async uploadAttachment(principal:Principal,ref:string,metadata:SessionAttachmentUpload,source:AsyncIterable<Uint8Array>,signal:AbortSignal,authority?:SessionAuthority):Promise<SessionAttachmentReceipt>{
        if(attachmentTransfers>=2)throw new SessionRequestError('session_attachment_busy');attachmentTransfers++
        try{return await withAuthority(authority,signal,async active=>{
          const target=await attachmentTarget(principal,ref,authority)
          if(!target)return local.uploadAttachment!(principal,ref,metadata,source,active,authority)
          const name=attachmentName(metadata.name),mediaType=attachmentMediaType(metadata.mediaType)
          const data=await attachmentBytes(source,config.attachments?.maxUploadBytes??SESSION_ATTACHMENT_MAX_BYTES,active)
          await authority!()
          let response:Response
          try{response=await fetcher(target.origin+SESSION_ATTACHMENT_RUNTIME_PATH+'/'+ref,{method:'POST',redirect:'error',signal:active,headers:{authorization:'Bearer '+token,'content-type':mediaType,'x-lumo-attachment-envelope':attachmentEnvelope(authority!.credential!,target.node,{name,mediaType})},body:Buffer.from(data)})}catch{throw new SessionRequestError('session_attachment_unavailable')}
          if(!response.ok)throw await sessionUpstreamError(response,'attachment')
          const value=await boundedJSON(response,8192)
          await authority!();await authorizeProject(principal);active.throwIfAborted()
          return parsePublicAttachmentReceipt(value)
        })}finally{attachmentTransfers--}
      },
      async readAttachment(principal:Principal,ref:string,id:string,signal:AbortSignal,authority?:SessionAuthority):Promise<SessionAttachmentDownload>{
        if(attachmentTransfers>=2)throw new SessionRequestError('session_attachment_busy');attachmentTransfers++
        try{return await withAuthority(authority,signal,async active=>{
          const target=await attachmentTarget(principal,ref,authority)
          if(!target)return local.readAttachment!(principal,ref,id,active,authority)
          if(!/^att_[a-f0-9]{48}$/u.test(id))throw new SessionExecutionFencedError()
          let response:Response
          try{response=await fetcher(target.origin+SESSION_ATTACHMENT_RUNTIME_PATH+'/'+ref+'/'+id,{method:'GET',redirect:'error',signal:active,headers:{authorization:'Bearer '+token,'x-lumo-attachment-envelope':attachmentEnvelope(authority!.credential!,target.node)}})}catch{throw new SessionRequestError('session_attachment_unavailable')}
          if(!response.ok)throw await sessionUpstreamError(response,'attachment')
          if(!response.body)throw new SessionRequestError('session_attachment_unavailable')
          const mediaType=attachmentMediaType(response.headers.get('content-type')),name=attachmentName(decodeURIComponent(response.headers.get('x-lumo-attachment-name')??''))
          const reader=response.body.getReader()
          const data=await attachmentBytes((async function*(){try{for(;;){const chunk=await reader.read();if(chunk.done)break;yield chunk.value}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}})(),config.attachments?.maxUploadBytes??SESSION_ATTACHMENT_MAX_BYTES,active)
          await authority!();await authorizeProject(principal);active.throwIfAborted();return {data,name,mediaType}
        })}finally{attachmentTransfers--}
      },
    }:{}),
    async execute(principal,action,request,signal,authority){
      if(action==='migrationStatus')return local.execute(principal,action,request,signal,authority)
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
      },migrationActions.has(action)?120_000:35_000)
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
