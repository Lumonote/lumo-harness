import { expect, it, vi } from 'vitest'
import { prepareGovernedRun } from '../src/run-review.ts'
import { binding, config, execution } from './governed-fixtures.ts'
const snapshot={realm:config.realm,task_id:'task-run-1',run_id:'run-1',worker_id:`agent:${binding.agentId}`,node_id:config.nodeId,session_ref:'session-run-1',preset_id:binding.agentId,preset_revision:binding.presetRevision,provider:binding.provider,model:binding.model,output_profile:'platform-closed-text-v1'}
it('freezes execution identity with service authority before Agent creation',async()=>{
 const f=vi.fn(async()=>Response.json({snapshot}));await expect(prepareGovernedRun(config,execution(),f)).resolves.toEqual({snapshot})
 expect(f.mock.calls[0]).toMatchObject([`${config.governanceUrl}/v1/runtime/task-runs/run-1/prepare`,{method:'PUT',redirect:'error',headers:{authorization:`Bearer ${config.token}`}}])
})
it.each([{run_id:'other'},{provider:'other'},{preset_revision:0},{node_id:'other'},{output_profile:'self-proven'}])('refuses a forged execution receipt %j',async patch=>{
 await expect(prepareGovernedRun(config,execution(),async()=>Response.json({snapshot:{...snapshot,...patch}}))).rejects.toThrow()
})
it('rejects stale or malformed reviewer evidence before creating an Agent',async()=>{
 const review={producer_task_id:'producer',producer_run_id:'run-p',producer_intent:'Verify the original producer acceptance criteria',manifest_digest:'a'.repeat(64),manifest:{scope:'platform-closed-text-v1',task_id:'producer',run_id:'run-p',summary:'summary',entries:[{id:'1',sha256:'b'.repeat(64),text:'deliverable'}]},expires_at:new Date(Date.now()+3600000).toISOString()}
 await expect(prepareGovernedRun(config,execution(),async()=>Response.json({snapshot,review}))).resolves.toMatchObject({review})
 await expect(prepareGovernedRun(config,execution(),async()=>Response.json({snapshot,review:{...review,expires_at:'2020-01-01'}}))).rejects.toThrow('review')
})

it('refuses review evidence that omits the original producer contract intent', async () => {
 const review={producer_task_id:'producer',producer_run_id:'run-p',manifest_digest:'a'.repeat(64),manifest:{scope:'platform-closed-text-v1',task_id:'producer',run_id:'run-p',summary:'summary',entries:[{id:'1',sha256:'b'.repeat(64),text:'deliverable'}]},expires_at:new Date(Date.now()+3600000).toISOString()}
 await expect(prepareGovernedRun(config,execution(),async()=>Response.json({snapshot,review}))).rejects.toThrow('review')
})
