import {Readable} from 'node:stream'
import {afterEach,expect,it,vi} from 'vitest'
import {api,type Config} from '../src/index.ts'
import {reconcileReviewedRepository} from '../src/repository-publication.ts'
import {permit} from './repository-fixtures.ts'
vi.mock('../src/repository-publication.ts',async original=>({...await original<typeof import('../src/repository-publication.ts')>(),reconcileReviewedRepository:vi.fn()}))
const config={schedulerUrl:'',projectsUrl:'',flowsUrl:'',connectorUrl:'http://connector.test',governanceUrl:'http://governance.test',registryUrl:'',realm:'realm',userId:'employee',roles:['manager'],projectId:'p',deptId:'',controlPlaneToken:'service-secret',identityAssertionSecret:'',timeoutMs:5000,deploymentMode:'cluster',storageBackend:'postgres',middleware:[],clusterStatus:'ready',plugins:[]} as Config
const endpoint='/lumo/api/tasks/task/runs/task%3Aattempt%3A1/repository-publication'
afterEach(()=>{vi.unstubAllGlobals();vi.mocked(reconcileReviewedRepository).mockReset()})
async function invoke(method='POST',suffix='/reconcile'){
 const req=Object.assign(Readable.from([JSON.stringify({id:'forged',repository:'attacker/repo',outcome:'confirmed'})]),{method,url:endpoint+suffix,headers:{'content-type':'application/json'}})
 const result={status:0,body:null as unknown};const res={setHeader(){},writeHead(status:number){result.status=status},end(value?:string){if(value)result.body=JSON.parse(String(value))}}
 await api(config,undefined,undefined,undefined,undefined,req as never,res as never);return result
}
it.each(['confirmed','unknown'] as const)('prepares, reads and persists %s against the authority revision without using browser fields',async outcome=>{
 const p={...permit(),reconciliation_revision:3},calls:Array<{url:string;init:RequestInit}>=[]
 vi.mocked(reconcileReviewedRepository).mockImplementation(async(value,read)=>{expect(value).toEqual(p);await read('list_pull_requests',{owner:'org',repo:'repo.test'},undefined,{head:'org:approved'});return outcome==='confirmed'?{outcome,reason:'confirmed',url:'https://github.com/org/repo.test/pull/1'}:{outcome,reason:'provider_unavailable'}})
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});if(url.startsWith(config.connectorUrl))return Response.json({status:200,body:[]});return Response.json(init.method==='PUT'?{status:'draft',reconciliation:outcome}:p)}))
 const result=await invoke();expect(result.status).toBe(200);expect(result.body).toMatchObject({reconciliation:outcome})
 expect(calls).toHaveLength(3);expect(calls[0]!.url).toBe('http://governance.test/v1/tasks/task/runs/task%3Aattempt%3A1/repository-publication/reconcile')
 expect(JSON.parse(String(calls[0]!.init.body))).toEqual({})
 expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({operation:'list_pull_requests',query:{head:'org:approved'}})
 expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({manifest_digest:p.manifest_digest,revision:3,outcome})
 expect(calls[2]!.url).toContain(`/${p.id}/reconcile`);expect(calls.every(call=>!String(call.init.body).includes('attacker'))).toBe(true)
})
it('blocks provider reads before authority approval and rejects a revoked post-read authority result',async()=>{
 let denyBefore=true;const p={...permit(),reconciliation_revision:0},calls:string[]=[]
 vi.mocked(reconcileReviewedRepository).mockResolvedValue({outcome:'confirmed',reason:'confirmed',url:'https://github.com/org/repo.test/pull/1'})
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push(url);return denyBefore||init.method==='PUT'?Response.json({error:'forbidden'},{status:403}):Response.json(p)}))
 expect((await invoke()).status).toBe(403);expect(reconcileReviewedRepository).not.toHaveBeenCalled()
 denyBefore=false;calls.length=0
 const result=await invoke();expect(result.status).toBe(403);expect(result.body).not.toMatchObject({reconciliation:'confirmed'});expect(reconcileReviewedRepository).toHaveBeenCalledOnce();expect(calls).toHaveLength(2)
})
it('proxies publication status without claims, reads or writes',async()=>{
 const fetch=vi.fn(async()=>Response.json({status:'publishing',reconciliation:'unknown',reconciliation_revision:4}));vi.stubGlobal('fetch',fetch)
 expect((await invoke('GET','')).body).toMatchObject({status:'publishing',reconciliation_revision:4});expect(fetch).toHaveBeenCalledOnce();expect(reconcileReviewedRepository).not.toHaveBeenCalled()
})
