import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'

const config={schedulerUrl:'',projectsUrl:'',flowsUrl:'',connectorUrl:'',governanceUrl:'http://governance.test',registryUrl:'',realm:'r1',userId:'employee',roles:['manager'],projectId:'p',deptId:'',controlPlaneToken:'service-secret',identityAssertionSecret:'',timeoutMs:5000,deploymentMode:'standalone',storageBackend:'postgres',middleware:[],clusterStatus:'not_ready',plugins:[]} as Config
const base='/lumo/api/tasks/task/runs/task%3Aattempt%3A1/artifacts'
const bytes=Buffer.from('Original immutable artifact'),digest=createHash('sha256').update(bytes).digest('hex')
const key=`r1/managed-content/v1/11111111-2222-4333-8444-555555555555/${digest}`
afterEach(()=>vi.unstubAllGlobals())
async function invoke(store:object,method='POST',path=base,body=bytes){
 const req=Object.assign(Readable.from([body]),{method,url:path,headers:{'content-type':'application/pdf','x-lumo-file-name':'report.pdf','x-lumo-user':'forged'}})
 const result={status:0,body:null as unknown,headers:{} as Record<string,string>}
 const res={setHeader(){},writeHead(status:number,headers?:Record<string,string>){result.status=status;result.headers=headers??{}},end(chunk?:string|Buffer){if(!chunk)return;try{result.body=JSON.parse(String(chunk))}catch{result.body=Buffer.from(chunk)}}}
 await api(config,undefined,undefined,undefined,undefined,req as never,res as never,undefined,undefined,store as never)
 return result
}
function objects(){return {managedContent:{put:vi.fn(async()=>({objectKey:key})),abandon:vi.fn(async()=>true)},putContent:vi.fn(),get:vi.fn(async()=>({body:bytes}))}}
describe('managed task artifact host lifecycle',()=>{
 it('uses the server artifact reservation as the managed identity and completes with exact immutable bytes',async()=>{
  const store=objects(),calls:Array<{url:string;init:RequestInit}>=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(url.endsWith('/complete')?{id:'artifact',status:'ready'}:{id:'artifact'})}))
  expect((await invoke(store)).status).toBe(200)
  expect(store.managedContent.put).toHaveBeenCalledExactlyOnceWith({realm:'r1',kind:'task-artifact',referenceId:'artifact'},bytes,'application/pdf')
  expect(store.putContent).not.toHaveBeenCalled();expect(store.managedContent.abandon).not.toHaveBeenCalled()
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({storage_key:key,sha256:digest,size_bytes:bytes.length})
  expect(calls[1]!.init.headers).toMatchObject({'X-Lumo-User':'employee','X-Lumo-Realm':'r1'})
 })
 it('fails closed if managed storage is not provisioned',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
  expect((await invoke({putContent:vi.fn()})).status).toBe(503);expect(fetcher).not.toHaveBeenCalled()
 })
 it('compensates rejected metadata and keeps a successful authoritative pin safe via abandon semantics',async()=>{
  const store=objects();vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/complete')?Response.json({error:'storage_quota_exceeded'},{status:413}):Response.json({id:'artifact'})))
  expect((await invoke(store)).status).toBe(413)
  expect(store.managedContent.abandon).toHaveBeenCalledExactlyOnceWith({realm:'r1',kind:'task-artifact',referenceId:'artifact'})
 })
 it('does not expose provider exceptions and attempts explicit safe abandonment',async()=>{
  const store=objects();store.managedContent.put.mockRejectedValueOnce(Error('provider token=private-secret'))
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'artifact'})))
  const result=await invoke(store);expect(result.status).toBe(503);expect(JSON.stringify(result.body)).not.toContain('private-secret');expect(store.managedContent.abandon).toHaveBeenCalledOnce()
 })
 it.each([key,`content/${digest}`])('reads both managed and historical relative object keys: %s',async storage_key=>{
  const store=objects();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({storage_key,sha256:digest,size_bytes:bytes.length,name:'report.pdf',content_type:'application/pdf'})))
  const result=await invoke(store,'GET',base+'/artifact/content')
  expect(result.status).toBe(200);expect(result.body).toEqual(bytes);expect(store.get).toHaveBeenCalledExactlyOnceWith('r1',storage_key.startsWith('r1/')?storage_key.slice(3):storage_key)
 })
 it('forwards withdrawal reason and digest with the trusted current identity',async()=>{
  const fetcher=vi.fn(async()=>Response.json({withdrawn:true}));vi.stubGlobal('fetch',fetcher)
  const result=await invoke(objects(),'DELETE',base+'/artifact',Buffer.from(JSON.stringify({reason:'Wrong upload',expected_sha256:digest})))
  expect(result.status).toBe(200);expect(fetcher).toHaveBeenCalledWith('http://governance.test/v1/tasks/task/runs/task%3Aattempt%3A1/artifacts/artifact',expect.objectContaining({method:'DELETE',headers:expect.objectContaining({'X-Lumo-User':'employee'})}))
 })
})
