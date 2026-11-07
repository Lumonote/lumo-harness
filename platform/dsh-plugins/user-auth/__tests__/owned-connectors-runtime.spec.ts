import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
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
import UserQuestionService from '@deepseek-ai/dsh-user-questions'


const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const alice: Principal = { realm:'r',user_id:'alice',username:'alice',display_name:'Alice',roles:['operator'],session_expires_at:'2099-01-01' }
const signal=new AbortController().signal
it('requires exact authenticated native owner approval through real Gateway and AgentLoop',async()=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'owned-connectors-')));closers.push(()=>rm(temp,{recursive:true,force:true}))
 const ctx=new Context();closers.push(()=>ctx.fiber.dispose())
 const ref=`session-${'a'.repeat(32)}`
 const fact:SessionOwner={session_ref:ref,realm:'r',owner_user_id:'alice',project_id:'p',node_id:'n',parent_session_ref:'',state:'reserved',created_at:'2026-11-07'}
 const calls:Array<{action:string;body:Record<string,unknown>}>=[], requests:GenerateOptions[]=[]
 const receipt={id:'b'.repeat(48),connector_id:'issues',operation:'create',connector_version:2,payload:{operation:'create',body:{title:'exact business'}},digest:'c'.repeat(64),revision:1,status:'pending',expires_at:new Date(Date.now()+60000).toISOString()}
 const fetcher:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,input=init?.body?JSON.parse(String(init.body)):{}
  if(path.includes('/v1/session-execution/'))return new Response(JSON.stringify(path.includes('/nodes/')?{node:{...input,fence:1,expires_at:'2099-01-01'}}:{lease:{...input,session_ref:ref,node_fence:1,fencing_token:1,expires_at:'2099-01-01'}}))
  if(path.startsWith('/owned/')){
   expect((init?.headers as Record<string,string>)['X-Lumo-Login-Session']).toBe('login-secret')
   expect(String(init?.body)).not.toContain('login-secret')
   const action=path.split('/').at(-1)!;calls.push({action,body:input})
   if(action==='prepare')return new Response(JSON.stringify({receipt}))
   if(action==='decide')return new Response(JSON.stringify({receipt:{...receipt,status:'approved',revision:2}}))
   if(action==='execute')return new Response(JSON.stringify({result:{status:201,body:{created:true}},outcome:'succeeded'}))
   throw Error('unexpected connector action')
  }
  if(path.endsWith('/activate'))fact.state='active'
  return new Response(JSON.stringify(path==='/v1/session-owners'?{owner:fact,creation_token:'d'.repeat(64)}:{owner:fact}))
 }
 await ctx.plugin(TypertRegistry);await mountAgentLoopTestDependencies(ctx,{workingDirectory:true})
 await ctx.plugin(JsonlPersistence,{root:join(temp,'sessions'),compression:'none'});await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(UserQuestionService)
 ctx.llm.registerAdapter(['mock'],new(class extends LlmAdapter{override async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  requests.push(options)
  if(requests.length===1){const id=ToolCallId('create-external'),args=JSON.stringify({connectorId:'issues',operation:'create',body:{title:'exact business'}})
   yield {type:'tool-call-delta',index:0,id,name:'user_connector_invoke',argumentsDelta:args};yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'user_connector_invoke',arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}}
  }else{yield {type:'text-delta',index:0,text:'Created'};yield {type:'finish',reason:{kind:'stop'}}}
 }} )())
 await ctx.plugin(RemoteAccess);await ctx.plugin(Gateway)
 ctx.provide('connection',{createPeer:options=>{expect(options.interactions).toBe('none');return new Peer(ctx,options)}} as never)
 ctx.provide('meteringScope',new SessionMeterRegistry());ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'mock',model:'mock'}),saveSelection:async()=>{}} as never)
 ctx.provide('attachments',{imageLimits:{maxImageBytes:1000,maxImagesPerMessage:1,maxMessageImageBytes:1000,maxImagePixels:1000,maxImageDimension:1000,mediaTypes:[]},admitPromptContent:async content=>content} as never)
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},resolve:()=>undefined,bindPrompt:()=>({commit(){},[Symbol.dispose](){}}),retirePrompt(){}} as never)
 ctx.provide('workspaceRegistry',{archivedSessionIds:[],get:()=>undefined} as never)
 new QueryEngine(ctx);class TestController extends Controller{initialize(){return this[Service.init]()}};await new TestController(ctx,{nativeOpen:false}).initialize()
 const schema=z.object({sessionId:z.string(),requestId:z.string(),content:z.array(z.object({type:z.literal('text'),text:z.string()})),mode:z.literal('queue')})
 ctx.typert.register({package:'@lumo/owned-connector-test',face:'host',schemas:[],model:{services:[],events:[],objects:[]},invocations:[{id:'@lumo/owned-connector-test#session/prompt',service:'sessionController',namespace:'session',method:'prompt',invocation:{kind:'direct'},parameters:[{name:'request',wire:'request',source:'json',codec:{mode:'strict',typeSymbol:'@lumo/owned#Prompt',create:()=>schema}}],cancellation:{parameter:'signal'},result:{mode:'strict',typeSymbol:'@lumo/owned#Result',create:()=>z.object({accepted:z.literal(true)})}}]})
 const transport=createSessionTransport(ctx,{authorityUrl:'http://owner',nodeId:'n',projectId:'p',workspaceRoot:join(temp,'workspaces'),provider:'mock',model:'mock',connectors:{realm:'r',gatewayUrl:'http://gateway',actions:[{connectorId:'issues',operations:['create']}]}},'service-token',async()=>{},fetcher,{realm:'r',writerHolder:'writer',endpoint:''})
 const authority=Object.assign(async()=>alice,{credential:'login-secret'})
 await transport.execute(alice,'create',{},signal,authority)
 await transport.execute(alice,'prompt',{sessionId:ref,requestId:'first',content:[{type:'text',text:'Create an issue'}],mode:'queue'},signal,authority)
 let pending:{questionId:string;receiptId:string;digest:string;revision:number}|undefined
 await vi.waitFor(async()=>{const view=await transport.execute(alice,'interactionList',{sessionId:ref},signal,authority) as {questions:typeof pending[]};const current=view.questions[0];expect(current).toBeDefined();pending={questionId:current!.questionId,receiptId:current!.receiptId,digest:current!.digest,revision:current!.revision}})
 expect(calls.map(c=>c.action)).toEqual(['prepare'])
 await expect(transport.execute({...alice,user_id:'bob'},'interactionAnswer',{sessionId:ref,answer:{...pending,decision:'approve'}},signal,async()=>({...alice,user_id:'bob'}))).rejects.toThrow()
 await expect(transport.execute(alice,'interactionAnswer',{sessionId:ref,answer:{...pending,digest:'forged',decision:'approve'}},signal,authority)).rejects.toThrow()
 await expect(transport.execute(alice,'interactionAnswer',{sessionId:ref,answer:{...pending,decision:'approve'}},signal,authority)).resolves.toEqual({accepted:true})
 await ctx.agents.get(SessionId(ref))!.whenIdle()
 expect(calls.map(c=>c.action)).toEqual(['prepare','decide','execute'])
 expect(calls[2]!.body).not.toHaveProperty('invocation')
 expect(calls[2]!.body).toMatchObject({receipt_id:receipt.id,digest:receipt.digest,revision:2,execution:{node_id:'n',node_fence:1,writer_holder:'writer',fencing_token:1}})
 await expect(transport.execute(alice,'interactionAnswer',{sessionId:ref,answer:{...pending,decision:'approve'}},signal,authority)).rejects.toThrow()
 expect(requests[0]!.tools?.map(tool=>tool.name).sort()).toEqual(['user_connector_invoke','user_connector_list'])
 expect(JSON.stringify(ctx.agents.get(SessionId(ref))!.session.snapshotEvents())).not.toContain('login-secret')
})
