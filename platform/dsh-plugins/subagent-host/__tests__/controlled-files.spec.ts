import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter,ToolCallId,type GenerateOptions,type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { afterEach,expect,it,vi } from 'vitest'
import { ControlledFiles,CLOSED_FILES_PROFILE,CONTROLLED_FILE_TOOL } from '../src/controlled-files.ts'
import { runGovernedTask } from '../src/governed-run.ts'
import { prepareGovernedRun,type PreparedRun } from '../src/run-review.ts'
import { binding,config,execution } from './governed-fixtures.ts'

const textFile={name:'report.md',media_type:'text/markdown; charset=utf-8',text:'# 完整文件\nEvery byte'}
const contexts:Context[]=[]
afterEach(async()=>{for(const ctx of contexts.splice(0))await ctx.fiber.dispose()})
function prepared(profile:'platform-closed-text-v1'|'platform-closed-text-files-v1'='platform-closed-text-v1'):PreparedRun{
 return {snapshot:{realm:config.realm,task_id:'task-run-1',run_id:'run-1',worker_id:`agent:${binding.agentId}`,node_id:config.nodeId,session_ref:'session-run-1',preset_id:binding.agentId,preset_revision:binding.presetRevision,provider:binding.provider,model:binding.model,output_profile:profile}}
}
it('enumerates the complete private file set, rejects overwrites and seals late tool writes',()=>{
 const files=new ControlledFiles()
 expect(files.add(textFile)).toEqual({name:'report.md',bytes:Buffer.byteLength(textFile.text)})
 expect(()=>files.add({...textFile,name:'REPORT.md'})).toThrow('overwritten')
 expect(files.seal()).toEqual([textFile])
 expect(()=>files.add({...textFile,name:'later.md'})).toThrow('sealed')
})
it('rejects paths, executable formats, URL references, invalid bytes, size and aggregate limits',()=>{
 for(const patch of [{name:'../../secret.txt'},{name:'run.sh'},{name:'bad.txt',media_type:'text/html'},{text:'\0'},{text:'\ud800'},{text:'x'.repeat(32769)},{url:'https://example.com/file'},{name:'bad.json',media_type:'application/json',text:'invalid'}]){
  expect(()=>new ControlledFiles().add({...textFile,...patch})).toThrow()
 }
 const files=new ControlledFiles()
 for(let i=0;i<8;i++)files.add({name:`a${i}.txt`,media_type:'text/plain; charset=utf-8',text:'x'.repeat(32768)})
 expect(()=>files.add({name:'too-many-bytes.txt',media_type:'text/plain; charset=utf-8',text:'x'})).toThrow('256 KiB')
})
it('executes only the controlled generation tool through the public Agent API and enumerates actual outputs',async()=>{
 const ctx=new Context();contexts.push(ctx);await mountAgentLoopTestDependencies(ctx);await ctx.plugin(AgentLoop,{agents:[]})
 const warnings:unknown[][]=[];vi.spyOn(ctx.logger,'warn').mockImplementation((...args)=>{warnings.push(args)})
 let hostCalls=0
 ctx.tools.register({name:'host_side_effect',description:'forbidden',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{hostCalls++;return {}}})
 const requests:GenerateOptions[]=[]
 ctx.llm.registerAdapter(['mock'],new(class extends LlmAdapter{
  override async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
   requests.push(options)
   if(requests.length<=2){const name=requests.length===1?'host_side_effect':CONTROLLED_FILE_TOOL,id=ToolCallId(`file-call-${requests.length}`),args=JSON.stringify(requests.length===1?{}:textFile);yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}}}
   else{yield {type:'text-delta',index:0,text:'Delivered report.md'};yield {type:'finish',reason:{kind:'stop'}}}
  }
 })())
 const item=execution();item.preset.output_profile=CLOSED_FILES_PROFILE
 const result=await runGovernedTask(ctx,item,binding,config.nodeId,new AbortController().signal,undefined,async()=>prepared(CLOSED_FILES_PROFILE))
 expect(result,JSON.stringify(warnings.map(args=>args.map(arg=>String(arg))))).toMatchObject({state:'COMPLETED',files:[textFile]})
 expect(hostCalls).toBe(0)
 expect(requests).toHaveLength(3)
 expect(requests[0]!.tools?.map(tool=>tool.name)).toEqual([CONTROLLED_FILE_TOOL])
 const prompt=requests[0]!.messages.filter(message=>message.source.kind==='runtime-context').flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])).join('\n')
 expect(prompt).toContain('requires at least one actual file deliverable')
 expect(prompt).toContain(`call ${CONTROLLED_FILE_TOOL} successfully`)
 expect(prompt).toContain('32768 UTF-8 bytes (32 KiB)')
 expect(prompt).toContain('at most 16 files and 256 KiB total')
 expect(prompt).toContain('unique safe ASCII leaf filenames ending in .txt, .md, .csv or .json')
 expect(prompt).toContain('Finish with a text summary naming the files actually generated')
 expect(prompt).toContain(`only successful ${CONTROLLED_FILE_TOOL} calls count`)
})
it('independently fetches every complete manifest file and keeps server read receipts out of the model evidence',async()=>{
 const entry={id:'file-0001',name:textFile.name,media_type:textFile.media_type,bytes:Buffer.byteLength(textFile.text),sha256:createHash('sha256').update(textFile.text).digest('hex')}
 const receipt='c'.repeat(64),value=prepared()
 const second={id:'file-0002',name:'other.txt',media_type:'text/plain; charset=utf-8',bytes:6,sha256:createHash('sha256').update('second').digest('hex')}
 value.review={producer_task_id:'producer',producer_run_id:'run-p',producer_intent:'Read every complete file',manifest_digest:'a'.repeat(64),manifest:{scope:CLOSED_FILES_PROFILE,task_id:'producer',run_id:'run-p',summary:'all files',entries:[{id:'output-0001',sha256:'b'.repeat(64),text:'delivered'}],files:[entry,second]},expires_at:new Date(Date.now()+3600000).toISOString()}
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/prepare')?Response.json(value):Response.json(String(input).endsWith(second.id)?{...second,text:'second',receipt}:{...entry,text:textFile.text,receipt}))
 const actual=await prepareGovernedRun(config,execution(),fetcher)
 expect(actual.review?.read_files).toEqual([{...entry,text:textFile.text},{...second,text:'second'}])
 expect(actual.reviewFileReceipts).toEqual([{id:entry.id,receipt},{id:second.id,receipt}])
 expect(fetcher).toHaveBeenCalledTimes(3)
 expect(JSON.stringify(actual.review)).not.toContain(receipt)
 expect(fetcher.mock.calls[1]?.[0]).toContain('/run-1/review-files/file-0001')
 for(const patch of [{text:'same metadata, different content'},{bytes:1},{receipt:'self-proven'}]){
  await expect(prepareGovernedRun(config,execution(),async input=>String(input).endsWith('/prepare')?Response.json(value):Response.json({...entry,text:textFile.text,receipt,...patch}))).rejects.toThrow()
 }
 await expect(prepareGovernedRun(config,execution(),async input=>String(input).endsWith('/prepare')?Response.json(value):String(input).endsWith(second.id)?new Response('missing',{status:404}):Response.json({...entry,text:textFile.text,receipt}))).rejects.toThrow('404')
})
