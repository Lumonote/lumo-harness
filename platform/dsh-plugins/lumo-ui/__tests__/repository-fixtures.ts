import { createHash } from 'node:crypto'
import { repositoryPatch, type RepositoryPublicationPermit } from '../src/repository-publication.ts'
export const treeSHA='b'.repeat(40),commitSHA='c'.repeat(40)
export function permit():RepositoryPublicationPermit{
 const path='src/app.ts',before='export const value = 1\n',after='export const value = 2\n',sha=(text:string)=>createHash('sha256').update(text).digest('hex')
 return {id:'11111111-2222-4333-8444-555555555555',manifest_digest:'d'.repeat(64),repository:'org/repo.test',base_commit:'a'.repeat(40),base_branch:'main',status:'publishing',changes:[{path,before,after,before_sha256:sha(before),after_sha256:sha(after),patch:repositoryPatch(path,before,after)}]}
}
export function gitResponse(operation:string,p=permit()):unknown{
 const branch=`lumo/review-${p.id}`
 switch(operation){
 case 'get_ref':return {object:{sha:p.base_commit}}
 case 'get_commit':return {sha:p.base_commit,tree:{sha:'e'.repeat(40)}}
 case 'create_tree':return {sha:treeSHA}
 case 'create_commit':return {sha:commitSHA,tree:{sha:treeSHA},parents:[{sha:p.base_commit}]}
 case 'create_ref':return {object:{sha:commitSHA}}
 case 'create_pull_request':return {html_url:`https://github.com/${p.repository}/pull/1`,draft:true,base:{sha:p.base_commit},head:{sha:commitSHA,ref:branch,repo:{full_name:p.repository}}}
 default:throw new Error(`Unexpected connector operation ${operation}`)
 }
}
