import { PassThrough, Readable } from 'node:stream'
import type { Client } from 'minio'
import { describe, expect, it, vi } from 'vitest'
import { MinioObjectStore } from '../src/minio-store.ts'
import { ObjectUploadStream } from '../src/stream-transfer.ts'

const never=<T>()=>new Promise<T>(()=>{})
const body=()=> (async function*(){yield Buffer.from('x')})()
function fixture(){
  const store=new MinioObjectStore({endPoint:'127.0.0.1',port:1,useSSL:false,accessKey:'x',secretKey:'y',bucket:'no-network'})
  const client=(store as unknown as {client:Client}).client
  return {store,client}
}

describe('object stream cancellation at SDK boundaries',()=>{
  it('cancels both reads and writes during bucket initialization',async()=>{
    for(const operation of ['read','write']){
      const {store}=fixture(),controller=new AbortController()
      vi.spyOn(store,'init').mockReturnValue(never())
      const pending=operation==='read'?store.getStream('r','x',controller.signal):store.putStream('r','x',body(),1,undefined,controller.signal)
      controller.abort(new Error('cancel initialization'))
      await expect(pending).rejects.toThrow('cancel initialization')
    }
  })
  it('cancels a hanging stat request',async()=>{
    const {store,client}=fixture(),controller=new AbortController()
    vi.spyOn(store,'init').mockResolvedValue()
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
    vi.spyOn(client,'statObject').mockImplementation(()=>{entered();return never()})
    const pending=store.getStream('r','x',controller.signal)
    await started;controller.abort(new Error('cancel stat'))
    await expect(pending).rejects.toThrow('cancel stat')
  })
  it('cancels a hanging object upload and destroys the input stream',async()=>{
    const {store,client}=fixture(),controller=new AbortController()
    vi.spyOn(store,'init').mockResolvedValue()
    let source!:Readable,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
    vi.spyOn(client,'putObject').mockImplementation((_bucket,_key,input)=>{source=input as Readable;entered();return never()})
    const pending=store.putStream('r','x',body(),1,undefined,controller.signal)
    await started;controller.abort(new Error('cancel upload'))
    await expect(pending).rejects.toThrow('cancel upload')
    expect(source.destroyed).toBe(true)
  })
  it('keeps metadata-only reads lazy and destroys a response arriving after cancellation',async()=>{
    const {store,client}=fixture(),controller=new AbortController()
    vi.spyOn(store,'init').mockResolvedValue()
    vi.spyOn(client,'statObject').mockResolvedValue({size:1,metaData:{},lastModified:new Date(),etag:'x'})
    let respond!:(value:Readable)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
    const get=vi.spyOn(client,'getObject').mockImplementation(()=>{entered();return new Promise<Readable>(resolve=>{respond=resolve})})
    const stored=await store.getStream('r','x',controller.signal)
    expect(get).not.toHaveBeenCalled()
    const pending=stored!.body[Symbol.asyncIterator]().next()
    await started;controller.abort(new Error('cancel headers'))
    await expect(pending).rejects.toThrow('cancel headers')
    const late=new PassThrough();respond(late)
    await Promise.resolve();await Promise.resolve()
    expect(late.destroyed).toBe(true)
  })
  it('forwards multipart source failures to the SDK pipe destination',async()=>{
    const source=new ObjectUploadStream((async function*(){yield Buffer.from('x');throw new Error('source failed')})(),new AbortController().signal)
    const destination=new PassThrough()
    const failed=new Promise<Error>(resolve=>destination.once('error',resolve))
    source.pipe(destination);destination.resume()
    expect((await failed).message).toBe('source failed')
    expect(destination.destroyed).toBe(true)
  })
  it('applies a default deadline when the caller omits its signal',async()=>{
    const {store}=fixture(),deadline=new AbortController()
    const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal)
    vi.spyOn(store,'init').mockReturnValue(never())
    try{
      const pending=store.getStream('r','x')
      expect(timeout).toHaveBeenCalledWith(60_000)
      deadline.abort(new Error('default deadline'))
      await expect(pending).rejects.toThrow('default deadline')
    }finally{timeout.mockRestore()}
  })
  it('destroys an opened response on cancellation and on early consumer return',async()=>{
    for(const action of ['abort','return']){
      const {store,client}=fixture(),controller=new AbortController(),source=new PassThrough()
      vi.spyOn(store,'init').mockResolvedValue()
      vi.spyOn(client,'statObject').mockResolvedValue({size:1,metaData:{},lastModified:new Date(),etag:'x'})
      let opened!:()=>void;const started=new Promise<void>(resolve=>{opened=resolve})
      vi.spyOn(client,'getObject').mockImplementation(async()=>{opened();return source})
      const stored=await store.getStream('r','x',controller.signal),iterator=stored!.body[Symbol.asyncIterator]()
      const pending=iterator.next()
      await started
      if(action==='abort'){
        controller.abort(new Error('cancel body'))
        await expect(pending).rejects.toThrow('cancel body')
      }else{
        source.write(Buffer.from('x'))
        await expect(pending).resolves.toMatchObject({done:false})
        await iterator.return?.()
      }
      expect(source.destroyed).toBe(true)
    }
  })
})
