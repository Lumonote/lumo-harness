// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { TaskEvidencePanel } from '../src/client/cluster-panels.tsx'
afterEach(cleanup)
const artifact={id:'artifact',name:'report.pdf',content_type:'application/pdf',size_bytes:123,sha256:'a'.repeat(64),created_by:'employee',created_at:'2026-11-08'}
function mount(request:ReturnType<typeof vi.fn>){return render(<TaskEvidencePanel taskID="task" runID="run" request={request} result={null} error="" busy={false} label={value=>value} close={()=>{}} />)}
describe('task artifact withdrawal flow',()=>{
 it('collects a reason and submits the exact displayed digest, then refreshes the artifact list',async()=>{
  let withdrawn=false
  const request=vi.fn(async(_path:string,init?:RequestInit)=>{if(init?.method==='DELETE'){withdrawn=true;return {withdrawn:true}}return {artifacts:withdrawn?[]:[{...artifact,can_withdraw:true}]}})
  mount(request);fireEvent.click(await screen.findByRole('button',{name:'撤回'}))
  fireEvent.change(screen.getByRole('textbox',{name:'撤回原因'}),{target:{value:'Outdated report'}})
  fireEvent.click(screen.getByRole('button',{name:'确认撤回'}))
  await screen.findByText('已撤回「report.pdf」，记录保留在任务审计中。')
  expect(request).toHaveBeenCalledWith('/lumo/api/tasks/task/runs/run/artifacts/artifact',{method:'DELETE',body:JSON.stringify({reason:'Outdated report',expected_sha256:artifact.sha256})})
  await waitFor(()=>expect(screen.queryByRole('button',{name:'撤回'})).toBeNull())
 })
 it.each([false,undefined])('keeps terminal/viewer/older server responses read-only: %s',async can_withdraw=>{
  const request=vi.fn(async()=>({artifacts:[{...artifact,can_withdraw}]}));mount(request)
  await screen.findByText('report.pdf');expect(screen.queryByRole('button',{name:'撤回'})).toBeNull();expect(screen.getByRole('link',{name:'下载'})).toBeTruthy()
 })
})
