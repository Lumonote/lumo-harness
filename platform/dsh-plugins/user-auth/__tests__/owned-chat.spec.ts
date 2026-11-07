// @vitest-environment jsdom
import { Script } from 'node:vm'
import { fireEvent,waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { ownedChatHtml,ownedChatScript } from '../src/owned-chat.ts'
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals()})
describe('owned Session page',()=>{
 it('renders malicious history text and attachment filenames as text with controlled receipt links',async()=>{
  expect(()=>new Script(ownedChatScript)).not.toThrow()
  const id='session-'+'a'.repeat(32),receiptID='att_'+'b'.repeat(48)
  const attack='<img src=x onerror="globalThis.ownedAttachmentInjected=true">'
  const name=attack+'.txt'
  const fetcher=vi.fn(async(url:string)=>{
   if(url==='/lumo/session-attachments/'+id)return new Response(JSON.stringify({receipt_id:receiptID,name,kind:'text',media_type:'text/plain',bytes:5,sha256:'c'.repeat(64),created_at:'2026-11-07T00:00:00Z'}),{status:201})
   const action=url.split('/').at(-1)
   if(action==='wait')return new Promise<Response>(()=>{})
   if(action==='list')return new Response(JSON.stringify({owners:[{session_ref:id,created_at:'2026-11-07'}],next_cursor:''}))
   if(action==='models')return new Response(JSON.stringify({choices:[{id:'fixed',label:'Fixed'}],selected_choice_id:'fixed',can_select:false,attachment_policy:{max_upload_bytes:100000,max_text_bytes:10000,max_per_message:4}}))
   if(action==='events')return new Response(JSON.stringify({events:[{type:'user/message',data:{content:[{type:'text',text:attack+' [lumo-attachment:'+receiptID+'] '+name}]}},{type:'assistant/message',data:{message:{content:[{type:'text',text:attack}]}}}]}))
   return new Response('{}')
  })
  vi.stubGlobal('fetch',fetcher)
  document.body.innerHTML=ownedChatHtml
  Function(ownedChatScript)()
  await waitFor(()=>expect(document.querySelectorAll('#sessions button')).toHaveLength(1))
  fireEvent.click(document.querySelector('#sessions button')!)
  await waitFor(()=>expect(document.getElementById('history')!.textContent).toContain(attack))
  const link=document.querySelector<HTMLAnchorElement>('#history .attachment-link')!
  expect(link.getAttribute('href')).toBe('/lumo/session-attachments/'+id+'/'+receiptID)
  expect(link.hasAttribute('download')).toBe(true)
  await waitFor(()=>expect((document.getElementById('attachment-files') as HTMLInputElement).disabled).toBe(false))
  fireEvent.change(document.getElementById('attachment-files')!,{target:{files:[new File(['hello'],'notes.txt',{type:'text/plain'})]}})
  await waitFor(()=>expect(document.querySelector('#attachments .attachment-chip')!.textContent).toContain(name))
  expect(document.querySelectorAll('#history img, #history script, #attachments img, #attachments script')).toHaveLength(0)
  expect((globalThis as Record<string,unknown>).ownedAttachmentInjected).toBeUndefined()
  expect(fetcher.mock.calls.every(([url])=>url.startsWith('/lumo/sessions/')||url.startsWith('/lumo/session-attachments/'))).toBe(true)
 })
})
