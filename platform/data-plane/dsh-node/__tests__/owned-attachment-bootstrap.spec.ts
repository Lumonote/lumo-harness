import { spawnSync } from 'node:child_process'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe,it,expect } from 'vitest'
const root=fileURLToPath(new URL('../../../..',import.meta.url))
const entry=join(root,'platform/data-plane/dsh-node/src/index.ts'),loader=join(root,'platform/data-plane/dsh-node/node_modules/tsx/dist/loader.mjs')
const configuration={authorityUrl:'https://authority.example',nodeId:'node-a',projectId:'p',workspaceRoot:'/srv/sessions',provider:'mock',model:'mock'}
function run(attachments:unknown,enabled=true){
 const directory=mkdtempSync(join(tmpdir(),'owned-attachment-bootstrap-'))
 const generated=join(directory,'rendered.yml'),cli=join(directory,'fixture.mjs')
 writeFileSync(cli,"import {copyFileSync} from 'node:fs';const index=process.argv.indexOf('--patch');copyFileSync(process.argv[index+1],process.env.LUMO_FIXTURE_PATCH);")
 const env={PATH:process.env.PATH,HOME:process.env.HOME,LUMO_DEPLOYMENT_MODE:'standalone',LUMO_DSH_PROFILE:'web',LUMO_ROLE:'agent',LUMO_PROJECT_ID:'p',LUMO_REALM:'r',LUMO_AUTO_INSTALL_PLUGINS:'0',LUMO_DSH_CLI:cli,LUMO_PATCH_PATH:join(directory,'patch.yml'),LUMO_FIXTURE_PATCH:generated,...(enabled?{LUMO_USER_SESSION_EXECUTION:JSON.stringify({...configuration,...(attachments===undefined?{}:{attachments})})}:{})}
 try{const result=spawnSync(process.execPath,['--import',loader,entry],{cwd:directory,env,encoding:'utf8',timeout:15000});return {status:result.status,output:String(result.error??'')+String(result.stderr??'')+String(result.stdout??''),patch:result.status===0?readFileSync(generated,'utf8'):''}}finally{rmSync(directory,{recursive:true,force:true})}
}
describe('owned attachment DSH bootstrap configuration',()=>{
 it('injects the immutable attachment service only for explicit enabled application policy',()=>{
  const off=run(undefined);expect(off.status,off.output).toBe(0)
  const on=run({realm:'r',maxUploadBytes:8388608,maxTextBytes:1048576,maxPerMessage:4});expect(on.status,on.output).toBe(0)
  const auth=(patch:string)=>patch.split('- id: lumo-user-auth')[1]!.split('config:')[0]!
  expect(auth(off.patch)).not.toContain(', attachments]');expect(auth(on.patch)).toContain(', attachments]');expect(on.patch).toContain('"attachments":{"realm":"r"')
 })
 it('rejects wrong Realm, extra authority fields and oversized policies before launching the child',()=>{
  for(const policy of [{realm:'other'},{realm:'r',url:'https://private'},{realm:'r',maxPerMessage:5},{realm:'r',maxTextBytes:1048577},{realm:'r',maxUploadBytes:10,maxTextBytes:11}]){const result=run(policy);expect(result.status).not.toBe(0);expect(result.output).toMatch(/attachments|attachment|Text limit/u);expect(result.patch).toBe('')}
 })
})
