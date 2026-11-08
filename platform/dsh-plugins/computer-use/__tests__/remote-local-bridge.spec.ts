import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, chmod, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage,ServerResponse } from 'node:http'
import { createRemoteComputerAuthority, readRemoteComputerDiscovery, remoteComputerHostHandler } from '../src/remote-local-bridge.ts'
const dirs:string[]=[]
afterEach(async()=>{await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
const requestID='a'.repeat(43),digest='sha256:'+'b'.repeat(64),token='t'.repeat(43)
async function fixture(){const dir=await realpath(await mkdtemp(join(tmpdir(),'lumo-bridge-')));dirs.push(dir);const file=join(dir,'bridge.json');const data={version:1,origin:'http://127.0.0.1:8088',token,realm:'test',node_id:'node'};await writeFile(file,JSON.stringify(data),{mode:0o600});return {file,dir,data}}
async function invoke(value:unknown,path='/ingest',headers:Record<string,string>={}){
 const broker={ingest:vi.fn(),revoke:vi.fn()},req=Object.assign(Readable.from([JSON.stringify(value)]),{method:'POST',url:path,headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers}}) as IncomingMessage
 let status=0,result:unknown
 const res={setHeader(){},writeHead(value:number){status=value},end(value:string){result=JSON.parse(value)}} as unknown as ServerResponse
 await remoteComputerHostHandler(token,broker)(req,res);return {broker,status,result}
}
describe('private remote-computer bridge',()=>{
 it('accepts only exact local target discovery and owner-private regular files',async()=>{
  const f=await fixture();expect(await readRemoteComputerDiscovery(f.file,'test','node')).toEqual(f.data)
  for(const patch of [{origin:'http://localhost:8088'},{origin:'http://127.0.0.1:8088/path'},{origin:'http://127.0.0.1:8088/?token=x'},{origin:'https://127.0.0.1:8088'},{realm:'other'},{node_id:'other'},{token:'short'}]){
   await writeFile(f.file,JSON.stringify({...f.data,...patch}));await expect(readRemoteComputerDiscovery(f.file,'test','node')).rejects.toThrow()
  }
  await writeFile(f.file,JSON.stringify(f.data));await chmod(f.file,0o644);await expect(readRemoteComputerDiscovery(f.file,'test','node')).rejects.toThrow()
  await chmod(f.file,0o600);const alias=join(f.dir,'alias.json');await symlink(f.file,alias);await expect(readRemoteComputerDiscovery(alias,'test','node')).rejects.toThrow()
 })
 it('never contacts authority when discovery is invalid and verifies receipt identity/size',async()=>{
  const f=await fixture(),fetcher=vi.fn(async()=>new Response(JSON.stringify({lease:{request_id:requestID,digest,state:'running',revision:2,expires_at:'2026-11-08T12:00:00Z'}})))
  const call=createRemoteComputerAuthority({bridgeFile:f.file,realm:'test',nodeId:'node',fetcher:fetcher as typeof fetch})
  expect(await call(requestID,{digest,expected_revision:1,phase:'approve'})).toMatchObject({request_id:requestID,revision:2})
  expect(fetcher.mock.calls).toHaveLength(1)
  fetcher.mockImplementation(async()=>new Response(JSON.stringify({lease:{request_id:'other',digest,state:'running',revision:2,expires_at:'2026-11-08T12:00:00Z'}})))
  await expect(call(requestID,{digest,expected_revision:1,phase:'approve'})).rejects.toThrow('INVALID')
  fetcher.mockImplementation(async()=>new Response('x'.repeat(8193)));await expect(call(requestID,{digest,expected_revision:1,phase:'approve'})).rejects.toThrow('INVALID')
  await writeFile(f.file,JSON.stringify({...f.data,origin:'http://attacker.test'}));fetcher.mockClear();await expect(call(requestID,{digest,expected_revision:1,phase:'approve'})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled()
 })
 it('denies browser origins and wrong bearer before any broker admission',async()=>{
  const envelope={version:1,request_id:requestID,digest,plan_json:'{}'}
  for(const headers of [{origin:'http://127.0.0.1:3080'},{authorization:'Bearer wrong'}]){const r=await invoke(envelope,'/ingest',headers);expect(r.status).toBe(403);expect(r.broker.ingest).not.toHaveBeenCalled()}
  const r=await invoke(envelope);expect(r.status).toBe(200);expect(r.broker.ingest).toHaveBeenCalledExactlyOnceWith(envelope)
 })
 it('accepts only bounded immutable envelopes and distinct revoke commands',async()=>{
  const envelope={version:1,request_id:requestID,digest,plan_json:'{}'}
  for(const data of [{...envelope,owner_user_id:'forged'},{...envelope,request_id:'../../x'},{...envelope,digest:'b'.repeat(64)},{...envelope,plan_json:'x'.repeat(24577)}]){const r=await invoke(data);expect(r.status).toBe(400);expect(r.broker.ingest).not.toHaveBeenCalled()}
  const r=await invoke({version:1,request_id:requestID,digest},'/revoke');expect(r.status).toBe(200);expect(r.broker.revoke).toHaveBeenCalledExactlyOnceWith(requestID,digest)
  expect((await invoke(envelope,'/revoke')).status).toBe(400)
 })
})
