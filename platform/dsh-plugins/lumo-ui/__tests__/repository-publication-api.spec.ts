import {Readable} from 'node:stream'
import {afterEach,expect,it,vi} from 'vitest'
import {api,type Config} from '../src/index.ts'
import {gitResponse,permit} from './repository-fixtures.ts'
const config={schedulerUrl:'',projectsUrl:'',flowsUrl:'',connectorUrl:'http://connector.test',governanceUrl:'http://governance.test',registryUrl:'',realm:'realm',userId:'employee',roles:['manager'],projectId:'p',deptId:'',controlPlaneToken:'service-secret',identityAssertionSecret:'',timeoutMs:5000,deploymentMode:'cluster',storageBackend:'postgres',middleware:[],clusterStatus:'ready',plugins:[]} as Config
const endpoint='/lumo/api/tasks/task/runs/task%3Aattempt%3A1/repository-publication'
afterEach(()=>vi.unstubAllGlobals())
async function invoke(overrides:Partial<Config>={},body={repository:'attacker/repo',base_commit:'f'.repeat(40),changes:[{after:'unreviewed'}]}){
 const req=Object.assign(Readable.from([JSON.stringify(body)]),{method:'POST',url:endpoint,headers:{'content-type':'application/json','x-lumo-user':'forged'}})
 const result={status:0,body:null as unknown};const res={setHeader(){},writeHead(status:number){result.status=status},end(value?:string){if(value)result.body=JSON.parse(String(value))}}
 await api({...config,...overrides},undefined,undefined,undefined,undefined,req as never,res as never);return result
}
it('claims the exact authority permit before external I/O and ignores browser target/content fields',async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[],p=permit()
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});if(url.startsWith(config.connectorUrl)){const data=JSON.parse(String(init.body));expect(data.pathParams).toMatchObject({owner:'org',repo:'repo.test'});return Response.json({status:200,body:gitResponse(data.operation,p)})}return Response.json(url.endsWith('/complete')?{status:'draft'}:url.endsWith('/claim')?p:{...p,status:'pending'})}))
 const result=await invoke();expect(result.status).toBe(201)
 expect(calls.slice(0,2).map(x=>x.url.split('/').at(-1))).toEqual(['repository-publication','claim'])
 expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});expect(JSON.parse(String(calls[1]!.init.body))).toEqual({manifest_digest:p.manifest_digest})
 expect(calls.every(x=>!String(x.init.body).includes('attacker'))).toBe(true)
 expect(calls.at(-1)?.url).toContain('/complete');expect(calls[0]!.init.headers).toMatchObject({'X-Lumo-User':'employee'})
})
it.each(['review-denied','claim-consumed','not-ready'])('does not call Git when authority or deployment refuses: %s',async mode=>{
 const p=permit(),calls:string[]=[]
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);return url.endsWith('/claim')||mode==='review-denied'?Response.json({error:'conflict'},{status:409}):Response.json({...p,status:'pending'})}))
 const result=await invoke(mode==='not-ready'?{clusterStatus:'not_ready'}:{})
 expect(result.status).toBe(mode==='not-ready'?403:409);expect(calls.some(url=>url.startsWith(config.connectorUrl))).toBe(false)
})
it('records ambiguous external failure without retry and returns a created draft URL if final authority confirmation fails',async()=>{
 const p=permit(),calls:string[]=[];let failProvider=true
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push(url);if(url.startsWith(config.connectorUrl)){if(failProvider)throw Error('private token=secret');return Response.json({status:200,body:gitResponse(JSON.parse(String(init.body)).operation,p)})}if(url.endsWith('/complete'))return Response.json({error:'authority_unavailable'},{status:503});return Response.json(url.endsWith('/claim')?p:{...p,status:'pending'})}))
 const failed=await invoke();expect(failed.status).toBe(409);expect(JSON.stringify(failed.body)).not.toContain('secret');expect(calls.filter(url=>url.startsWith(config.connectorUrl))).toHaveLength(1)
 failProvider=false;calls.length=0
 const saved=await invoke();expect(saved.status).toBe(502);expect(saved.body).toMatchObject({url:`https://github.com/${p.repository}/pull/1`});expect(calls.filter(url=>url.endsWith('/complete'))).toHaveLength(1)
})
