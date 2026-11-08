import { describe, expect, it, vi } from 'vitest'
import { publishReviewedRepository } from '../src/repository-publication.ts'
import { commitSHA, gitResponse, permit, treeSHA } from './repository-fixtures.ts'
describe('reviewed repository publication',()=>{
 it('builds only the reviewed tree on an immutable base, publishes a unique ref, and verifies the draft head/base',async()=>{
  const p=permit(),call=vi.fn(async(operation:string,_path:Record<string,string>,_body?:Record<string,unknown>)=>gitResponse(operation,p))
  const result=await publishReviewedRepository(p,call)
  expect(result).toMatchObject({url:`https://github.com/${p.repository}/pull/1`,branch:`lumo/review-${p.id}`,manifest_digest:p.manifest_digest})
  expect(call.mock.calls.map(args=>args[0])).toEqual(['get_ref','get_commit','create_tree','create_commit','create_ref','get_ref','create_pull_request'])
  expect(call.mock.calls[2]![2]).toEqual({base_tree:'e'.repeat(40),tree:[{path:p.changes[0]!.path,mode:'100644',type:'blob',content:p.changes[0]!.after}]})
  expect(call.mock.calls[3]![2]).toMatchObject({tree:treeSHA,parents:[p.base_commit]})
  expect(call.mock.calls[4]![2]).toEqual({ref:`refs/heads/lumo/review-${p.id}`,sha:commitSHA})
  expect(call.mock.calls[6]![2]).toMatchObject({draft:true,base:'main',head:`lumo/review-${p.id}`})
 })
 it('rejects unclaimed permits, tampered content/hashes/patches and unsafe paths before any provider request',async()=>{
  const p=permit(),call=vi.fn()
  for(const changed of [{...p,status:'pending'},{...p,changes:[{...p.changes[0]!,after:'tampered'}]},{...p,changes:[{...p.changes[0]!,patch:'partial patch'}]},{...p,changes:[{...p.changes[0]!,path:'src/.git/hooks/run'}]}])await expect(publishReviewedRepository(changed,call)).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
 })
 it.each(['moved-base','wrong-commit-parent','wrong-ref','moved-late-base','wrong-draft-head','wrong-draft-base','open-pr','wrong-repository-url'])('fails closed without retries: %s',async mode=>{
  const p=permit();let refReads=0
  const call=vi.fn(async(operation:string)=>{
   if(operation==='get_ref'){refReads++;if(mode==='moved-base'||mode==='moved-late-base'&&refReads===2)return {object:{sha:'f'.repeat(40)}}}
   if(operation==='create_commit'&&mode==='wrong-commit-parent')return {sha:commitSHA,tree:{sha:treeSHA},parents:[{sha:'f'.repeat(40)}]}
   if(operation==='create_ref'&&mode==='wrong-ref')return {object:{sha:'f'.repeat(40)}}
   if(operation==='create_pull_request'){
    const value=gitResponse(operation,p) as Record<string,unknown>
    if(mode==='wrong-draft-head')value.head={sha:'f'.repeat(40)}
    if(mode==='wrong-draft-base')value.base={sha:'f'.repeat(40)}
    if(mode==='open-pr')value.draft=false
    if(mode==='wrong-repository-url')value.html_url='https://github.com/org/repoXtest/pull/1'
    return value
   }
   return gitResponse(operation,p)
  })
  await expect(publishReviewedRepository(p,call)).rejects.toThrow()
  if(mode==='moved-base')expect(call.mock.calls.map(x=>x[0])).toEqual(['get_ref'])
  if(['wrong-commit-parent','wrong-ref','moved-late-base'].includes(mode))expect(call.mock.calls.some(x=>x[0]==='create_pull_request')).toBe(false)
  expect(call.mock.calls.filter(x=>x[0]==='create_ref').length).toBeLessThanOrEqual(1)
 })
})
