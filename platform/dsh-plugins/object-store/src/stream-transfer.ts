import { Readable } from 'node:stream'

/** SDK promises do not accept AbortSignal. Bound the caller's wait while still
 * observing a late completion and releasing any response stream it creates. */
export function boundedObjectOperation<T>(work:Promise<T>,signal:AbortSignal,late?:(value:T)=>void):Promise<T> {
  return new Promise((resolve,reject)=>{
    let cancelled=false
    const abort=()=>{cancelled=true;reject(signal.reason)}
    if(signal.aborted)abort()
    else signal.addEventListener('abort',abort,{once:true})
    work.then(value=>{if(cancelled)late?.(value);else resolve(value)},reject)
      .finally(()=>signal.removeEventListener('abort',abort))
      .catch(()=>{})
  })
}

export function objectTransferSignal(signal?:AbortSignal):AbortSignal {
  return AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(60_000)])
}

/** MinIO's multipart adapter pipes its source but does not propagate source
 * errors to its block stream. This platform-owned Readable forwards them so
 * cancellation also terminates that consumer; no SDK code is patched. */
export class ObjectUploadStream extends Readable {
  private readonly input:AsyncIterator<Uint8Array>
  private reading=false
  constructor(body:AsyncIterable<Uint8Array>,signal:AbortSignal) {
    super({objectMode:false,highWaterMark:64*1024,signal})
    this.input=body[Symbol.asyncIterator]()
    this.on('error',()=>{})
  }
  override _read():void {
    if(this.reading)return
    this.reading=true
    void this.input.next().then(item=>{
      this.reading=false
      if(!this.destroyed)this.push(item.done?null:item.value)
    },error=>{this.reading=false;this.destroy(error instanceof Error?error:new Error(String(error)))})
  }
  override _destroy(error:Error|null,done:(error?:Error|null)=>void):void {
    try{void Promise.resolve(this.input?.return?.()).catch(()=>{})}catch{/* source cleanup is best effort */}
    done(error)
  }
  override pipe<T extends NodeJS.WritableStream>(destination:T,options?:{end?:boolean}):T {
    const forward=(error:Error)=>{
      const target=destination as T&{destroy?:(error:Error)=>void}
      if(target.destroy)target.destroy(error)
      else target.emit('error',error)
    }
    const cleanup=()=>{this.off('error',forward);destination.off('close',cleanup);destination.off('finish',cleanup)}
    this.on('error',forward)
    destination.once('close',cleanup).once('finish',cleanup)
    return super.pipe(destination,options)
  }
}
