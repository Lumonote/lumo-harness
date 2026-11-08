import {Context} from '@deepseek-ai/cordis'
import {afterEach,expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({dispose:vi.fn(),stop:vi.fn()}))
vi.mock('../src/remote-broker.ts',()=>({RemoteComputerBroker:{create:vi.fn(async()=>({dispose:mocks.dispose}))}}))
vi.mock('../src/remote-local-bridge.ts',()=>({createRemoteComputerAuthority:vi.fn(()=>vi.fn()),listenRemoteComputerHost:vi.fn(async()=>mocks.stop)}))
import {apply,type Config} from '../src/remote.ts'
afterEach(()=>vi.clearAllMocks())
it('retains the private discovery generation until broker and native teardown actually finish',async()=>{
 let drain:()=>void=()=>{};mocks.dispose.mockImplementation(()=>new Promise<void>(resolve=>{drain=resolve}));mocks.stop.mockResolvedValue(undefined)
 const ctx=new Context();await apply(ctx,{enabled:true} as Config)
 const closing=ctx.fiber.dispose()
 await vi.waitFor(()=>expect(mocks.dispose).toHaveBeenCalledOnce())
 expect(mocks.stop).not.toHaveBeenCalled()
 drain();await closing
 expect(mocks.stop).toHaveBeenCalledOnce();expect(mocks.dispose).toHaveBeenCalledOnce()
})
it('retains the transport and generation lock after an unconfirmed teardown',async()=>{
 mocks.dispose.mockRejectedValue(Error('native process did not drain'))
 const ctx=new Context();vi.spyOn(ctx.logger,'warn').mockImplementation(()=>{})
 await apply(ctx,{enabled:true} as Config)
 await ctx.fiber.dispose().catch(()=>{})
 expect(mocks.stop).not.toHaveBeenCalled()
})
