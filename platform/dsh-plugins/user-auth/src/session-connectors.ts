/** Current-owner connector tools. The model cannot decide approvals or choose
 * endpoints, headers, identities, credentials or execution generations. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequest, UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tools'
import { boundedJSON } from '../../../shared/session-execution.ts'
import type { Principal } from './client.ts'
import { SessionRequestError, sessionUpstreamError, type SessionRequestErrorCode } from './session-request-errors.ts'

export const USER_CONNECTOR_TOOLS = ['user_connector_list', 'user_connector_invoke'] as const
export interface SessionConnectorConfig {
  realm:string
  gatewayUrl:string
  actions:Array<{connectorId:string;operations:string[]}>
}
export interface ConnectorExecutionIdentity {node_id:string;process_id:string;node_fence:number;writer_holder:string;fencing_token:number}
interface Receipt {id:string;connector_id:string;operation:string;connector_version:number;payload:Record<string,unknown>;digest:string;revision:number;status:string;expires_at:string}
interface Invocation {connectorId:string;operation:string;pathParams?:Record<string,string>;query?:Record<string,string>;body?:unknown}
interface Decision {questionId:string;receiptId:string;digest:string;revision:number;decision:'approve'|'reject'}
interface Pending {receipt:Receipt;questions:AskUserQuestionRequest['questions'];resolve?:(answer:AskUserQuestionAnswer)=>void;reject?:(reason:unknown)=>void}
export class SessionConnectorError extends SessionRequestError {
  constructor(code:SessionRequestErrorCode='session_connector_denied'){super(code)}
}
export function validateSessionConnectors(value:unknown,realm?:string):asserts value is SessionConnectorConfig|undefined{
 if(value===undefined)return
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid owned connector configuration')
 const c=value as SessionConnectorConfig
 if(Object.keys(c).some(k=>!['realm','gatewayUrl','actions'].includes(k))||typeof c.realm!=='string'||!c.realm.trim()||realm!==undefined&&c.realm!==realm||!Array.isArray(c.actions)||!c.actions.length||c.actions.length>50)throw new Error('Invalid owned connector configuration')
 const url=new URL(c.gatewayUrl)
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid fixed connector gateway')
 const seen=new Set<string>()
 for(const action of c.actions){
  if(!action||Object.keys(action).some(k=>!['connectorId','operations'].includes(k))||!validName(action.connectorId)||seen.has(action.connectorId)||!Array.isArray(action.operations)||!action.operations.length||action.operations.length>50||action.operations.some(op=>!validName(op))||new Set(action.operations).size!==action.operations.length)throw new Error('Invalid connector action allowlist')
  seen.add(action.connectorId)
 }
}
function validName(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)}
function invocation(value:unknown):Invocation{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new SessionConnectorError()
 const input=value as Record<string,unknown>
 if(Object.keys(input).some(key=>!['connectorId','operation','pathParams','query','body'].includes(key))||!validName(input.connectorId)||!validName(input.operation))throw new SessionConnectorError()
 for(const key of ['pathParams','query'])if(input[key]!==undefined){const map=input[key];if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).length>50||Object.entries(map).some(([k,v])=>!validName(k)||typeof v!=='string'||v.length>4096))throw new SessionConnectorError()}
 const raw=JSON.stringify(input);if(Buffer.byteLength(raw)>64*1024)throw new SessionConnectorError()
 return JSON.parse(raw) as Invocation
}
function receipt(value:unknown):Receipt{
 const r=value as Receipt
 if(!r||typeof r.id!=='string'||!/^[a-f0-9]{48}$/u.test(r.id)||!validName(r.connector_id)||!validName(r.operation)||!Number.isSafeInteger(r.connector_version)||r.connector_version<1||!/^[a-f0-9]{64}$/u.test(r.digest)||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isFinite(Date.parse(r.expires_at))||!r.payload||typeof r.payload!=='object'||Array.isArray(r.payload))throw new SessionConnectorError()
 return r
}
export interface SessionConnectorAccess {
 principal():Promise<Principal>
 credential():string|undefined
 execution():Promise<ConnectorExecutionIdentity>
 signal:AbortSignal
}
export class SessionConnectorTools {
 private readonly pending=new Map<Agent,Map<string,Pending>>()
 private readonly installed=new WeakSet<Agent>()
 private readonly base:string
 private readonly allowed:ReadonlyMap<string,ReadonlySet<string>>
 constructor(private readonly config:SessionConnectorConfig,private readonly token:string,private readonly projectId:string,private readonly access:(agent:Agent)=>SessionConnectorAccess,private readonly fetcher:typeof fetch=globalThis.fetch){
  validateSessionConnectors(config)
  this.base=config.gatewayUrl.replace(/\/+$/u,'')
  this.allowed=new Map(config.actions.map(action=>[action.connectorId,new Set(action.operations)]))
 }
 private async call(agent:Agent,action:string,body:Record<string,unknown>,signal:AbortSignal):Promise<Record<string,unknown>>{
  const access=this.access(agent),principal=await access.principal(),credential=access.credential()
  if(principal.realm!==this.config.realm||!credential)throw new SessionConnectorError()
  const execution=await access.execution()
  const active=AbortSignal.any([signal,access.signal,AbortSignal.timeout(35_000)])
  let response:Response
  try{response=await this.fetcher(`${this.base}/owned/sessions/${encodeURIComponent(String(agent.session.id))}/${action}`,{method:'POST',redirect:'error',signal:active,headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json','X-Lumo-Login-Session':credential},body:JSON.stringify({...body,project_id:this.projectId,execution})})}catch{throw new SessionConnectorError(action==='execute'?'connector_outcome_unknown':'session_connector_unavailable')}
  if(!response.ok)throw await sessionUpstreamError(response,'connector',action==='execute')
  let result:Record<string,unknown>
  try{result=await boundedJSON(response,512*1024)}catch{throw new SessionConnectorError(action==='execute'?'connector_outcome_unknown':'session_connector_unavailable')}
  try{await access.principal();await access.execution();active.throwIfAborted()}catch(error){if(action==='execute')throw new SessionConnectorError('connector_outcome_unknown');throw error}
  return result
 }
 async list(agent:Agent):Promise<{questions:Array<{questionId:string;receiptId:string;digest:string;revision:number;expiresAt:string;questions:AskUserQuestionRequest['questions']}>}>{
  await this.access(agent).principal();await this.access(agent).execution()
  return {questions:[...(this.pending.get(agent)?.entries()??[])].filter(([,item])=>item.resolve!==undefined&&Date.parse(item.receipt.expires_at)>Date.now()).map(([questionId,item])=>({questionId,receiptId:item.receipt.id,digest:item.receipt.digest,revision:item.receipt.revision,expiresAt:item.receipt.expires_at,questions:item.questions}))}
 }
 async answer(agent:Agent,value:unknown):Promise<{accepted:true}>{
  await this.access(agent).principal();await this.access(agent).execution()
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SessionConnectorError()
  const d=value as Decision
  if(Object.keys(d).some(key=>!['questionId','receiptId','digest','revision','decision'].includes(key))||!['approve','reject'].includes(d.decision))throw new SessionConnectorError()
  const pending=this.pending.get(agent)?.get(d.questionId)
  if(!pending?.resolve||pending.receipt.id!==d.receiptId||pending.receipt.digest!==d.digest||pending.receipt.revision!==d.revision||Date.parse(pending.receipt.expires_at)<=Date.now())throw new SessionConnectorError('session_connector_changed')
  // Remove synchronously before waking ask(), so a concurrent second answer
  // cannot claim a question while its one-use decision is being committed.
  this.pending.get(agent)!.delete(d.questionId)
  pending.resolve({answers:[{id:d.questionId,selected:[d.decision==='approve'?'Approve once':'Reject']}]})
  return {accepted:true}
 }
 install(agent:Agent):void{
  if(this.installed.has(agent))return
  const service=agent.ctx.get('userQuestions') as UserQuestionService|undefined
  if(!service)throw new Error('Owned connector writes require the native userQuestions service')
  this.installed.add(agent)
  const pending=new Map<string,Pending>();this.pending.set(agent,pending)
  agent.ctx.on('user-questions/request',async(request,next)=>{
   if(request.agent!==agent||request.questions.length!==1)return next()
   const id=request.questions[0]!.id,item=pending.get(id)
   if(!item||item.questions!==request.questions)return next()
   return new Promise<AskUserQuestionAnswer>((resolve,reject)=>{const signal=request.signal;const cleanup=()=>signal?.removeEventListener('abort',abort);const abort=()=>{pending.delete(id);cleanup();reject(signal?.reason??new SessionConnectorError())};item.resolve=answer=>{cleanup();resolve(answer)};item.reject=reason=>{cleanup();reject(reason)};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()})
  })
  agent.ctx.effect(()=>()=>{for(const item of pending.values())item.reject?.(new SessionConnectorError());pending.clear();this.pending.delete(agent)},'owned connector questions')
  agent.ctx.tools.register({name:USER_CONNECTOR_TOOLS[0],description:'List explicitly approved connector actions available to the current Session owner.',parameters:{type:'object',additionalProperties:false,properties:{}},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(_args,exec)=>{if(exec.agent!==agent)throw new SessionConnectorError();return this.call(agent,'list',{},exec.signal)}})
  agent.ctx.tools.register({name:USER_CONNECTOR_TOOLS[1],description:'Call an approved connector action. Writes pause for exact one-use human approval; URLs, headers, shell and credentials are unavailable.',parameters:{type:'object',additionalProperties:false,required:['connectorId','operation'],properties:{connectorId:{type:'string'},operation:{type:'string'},pathParams:{type:'object',additionalProperties:{type:'string'}},query:{type:'object',additionalProperties:{type:'string'}},body:{}}},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>{
   if(exec.agent!==agent)throw new SessionConnectorError()
   const inv=invocation(args)
   if(!this.allowed.get(inv.connectorId)?.has(inv.operation))throw new SessionConnectorError()
   const access=this.access(agent),signal=AbortSignal.any([exec.signal,access.signal,AbortSignal.timeout(5*60_000)])
   const prepared=await this.call(agent,'prepare',{connector_id:inv.connectorId,invocation:{operation:inv.operation,pathParams:inv.pathParams,query:inv.query,body:inv.body}},signal)
   if(!prepared.receipt)return {provenance:`external:connector/${inv.connectorId}`,...prepared}
   const r=receipt(prepared.receipt)
   if(r.connector_id!==inv.connectorId||r.operation!==inv.operation||r.status!=='pending'||Date.parse(r.expires_at)<=Date.now())throw new SessionConnectorError()
   const id=`connector-${r.id}`
   const questions:AskUserQuestionRequest['questions']=[{id,question:`Approve ${r.connector_id} / ${r.operation} once?`,detail:`Connector version: ${r.connector_version}\nReceipt: ${r.id}\nRevision: ${r.revision}\nSHA-256: ${r.digest}\nExpires: ${r.expires_at}\n\nExact business payload (credentials are resolved only inside the gateway):\n\n\`\`\`json\n${JSON.stringify(r.payload,null,2)}\n\`\`\``,options:[{label:'Approve once'},{label:'Reject'}],intent:{kind:'approval',approve:'Approve once',reject:'Reject',subject:{name:r.connector_id}}}]
   const item:Pending={receipt:r,questions}
   pending.set(id,item)
   let checking=false
   const cancel=new AbortController(),active=AbortSignal.any([signal,cancel.signal])
   const timer=setInterval(()=>{if(checking)return;checking=true;void access.principal().then(()=>access.execution()).catch(()=>cancel.abort(new SessionConnectorError())).finally(()=>{checking=false})},1000);timer.unref()
   try{
    const answer=await service.ask({agent,questions,signal:active})
    const approved=answer.answers.length===1&&answer.answers[0]?.id===id&&answer.answers[0].selected.length===1&&answer.answers[0].selected[0]==='Approve once'&&!answer.answers[0].custom
    const decision=await this.call(agent,'decide',{receipt_id:r.id,digest:r.digest,revision:r.revision,approve:approved},active)
    if(!approved)return {provenance:`external:connector/${inv.connectorId}`,outcome:'rejected'}
    const decided=receipt(decision.receipt)
    if(decided.id!==r.id||decided.digest!==r.digest||decided.status!=='approved'||decided.revision!==r.revision+1)throw new SessionConnectorError()
    return {provenance:`external:connector/${inv.connectorId}`,...await this.call(agent,'execute',{receipt_id:r.id,digest:r.digest,revision:decided.revision},active)}
   }finally{clearInterval(timer);pending.delete(id);cancel.abort()}
  }})
 }
}
