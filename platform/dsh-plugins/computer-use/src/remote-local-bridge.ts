/** Private local transport only. Device credentials remain inside desktop-agent. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { RemoteComputerEnvelope, RemoteComputerLease, RemoteComputerLeaseInput } from '../../../shared/seam-contracts/remote-computer.ts'
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/u.test(v)
const digest=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/u.test(v)
interface Discovery { version:1; origin:string; token:string; realm:string; node_id:string }
function discovery(v:unknown,realm:string,nodeId:string):Discovery {
 if(!object(v)||v.version!==1||v.realm!==realm||v.node_id!==nodeId||!id(v.token)||typeof v.origin!=='string')throw Error('REMOTE_COMPUTER_BRIDGE_INVALID')
 const url=new URL(v.origin)
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==v.origin)throw Error('REMOTE_COMPUTER_BRIDGE_INVALID')
 return v as unknown as Discovery
}
async function privateDirectory(file:string):Promise<void>{
 if(!isAbsolute(file)||file.includes('\0'))throw Error('REMOTE_COMPUTER_PRIVATE_PATH_REQUIRED')
 const parent=dirname(file),stat=await lstat(parent)
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(parent)!==resolve(parent)||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw Error('REMOTE_COMPUTER_PRIVATE_PATH_REQUIRED')
}
export async function readRemoteComputerDiscovery(file:string,realm:string,nodeId:string):Promise<Discovery>{
 await privateDirectory(file)
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
 try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>4096||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid?.())))throw Error('REMOTE_COMPUTER_PRIVATE_PATH_REQUIRED');return discovery(JSON.parse(await handle.readFile('utf8')),realm,nodeId)}finally{await handle.close()}
}
export function createRemoteComputerAuthority(options:{bridgeFile:string;realm:string;nodeId:string;fetcher?:typeof fetch}){
 return async(requestID:string,input:RemoteComputerLeaseInput):Promise<RemoteComputerLease>=>{
  if(!id(requestID)||!digest(input.digest))throw Error('REMOTE_COMPUTER_INVALID_REQUEST')
  const target=await readRemoteComputerDiscovery(options.bridgeFile,options.realm,options.nodeId)
  const response=await(options.fetcher??fetch)(`${target.origin}/lease/${requestID}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+target.token,'content-type':'application/json'},body:JSON.stringify(input)})
  if(!response.ok){void response.body?.cancel();throw Error('REMOTE_COMPUTER_AUTHORITY_UNAVAILABLE')}
  const reader=response.body?.getReader();if(!reader)throw Error('REMOTE_COMPUTER_AUTHORITY_INVALID')
  const chunks:Uint8Array[]=[];let size=0
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192)throw Error('REMOTE_COMPUTER_AUTHORITY_INVALID');chunks.push(part.value)}}finally{await reader.cancel().catch(()=>{})}
  const raw:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8')),value=object(raw)&&object(raw.lease)?raw.lease:raw
  if(!object(value)||value.request_id!==requestID||value.digest!==input.digest||!['pending','running','completed','failed','denied','cancelled','unknown'].includes(String(value.state))||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at)))throw Error('REMOTE_COMPUTER_AUTHORITY_INVALID')
  return {request_id:requestID,digest:input.digest,state:value.state as RemoteComputerLease['state'],revision:Number(value.revision),expires_at:value.expires_at}
 }
}
interface LocalBroker { ingest(envelope:RemoteComputerEnvelope):unknown|Promise<unknown>; revoke(id:string,digest:string):unknown|Promise<unknown> }
function send(res:ServerResponse,status:number,value:unknown){res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.writeHead(status);res.end(JSON.stringify(value))}
export function remoteComputerHostHandler(token:string,broker:LocalBroker){return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
 const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token)
 if(req.headers.origin!==undefined||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){send(res,403,{error:'local_bridge_denied'});return}
 if(req.method!=='POST'||!['/ingest','/revoke'].includes(req.url??'')){send(res,404,{error:'local_bridge_endpoint'});return}
 if(!/^application\/json(?:\s*;|\s*$)/iu.test(req.headers['content-type']??'')){send(res,415,{error:'json_required'});return}
 try{
  const chunks:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>65536){send(res,413,{error:'body_too_large'});return}chunks.push(Buffer.from(part))}
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if(!object(value)||value.version!==1||!id(value.request_id)||!digest(value.digest)||Object.keys(value).length!==(req.url==='/ingest'?4:3)||(req.url==='/ingest'&&(typeof value.plan_json!=='string'||Buffer.byteLength(value.plan_json)>24576))){send(res,400,{error:'invalid_envelope'});return}
  if(req.url==='/ingest')await broker.ingest(value as unknown as RemoteComputerEnvelope);else await broker.revoke(value.request_id,value.digest)
  send(res,200,{accepted:true})
 }catch{send(res,409,{error:'local_bridge_uncertain'})}
}}
export async function listenRemoteComputerHost(options:{hostFile:string;realm:string;nodeId:string;broker:LocalBroker}):Promise<()=>Promise<void>>{
 await mkdir(dirname(options.hostFile),{recursive:true,mode:0o700});await privateDirectory(options.hostFile)
 const token=randomBytes(32).toString('base64url'),server=createServer(remoteComputerHostHandler(token,options.broker))
 server.requestTimeout=5000;server.headersTimeout=5000;server.maxConnections=8
 let close!:(()=>void),ready!:(()=>void),fail!:(error:unknown)=>void
 const ending=new Promise<void>(done=>{close=done}),started=new Promise<void>((done,reject)=>{ready=done;fail=reject})
 const holding=withFileLock(options.hostFile,async()=>{
  try{
   await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);done()})})
   const address=server.address();if(!address||typeof address==='string')throw Error('REMOTE_COMPUTER_BRIDGE_START_FAILED')
   await writeFileAtomic(options.hostFile,JSON.stringify({version:1,origin:`http://127.0.0.1:${address.port}`,token,realm:options.realm,node_id:options.nodeId}),{mode:0o600,dirMode:0o700})
   ready();await ending
  }finally{
   await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections()})
   try{const current=await readRemoteComputerDiscovery(options.hostFile,options.realm,options.nodeId);if(current.token===token)await unlink(options.hostFile)}catch{/* Never remove another generation's discovery. */}
  }
 },{waitMs:250}).catch(error=>{fail(error);throw error})
 void holding.catch(()=>{})
 await started
 return async()=>{close();await holding}
}
