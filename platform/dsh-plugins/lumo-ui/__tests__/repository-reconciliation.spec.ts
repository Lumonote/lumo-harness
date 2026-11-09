import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { reconcileReviewedRepository, repositoryPatch, type RepositoryPublicationPermit, type RepositoryReadCall } from '../src/repository-publication.ts'
import { commitSHA, permit } from './repository-fixtures.ts'

// Git object fixtures include an untouched hidden subtree and executable file.
// The expected root hashes bind these paths as well as the reviewed app.ts.
const oldBlob='1d772ee2c05c5e25d3486009461dfb7ec6f18750'
const oldSrc='9ff983f6d7cc008f897a414044430b3da1c1aab3'
const oldRoot='d3c6abe7fa2b6d854987d7e1a4aeb51f764f454f'
const newRoot='713df231d18d89f6008769daff7766c0f3607ff9'
function fixture(p=permit()) {
 const branch=`lumo/review-${p.id}`
 return (operation:string,path:Record<string,string>):unknown=>{
  switch(operation){
   case 'get_ref':return {ref:`refs/${path.ref}`,object:{type:'commit',sha:path.ref===`heads/${p.base_branch}`?p.base_commit:commitSHA}}
   case 'get_commit':return path.commit_sha===p.base_commit?{sha:p.base_commit,tree:{sha:oldRoot}}:{sha:commitSHA,message:`Lumo independently reviewed changes ${p.manifest_digest}`,tree:{sha:newRoot},parents:[{sha:p.base_commit}]}
   case 'get_tree':return path.tree_sha===oldRoot?{sha:oldRoot,truncated:false,tree:[{path:'src',mode:'040000',type:'tree',sha:oldSrc},{path:'README.md',mode:'100644',type:'blob',sha:'2'.repeat(40)},{path:'.github',mode:'040000',type:'tree',sha:'f'.repeat(40)}]}:{sha:oldSrc,truncated:false,tree:[{path:'app.ts',mode:'100644',type:'blob',sha:oldBlob},{path:'keep.sh',mode:'100755',type:'blob',sha:'1'.repeat(40)}]}
   case 'list_pull_requests':return [{number:1}]
   case 'get_pull_request':return {number:1,html_url:`https://github.com/${p.repository}/pull/1`,state:'open',draft:true,merged:false,merged_at:null,base:{sha:p.base_commit,ref:p.base_branch,repo:{full_name:p.repository}},head:{sha:commitSHA,ref:branch,repo:{full_name:p.repository}}}
   default:throw new Error(`Unexpected write or unknown operation ${operation}`)
  }
 }
}
describe('read-only reviewed repository reconciliation',()=>{
 it.each(['publishing','draft'])('confirms %s through exact Git tree reconstruction and repeated final draft/ref reads',async status=>{
  const p={...permit(),status},response=fixture(p),call=vi.fn<RepositoryReadCall>(async(op,path)=>response(op,path))
  expect(await reconcileReviewedRepository(p,call)).toEqual({outcome:'confirmed',reason:'confirmed',url:`https://github.com/${p.repository}/pull/1`})
  expect(call.mock.calls.map(args=>args[0])).toEqual(['get_ref','get_ref','get_commit','get_commit','get_tree','get_tree','list_pull_requests','get_pull_request','get_ref','get_ref','get_pull_request'])
  expect(call.mock.calls[6]).toEqual(['list_pull_requests',{owner:'org',repo:'repo.test'},undefined,{state:'all',head:`org:lumo/review-${p.id}`,base:'main',per_page:'2',page:'1'}])
  expect(call.mock.calls.every(args=>args[2]===undefined)).toBe(true)
  // Only the complete base trees along changed paths are necessary: unchanged
  // subtree hashes remain part of the reconstructed root, including .github.
  expect(call.mock.calls.filter(args=>args[0]==='get_tree').map(args=>args[1].tree_sha)).toEqual([oldRoot,oldSrc])
 })
 it('rejects unclaimed or tampered authority permits before any external read',async()=>{
  const p=permit(),call=vi.fn()
  for(const candidate of [{...p,status:'pending'},{...p,changes:[{...p.changes[0]!,after:'tampered'}]}])await expect(reconcileReviewedRepository(candidate,call)).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
 })
 it.each(['base-moved','head-wrong-parent','wrong-manifest-message','extra-head-change','tree-truncated','tree-missing-entry','tree-duplicate-entry','tree-wrong-object-hash','tree-invalid-name','tree-wrong-mode','missing-pr','ambiguous-pr','merged-pr','closed-pr','non-draft','wrong-head-repository','wrong-base-branch','wrong-pr-url','head-moved-at-end','base-moved-at-end','draft-changed-at-end'])('persists only unknown evidence and never retries writes: %s',async mode=>{
  const p=permit(),response=fixture(p);let refReads=0,pullReads=0
  const call=vi.fn<RepositoryReadCall>(async(op,path)=>{
   const value=response(op,path) as Record<string,any>
   if(op==='get_ref'){
    refReads++
    if(mode==='base-moved'&&refReads===1||mode==='head-moved-at-end'&&refReads===3||mode==='base-moved-at-end'&&refReads===4)value.object.sha='e'.repeat(40)
   }
   if(op==='get_commit'&&path.commit_sha===commitSHA){
    if(mode==='head-wrong-parent')value.parents=[{sha:'e'.repeat(40)}]
    if(mode==='wrong-manifest-message')value.message='A different manifest'
    if(mode==='extra-head-change')value.tree.sha='e'.repeat(40)
   }
   if(op==='get_tree'&&path.tree_sha===oldRoot){
    if(mode==='tree-truncated')value.truncated=true
    if(mode==='tree-missing-entry')value.tree.pop()
    if(mode==='tree-duplicate-entry')value.tree.push(value.tree[0])
    if(mode==='tree-wrong-object-hash')value.sha='e'.repeat(40)
    if(mode==='tree-invalid-name')value.tree[0].path='../src'
    if(mode==='tree-wrong-mode')value.tree[0].mode='100755'
   }
   if(op==='list_pull_requests'){
    if(mode==='missing-pr')return []
    if(mode==='ambiguous-pr')return [{number:1},{number:2}]
   }
   if(op==='get_pull_request'){
    pullReads++
    if(mode==='merged-pr'){value.merged=true;value.merged_at='2026-11-09T00:00:00Z'}
    if(mode==='closed-pr')value.state='closed'
    if(mode==='non-draft'||mode==='draft-changed-at-end'&&pullReads===2)value.draft=false
    if(mode==='wrong-head-repository')value.head.repo.full_name='attacker/repo.test'
    if(mode==='wrong-base-branch')value.base.ref='other'
    if(mode==='wrong-pr-url')value.html_url='https://github.com/other/repo/pull/1'
   }
   return value
  })
  expect(await reconcileReviewedRepository(p,call)).toEqual({outcome:'unknown',reason:'evidence_mismatch'})
  expect(call.mock.calls.every(args=>['get_ref','get_commit','get_tree','list_pull_requests','get_pull_request'].includes(args[0]))).toBe(true)
  expect(call.mock.calls.filter(args=>args[0]==='list_pull_requests').length).toBeLessThanOrEqual(1)
 })
 it('rejects self-consistent reviewed before bytes that differ from the actual immutable base',async()=>{
  const p=permit(),change=p.changes[0]!,before='unrelated approved text\n'
  p.changes=[{...change,before,before_sha256:createHash('sha256').update(before).digest('hex'),patch:repositoryPatch(change.path,before,change.after)}]
  expect(await reconcileReviewedRepository(p,async(op,path)=>fixture(p)(op,path))).toEqual({outcome:'unknown',reason:'evidence_mismatch'})
 })
 it('returns a bounded generic unknown on transport errors without disclosing provider details or URLs',async()=>{
  const call=vi.fn(async()=>{throw new Error('private provider response: token=secret')})
  expect(await reconcileReviewedRepository(permit(),call)).toEqual({outcome:'unknown',reason:'provider_unavailable'})
  expect(call).toHaveBeenCalledTimes(1)
 })
 it('fails closed on overlarge complete tree responses',async()=>{
  const p=permit(),response=fixture(p)
  const call=vi.fn<RepositoryReadCall>(async(op,path)=>op==='get_tree'?{sha:oldRoot,truncated:false,tree:Array(4097).fill({path:'x',mode:'100644',type:'blob',sha:oldBlob})}:response(op,path))
  expect(await reconcileReviewedRepository(p,call)).toEqual({outcome:'unknown',reason:'evidence_mismatch'})
  expect(call.mock.calls.filter(args=>args[0]==='get_tree')).toHaveLength(1)
 })
 it('declares every reconciliation connector operation as a bounded read',()=>{
  const connector=JSON.parse(readFileSync(new URL('../../../shared/connectors/github.oauth.example.json',import.meta.url),'utf8'))
  for(const op of ['get_ref','get_commit','get_tree','list_pull_requests','get_pull_request'])expect(connector.operations[op]).toMatchObject({name:op,method:'GET',write:false,maxResponseBytes:1048576})
 })
})
