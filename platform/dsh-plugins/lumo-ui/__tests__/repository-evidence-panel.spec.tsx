// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import {afterEach,expect,it,vi} from 'vitest'
import {TaskEvidencePanel,REPOSITORY_OUTPUT_PROFILE} from '../src/client/cluster-panels.tsx'
afterEach(cleanup)
it('publishes the selected run and discards a late response after the user selects another run',async()=>{
 let resolve:(value:unknown)=>void=()=>{}
 const request=vi.fn(async(path:string,init?:RequestInit)=>path.endsWith('/repository-publication')?(init?.method==='POST'?new Promise(done=>{resolve=done}):{status:'unpublished'}):{artifacts:[]}) as unknown as <T>(path:string,init?:RequestInit)=>Promise<T>
 const props={request,taskID:'task',runID:'run-a',result:{run_id:'run-a',state:'COMPLETED',review_scope:REPOSITORY_OUTPUT_PROFILE,manifest_digest:'a'.repeat(64)},error:'',busy:false,label:(value:string)=>value,close:vi.fn()}
 const view=render(<TaskEvidencePanel {...props}/>),button=screen.getByRole('button',{name:'审核通过后发布草稿 PR'})
 await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false))
 fireEvent.click(button);fireEvent.click(button)
 expect(vi.mocked(request).mock.calls.filter(args=>args[1]?.method==='POST')).toHaveLength(1)
 view.rerender(<TaskEvidencePanel {...props} runID="run-b" result={{...props.result,run_id:'run-b'}}/>)
 resolve({url:'https://github.com/org/repo/pull/1'})
 await waitFor(()=>expect((screen.getByRole('button',{name:'审核通过后发布草稿 PR'}) as HTMLButtonElement).disabled).toBe(false))
 expect(screen.queryByRole('link',{name:'查看草稿 PR'})).toBeNull()
})
it('retains the draft link when GitHub succeeded but authority confirmation is unresolved',async()=>{
 const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/repository-publication')){if(init?.method==='POST')throw Object.assign(Error('治理确认待核对'),{body:{url:'https://github.com/org/repo/pull/1'}});return{status:'unpublished'}}return {artifacts:[]}}) as unknown as <T>(path:string,init?:RequestInit)=>Promise<T>
 render(<TaskEvidencePanel request={request} taskID="task" runID="run" result={{run_id:'run',state:'COMPLETED',review_scope:REPOSITORY_OUTPUT_PROFILE}} error="" busy={false} label={value=>value} close={vi.fn()}/> )
 const button=screen.getByRole('button',{name:'审核通过后发布草稿 PR'})
 await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));fireEvent.click(button)
 expect((await screen.findByRole('link',{name:'查看草稿 PR'})).getAttribute('href')).toBe('https://github.com/org/repo/pull/1')
 expect(screen.getByRole('alert').textContent).toContain('治理确认待核对')
 expect((screen.getByRole('button',{name:'审核通过后发布草稿 PR'}) as HTMLButtonElement).disabled).toBe(true)
})
it('loads a consumed publication and explicitly reconciles without offering a second publication',async()=>{
 const request=vi.fn(async(path:string,init?:RequestInit)=>path.endsWith('/reconcile')?{status:'draft',url:'https://github.com/org/repo/pull/2',reconciliation:'confirmed'}:path.endsWith('/repository-publication')?{status:'publishing',reconciliation:'unknown'}:{artifacts:[]}) as unknown as <T>(path:string,init?:RequestInit)=>Promise<T>
 render(<TaskEvidencePanel request={request} taskID="task" runID="run" result={{run_id:'run',state:'COMPLETED',review_scope:REPOSITORY_OUTPUT_PROFILE}} error="" busy={false} label={value=>value} close={vi.fn()}/>)
 const check=await screen.findByRole('button',{name:'核对'})
 expect(screen.getByRole('alert').textContent).toContain('核对结果不明')
 expect((screen.getByRole('button',{name:'审核通过后发布草稿 PR'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(check)
 expect((await screen.findByRole('link',{name:'查看草稿 PR'})).getAttribute('href')).toBe('https://github.com/org/repo/pull/2')
 expect(screen.getByRole('status').textContent).toContain('已核对')
 expect(vi.mocked(request).mock.calls.filter(args=>args[1]?.method==='POST').map(args=>args[0])).toEqual(['/lumo/api/tasks/task/runs/run/repository-publication/reconcile'])
})
it('discards status reads from another task and keeps the fence after an unknown observation',async()=>{
 let resolve:(value:unknown)=>void=()=>{}
 const request=vi.fn(async(path:string)=>path.includes('/old/')?new Promise(done=>{resolve=done}):path.endsWith('/reconcile')?{status:'publishing',reconciliation:'unknown'}:path.endsWith('/repository-publication')?{status:'publishing'}:{artifacts:[]}) as unknown as <T>(path:string,init?:RequestInit)=>Promise<T>
 const props={request,taskID:'old',runID:'run',result:{run_id:'run',state:'COMPLETED',review_scope:REPOSITORY_OUTPUT_PROFILE},error:'',busy:false,label:(value:string)=>value,close:vi.fn()}
 const view=render(<TaskEvidencePanel {...props}/>);view.rerender(<TaskEvidencePanel {...props} taskID="new"/>);resolve({status:'draft',url:'https://github.com/org/repo/pull/9'})
 fireEvent.click(await screen.findByRole('button',{name:'核对'}))
 expect((await screen.findByRole('alert')).textContent).toContain('核对结果不明')
 expect(screen.queryByRole('link',{name:'查看草稿 PR'})).toBeNull()
 expect((screen.getByRole('button',{name:'审核通过后发布草稿 PR'}) as HTMLButtonElement).disabled).toBe(true)
})
