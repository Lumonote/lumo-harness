import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MinioObjectStore } from '../src/minio-store.ts'

const group=process.env.LUMO_AUTH_PROXY_TEST==='1'?describe:describe.skip
group('MinIO SDK transport cancels actual HTTP connections',()=>{
  const servers:Server[]=[]
  afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve())})))})
  it.each(['stat','put','get-headers','get-body'] as const)('closes the network request when %s is cancelled',async mode=>{
    let entered!:()=>void,closed!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),disconnected=new Promise<void>(resolve=>{closed=resolve})
    const server=createServer((request,response)=>{
      if(request.method==='HEAD'&&mode!=='stat'){
        response.setHeader('Content-Length','16');response.end();return
      }
      request.resume()
      response.once('close',closed)
      if(mode==='get-body'){response.writeHead(200,{'Content-Length':'16'});response.write('x')}
      else entered()
    })
    servers.push(server)
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address()
    if(!address||typeof address==='string')throw new Error('Missing test address')
    const store=new MinioObjectStore({endPoint:'127.0.0.1',port:address.port,useSSL:false,accessKey:'x',secretKey:'y',bucket:'test-objects',region:'us-east-1'})
    vi.spyOn(store,'init').mockResolvedValue()
    const controller=new AbortController()
    const pending=mode==='put'
      ?store.putStream('r','x',(async function*(){yield Buffer.from('x')})(),1,undefined,controller.signal)
      :mode==='stat'?store.getStream('r','x',controller.signal)
      :(async()=>{const stored=await store.getStream('r','x',controller.signal);for await(const _part of stored!.body){if(mode==='get-body')entered()}})()
    await started
    controller.abort(new Error(`cancel ${mode}`))
    await expect(pending).rejects.toThrow(`cancel ${mode}`)
    await disconnected
  })
})
