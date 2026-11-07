import {describe,it,expect,vi} from 'vitest'
import {SessionExecutionClient,SessionExecutionRuntime} from '../../../shared/session-execution.ts'

function fixture(){
  let fenced=false
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    if(fenced)return new Response('{}',{status:409})
    const body=JSON.parse(String(init?.body))
    expect(init?.redirect).toBe('error');expect(init?.headers).toEqual({authorization:'Bearer service','content-type':'application/json'})
    return new Response(JSON.stringify(String(url).includes('/nodes/')?{node:{...body,fence:3,expires_at:'2099-01-01'}}:{lease:{...body,session_ref:'session-test',node_fence:3,fencing_token:5,expires_at:'2099-01-01'}}))
  })
  const stop=vi.fn()
  const runtime=new SessionExecutionRuntime(new SessionExecutionClient('https://authority.example','service',fetcher as typeof fetch),'r','n','p','https://node.example','writer',stop)
  return {runtime,fetcher,stop,fence:()=>{fenced=true}}
}
describe('persistent Session execution runtime',()=>{
  it('claims once per process, checks the exact generation and releases credentials only on shutdown',async()=>{
    const f=fixture()
    await f.runtime.ensure('session-test');await f.runtime.ensure('session-test')
    expect(f.fetcher.mock.calls.filter(([u])=>String(u).endsWith('/nodes/n/acquire'))).toHaveLength(1)
    expect(f.fetcher.mock.calls.filter(([u])=>String(u).includes('/sessions/session-test/acquire'))).toHaveLength(1)
    expect(f.fetcher.mock.calls.filter(([u])=>String(u).includes('/sessions/session-test/renew'))).toHaveLength(1)
    await f.runtime.dispose();expect(f.runtime.signal.aborted).toBe(true)
  })
  it('permanently fences old Agents and cannot reacquire after lease loss',async()=>{
    const f=fixture()
    await f.runtime.ensure('session-test');f.fence()
    await expect(f.runtime.ensure('session-test')).rejects.toMatchObject({code:'session_execution_unavailable'})
    expect(f.stop).toHaveBeenCalledOnce();expect(f.runtime.signal.aborted).toBe(true)
    const calls=f.fetcher.mock.calls.length
    await expect(f.runtime.ensure('session-test')).rejects.toThrow()
    expect(f.fetcher).toHaveBeenCalledTimes(calls)
    await f.runtime.dispose()
  })
})
