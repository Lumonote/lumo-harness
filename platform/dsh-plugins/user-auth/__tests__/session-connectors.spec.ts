import { describe,it,expect,vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition,ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { SessionConnectorTools,validateSessionConnectors } from '../src/session-connectors.ts'

const alice={realm:'r',user_id:'alice',roles:['operator'],username:'alice',display_name:'Alice',session_expires_at:'2099-01-01'}
const config={realm:'r',gatewayUrl:'https://gateway.example',actions:[{connectorId:'issues',operations:['read','create']}]}
function fixture(native?:Context){
 const tools=new Map<string,ToolDefinition>(),callbacks=new Map<string,Function>(),abort=new AbortController()
 let revoked=false
 const principal=vi.fn(async()=>{if(revoked)throw new Error('revoked');return alice})
 const execution=vi.fn(async()=>({node_id:'n',process_id:'process',node_fence:1,writer_holder:'writer',fencing_token:1}))
 const receipt={id:'a'.repeat(48),connector_id:'issues',operation:'create',connector_version:3,payload:{operation:'create',body:{title:'hello'}},digest:'b'.repeat(64),revision:1,status:'pending',expires_at:new Date(Date.now()+60000).toISOString()}
 const service=native?.userQuestions??{ask:vi.fn(async(request:unknown)=>callbacks.get('user-questions/request')!(request,async()=>{throw new Error('no provider')}))}
 const ctx={get:(name:string)=>name==='userQuestions'?service:undefined,on:native?native.on.bind(native):(name:string,cb:Function)=>{callbacks.set(name,cb)},effect:native?native.effect.bind(native):vi.fn(),tools:{register:(tool:ToolDefinition)=>{tools.set(tool.name,tool)}}}
 const agent={id:`session-${'c'.repeat(32)}`,session:{id:`session-${'c'.repeat(32)}`,header:{}},ctx} as unknown as Agent
 const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  expect(String(url)).toMatch(/^https:\/\/gateway\.example\/owned\/sessions\/session-[a-f0-9]{32}\//u)
  expect(init?.redirect).toBe('error')
  const body=JSON.parse(String(init?.body));expect(body.execution.node_fence).toBe(1);expect(body.project_id).toBe('p')
  expect(String(init?.body)).not.toContain('login-secret');expect((init?.headers as Record<string,string>)['X-Lumo-Login-Session']).toBe('login-secret')
  const action=String(url).split('/').at(-1)
  if(action==='list')return new Response('{"connectors":[]}')
  if(action==='prepare')return new Response(JSON.stringify({receipt}))
  if(action==='decide')return new Response(JSON.stringify({receipt:{...receipt,status:body.approve?'approved':'rejected',revision:2}}))
  if(action==='execute')return new Response('{"result":{"status":200,"body":{"created":true}},"outcome":"succeeded"}')
  throw new Error('invalid action')
 })
 const manager=new SessionConnectorTools(config,'service-secret','p',()=>({principal,credential:()=> 'login-secret',execution,signal:abort.signal}),fetcher as typeof fetch)
 manager.install(agent)
 const run=(args:unknown)=>tools.get('user_connector_invoke')!.execute!(args,{agent,signal:new AbortController().signal} as ToolRunContext)
 const wait=async()=>{for(let i=0;i<30;i++){if((await manager.list(agent)).questions.length)return;await Promise.resolve()};throw new Error('no question')}
 return {manager,agent,run,fetcher,receipt,service,principal,execution,abort,wait,revoke:()=>{revoked=true}}
}
describe('owned connector consent and native interaction bridge',()=>{
 it('uses the real native service scoped waterfall without granting the browser carrier interactions',async()=>{
  const ctx=new Context();await ctx.plugin(UserQuestionService)
  const f=fixture(ctx);ctx.provide('agents',{get:()=>f.agent} as never)
  try{
   const ask=vi.spyOn(ctx.userQuestions,'ask'),pending=Promise.resolve(f.run({connectorId:'issues',operation:'create',body:{title:'native'}}))
   await f.wait();const q=(await f.manager.list(f.agent)).questions[0]!
   await f.manager.answer(f.agent,{questionId:q.questionId,receiptId:q.receiptId,digest:q.digest,revision:q.revision,decision:'approve'})
   await expect(pending).resolves.toMatchObject({outcome:'succeeded'})
   expect(ask).toHaveBeenCalledOnce();expect(ask.mock.calls[0]?.[0].agent).toBe(f.agent)
  }finally{await ctx.fiber.dispose()}
 })
 it('freezes exact payload, requires matching human question and consumes once after approval',async()=>{
  const f=fixture(),pending=Promise.resolve(f.run({connectorId:'issues',operation:'create',body:{title:'hello'}}))
  await f.wait()
  const view=await f.manager.list(f.agent),q=view.questions[0]!
  expect(q.questions[0]?.intent?.kind).toBe('approval')
  expect(q.questions[0]?.detail).toContain('"title": "hello"')
  expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/execute'))).toHaveLength(0)
  await expect(f.manager.answer(f.agent,{questionId:q.questionId,receiptId:q.receiptId,digest:'wrong',revision:1,decision:'approve'})).rejects.toThrow()
  const decision={questionId:q.questionId,receiptId:q.receiptId,digest:q.digest,revision:q.revision,decision:'approve'}
  expect(await f.manager.answer(f.agent,decision)).toEqual({accepted:true})
  await expect(f.manager.answer(f.agent,decision)).rejects.toThrow()
  await expect(pending).resolves.toMatchObject({outcome:'succeeded',result:{body:{created:true}}})
  expect(f.service.ask).toHaveBeenCalledOnce()
  expect(f.fetcher.mock.calls.map(([url])=>String(url).split('/').at(-1))).toEqual(['prepare','decide','execute'])
 })
 it('rejects unapproved actions, model-supplied approval, headers and caller URLs before I/O',async()=>{
  const f=fixture()
  for(const args of [{connectorId:'other',operation:'read'},{connectorId:'issues',operation:'delete'},{connectorId:'issues',operation:'create',approve:true},{connectorId:'issues',operation:'read',headers:{Authorization:'x'}},{connectorId:'issues',operation:'read',url:'https://evil'}])await expect(f.run(args)).rejects.toThrow()
  expect(f.fetcher).not.toHaveBeenCalled()
 })
 it('rejects once without dispatch and denies answers after current authorization is revoked',async()=>{
  const f=fixture(),pending=Promise.resolve(f.run({connectorId:'issues',operation:'create',body:{title:'hello'}}))
  await f.wait();const q=(await f.manager.list(f.agent)).questions[0]!
  await f.manager.answer(f.agent,{questionId:q.questionId,receiptId:q.receiptId,digest:q.digest,revision:1,decision:'reject'})
  await expect(pending).resolves.toMatchObject({outcome:'rejected'})
  expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/execute'))).toBe(false)
  f.revoke();await expect(f.manager.list(f.agent)).rejects.toThrow('revoked')
 })
 it('aborts native approval on execution lease loss and never executes the receipt',async()=>{
  const f=fixture(),pending=Promise.resolve(f.run({connectorId:'issues',operation:'create',body:{title:'hello'}}))
  await f.wait();f.abort.abort(new Error('execution fenced'))
  await expect(pending).rejects.toThrow('execution fenced')
  expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith('/execute'))).toBe(false)
 })
 it('validates explicit deployment action lists',()=>{
  expect(()=>validateSessionConnectors(config,'r')).not.toThrow()
  for(const value of [{...config,realm:'foreign'},{...config,gatewayUrl:'https://user:secret@gateway.example'},{...config,actions:[]},{...config,actions:[{connectorId:'issues',operations:['read','read']}]}])expect(()=>validateSessionConnectors(value,'r')).toThrow()
 })
 it.each([[403,'owned_connector_denied','session_connector_denied'],[409,'owned_connector_changed','session_connector_changed'],[429,'rate_limited','session_connector_busy'],[503,'owned_connector_unavailable','session_connector_unavailable']] as const)('classifies prepare %s and suppresses private gateway messages',async(status,remote,code)=>{
  const f=fixture();f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error:remote,message:'login-secret private endpoint'}),{status,headers:{'retry-after':'9'}}))
  const failure=await Promise.resolve(f.run({connectorId:'issues',operation:'read'})).catch(error=>error)
  expect(failure).toMatchObject({status,code});expect(failure.message).not.toMatch(/login-secret|private/u)
  expect(f.fetcher).toHaveBeenCalledOnce();if(status===429)expect(failure.retryAfter).toBe(9)
 })
 it.each(['network','malformed','unknown','dependency'] as const)('does not invite replay after execute %s failure',async kind=>{
  const f=fixture(),original=f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async(url,init)=>{
   if(!String(url).endsWith('/execute'))return original(url,init)
   if(kind==='network')throw Error('login-secret remote network detail')
   if(kind==='malformed')return new Response('unreadable')
   return new Response(JSON.stringify({error:kind==='unknown'?'connector_outcome_unknown':'owned_connector_unavailable',message:'login-secret'}),{status:kind==='unknown'?502:503})
  })
  const pending=Promise.resolve(f.run({connectorId:'issues',operation:'create'})).catch(error=>error)
  await f.wait();const q=(await f.manager.list(f.agent)).questions[0]!
  await f.manager.answer(f.agent,{questionId:q.questionId,receiptId:q.receiptId,digest:q.digest,revision:q.revision,decision:'approve'})
  const failure=await pending;expect(failure).toMatchObject({code:'connector_outcome_unknown',status:502,retryable:false,retryAfter:0});expect(failure.message).not.toContain('login-secret')
  expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/execute'))).toHaveLength(1)
  expect((await f.manager.list(f.agent)).questions).toEqual([])
 })
})
