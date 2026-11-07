import { expect, it, vi } from 'vitest'
import { createThreadDispatch } from '../src/thread-dispatch.ts'
import { threadRoundRunId } from '../src/thread-runner.ts'
import type { ThreadRow } from '../src/thread.ts'
import type { ThreadRegistryLike } from '../src/thread-registry.ts'
const thread:ThreadRow={id:'thread',realm:'r',project_id:'p',task_id:'task',node_id:'target',coordinator_session_ref:'captain',session_ref:'session',workspace:'thread/thread/',state:'idle',created_at:'now',updated_at:'now'}
const input={thread,round:{task_id:'task',attempt:1},prompt:'frozen input',parent:{id:'captain'},signal:new AbortController().signal}
const command={id:threadRoundRunId('thread',input.round,'r'),realm:'r',thread_id:'thread',owner_user_id:'u',node_id:'target',coordinator_session_ref:'captain',task_id:'task',attempt:1,prompt:'frozen input',state:'pending',wake_key:'',event_id:'',run_id:'',summary:''}
it('routes to the fixed target through durable commands and accepts only its exact result',async()=>{
 const calls:string[]=[];const authorize=vi.fn();const local={start:vi.fn()}
 const f=createThreadDispatch({baseUrl:'http://collab',token:'t',realm:'r',userId:'u',nodeId:'source',registry:{} as ThreadRegistryLike,local,authorize,pollMs:10,fetch:vi.fn(async(url)=>{calls.push(String(url));return Response.json(calls.length===1?command:{...command,state:'completed',run_id:command.id,summary:'verified output'})}) as typeof fetch})
 await expect(f.runner.start(input)).resolves.toEqual({runId:command.id,summary:'verified output'})
 expect(authorize).toHaveBeenCalledOnce();expect(local.start).not.toHaveBeenCalled();expect(calls).toEqual(['http://collab/threads/thread/commands',`http://collab/thread-commands/${command.id}`]);await f.close()
})
it('uses opaque claim capability instead of a serialized parent id; teardown revokes it',async()=>{
 let pending=true;let executing=false
 const f=createThreadDispatch({baseUrl:'http://collab',token:'t',realm:'r',userId:'u',nodeId:'target',registry:{get:async()=>thread} as ThreadRegistryLike,authorize:vi.fn(),pollMs:10,
 local:{start:async i=>{expect(f.authorizeClaim(i)).toBe(true);expect(f.authorizeClaim({...i,parent:{id:'captain'}})).toBe(false);executing=true;return {runId:command.id,summary:'done'}}},
 fetch:vi.fn(async(url,init)=>{if(String(url).endsWith('/claim')){const c=pending?{...command,state:'claimed',claim_token:'a'.repeat(64)}:null;pending=false;return Response.json({command:c})}expect(executing).toBe(true);expect(JSON.parse(String(init?.body))).toMatchObject({node_id:'target',state:'completed',claim_token:'a'.repeat(64)});return Response.json({...command,state:'completed'})}) as typeof fetch})
 await f.tick();expect(executing).toBe(true);await f.tick();await f.close()
})
it('persists waiting input and emits idempotent wake events without directly invoking a model',async()=>{
 const local={start:vi.fn()};const calls:unknown[]=[]
 const f=createThreadDispatch({baseUrl:'http://collab',token:'t',realm:'r',userId:'u',nodeId:'source',registry:{} as ThreadRegistryLike,local,authorize:vi.fn(),pollMs:10,fetch:vi.fn(async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return Response.json({...command,state:calls.length===1?'waiting':'pending',wake_key:'ready'})}) as typeof fetch})
 await f.schedule(input,{key:'ready',deadline:'2026-12-01T00:00:00Z'});await f.wake(command.id,'ready','event-1');expect(calls).toMatchObject([{prompt:'frozen input',node_id:'target',wake_key:'ready'},{wake_key:'ready',event_id:'event-1'}]);expect(local.start).not.toHaveBeenCalled();await f.close()
})
it('fails current authorization before enqueue and never calls the mailbox',async()=>{
 const fetcher=vi.fn();const f=createThreadDispatch({baseUrl:'http://collab',token:'t',realm:'r',userId:'u',nodeId:'source',registry:{} as ThreadRegistryLike,local:{start:vi.fn()},authorize:async()=>{throw Error('revoked')},fetch:fetcher})
 await expect(f.runner.start(input)).rejects.toThrow('revoked');expect(fetcher).not.toHaveBeenCalled();await f.close()
})

it.each(['run','schedule'] as const)('does not enqueue a pre-aborted %s',async action=>{
 const controller=new AbortController();controller.abort(Error('already cancelled'))
 const fetcher=vi.fn();const authorize=vi.fn()
 const f=createThreadDispatch({baseUrl:'http://collab',token:'t',realm:'r',userId:'u',nodeId:'source',registry:{} as ThreadRegistryLike,local:{start:vi.fn()},authorize,fetch:fetcher})
 const task=action==='run'?f.runner.start({...input,signal:controller.signal}):f.schedule({...input,signal:controller.signal},{key:'ready',deadline:'2026-12-01T00:00:00Z'})
 await expect(task).rejects.toThrow('already cancelled')
 expect(authorize).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();await f.close()
})

it('does not persist work cancelled during the current authorization read',async()=>{
 const controller=new AbortController();const fetcher=vi.fn()
 const f=createThreadDispatch({baseUrl:'http://collab',token:'t',realm:'r',userId:'u',nodeId:'source',registry:{} as ThreadRegistryLike,local:{start:vi.fn()},authorize:async()=>{controller.abort(Error('cancelled during authorization'))},fetch:fetcher})
 await expect(f.runner.start({...input,signal:controller.signal})).rejects.toThrow('cancelled during authorization')
 expect(fetcher).not.toHaveBeenCalled();await f.close()
})

it('enqueues the exact authorized input when the caller reuses its request object', async () => {
 let authorized!: () => void
 let release!: () => void
 const authorizationStarted = new Promise<void>(resolve => { authorized = resolve })
 const authorizationWait = new Promise<void>(resolve => { release = resolve })
 const submitted: unknown[] = []
 const request = {...input, thread: {...thread}, round: {...input.round}}
 const f = createThreadDispatch({baseUrl: 'http://collab', token: 't', realm: 'r', userId: 'u', nodeId: 'source',
  registry: {} as ThreadRegistryLike, local: {start: vi.fn()}, pollMs: 10,
  authorize: async checked => {
   expect(checked.prompt).toBe('frozen input')
   expect(checked.thread.id).toBe('thread')
   authorized()
   await authorizationWait
  },
  fetch: vi.fn(async (_url, init) => {
   if (init?.body) {
    submitted.push(JSON.parse(String(init.body)))
    return Response.json({...command, state: 'completed', run_id: command.id, summary: 'checked output'})
   }
   throw Error('completed command should not poll')
  }) as typeof fetch,
 })
 const running = f.runner.start(request)
 await authorizationStarted
 request.prompt = 'input changed after authorization began'
 request.thread.id = 'another-thread'
 request.thread.coordinator_session_ref = 'another-captain'
 request.round.attempt = 9
 release()
 await expect(running).resolves.toEqual({runId: command.id, summary: 'checked output'})
 expect(submitted).toEqual([expect.objectContaining({id: command.id, attempt: 1, prompt: 'frozen input', coordinator_session_ref: 'captain'})])
 await f.close()
})

it('freezes the wake registration and Thread input before asynchronous authorization', async () => {
 let authorized!: () => void
 let release!: () => void
 const authorizationStarted = new Promise<void>(resolve => { authorized = resolve })
 const authorizationWait = new Promise<void>(resolve => { release = resolve })
 const request = {...input, thread: {...thread}, round: {...input.round}}
 const wake = {key: 'approved-event', deadline: '2026-12-01T00:00:00Z'}
 const submitted: unknown[] = []
 const f = createThreadDispatch({baseUrl: 'http://collab', token: 't', realm: 'r', userId: 'u', nodeId: 'source',
  registry: {} as ThreadRegistryLike, local: {start: vi.fn()},
  authorize: async () => { authorized(); await authorizationWait },
  fetch: vi.fn(async (_url, init) => {
   submitted.push(JSON.parse(String(init?.body)))
   return Response.json({...command, state: 'waiting', wake_key: 'approved-event', wake_deadline: '2026-12-01T00:00:00Z'})
  }) as typeof fetch,
 })
 const pending = f.schedule(request, wake)
 await authorizationStarted
 request.prompt = 'changed prompt'
 request.thread.node_id = 'another-node'
 request.thread.coordinator_session_ref = 'another-captain'
 request.round.attempt = 2
 wake.key = 'different-event'
 wake.deadline = '2028-01-01T00:00:00Z'
 release()
 await expect(pending).resolves.toMatchObject({state: 'waiting', wake_key: 'approved-event'})
 expect(submitted).toEqual([expect.objectContaining({id: command.id, node_id: 'target', coordinator_session_ref: 'captain', attempt: 1, prompt: 'frozen input', wake_key: 'approved-event', wake_deadline: '2026-12-01T00:00:00Z'})])
 await f.close()
})
