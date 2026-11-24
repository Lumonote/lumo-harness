import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { loginPage, loginScript } from '../src/html.ts'

function fixture() {
  const dom=new JSDOM(loginPage(),{url:'http://localhost/auth/login',runScripts:'outside-only'})
  const w=dom.window, d=w.document, dialog=d.querySelector('dialog')!
  dialog.showModal=()=>dialog.setAttribute('open','')
  dialog.close=()=>{dialog.removeAttribute('open'); dialog.dispatchEvent(new w.Event('close'))}
  const post=vi.fn(); w.HTMLFormElement.prototype.submit=post
  w.HTMLImageElement.prototype.decode=async()=>{}
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({prompt:'puzzle-v1',image:'fixture',expires_in:120})})); w.fetch=fetch as never
  w.eval(loginScript)
  return {w,d,dialog,fetch,post,click:(id:string)=>d.querySelector<HTMLButtonElement>('#'+id)!.click()}
}
describe('first-party login',()=>{
  it('only fetches a challenge after valid submission and discards cancelled answers',async()=>{
    const {w,d,dialog,fetch,post,click}=fixture()
    try {
      expect(fetch).not.toHaveBeenCalled(); click('submit'); expect(dialog.open).toBe(false)
      d.querySelector<HTMLInputElement>('#username')!.value='test'; d.querySelector<HTMLInputElement>('#password')!.value='test'
      click('submit'); await vi.waitFor(()=>expect(d.querySelector<HTMLButtonElement>('#piece')!.disabled).toBe(false))
      expect(dialog.open).toBe(true); click('puzzle-close'); expect(post).not.toHaveBeenCalled()
      click('submit'); await vi.waitFor(()=>expect(d.querySelector<HTMLButtonElement>('#piece')!.disabled).toBe(false))
      expect(fetch).toHaveBeenCalledTimes(2); expect(d.querySelector<HTMLButtonElement>('#confirm')!.disabled).toBe(true)
      d.querySelector('#piece')!.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight'})); click('confirm'); expect(post).toHaveBeenCalledOnce(); expect(d.querySelector<HTMLInputElement>('#captcha')!.value).toBe('p:3:13')
    } finally {w.close()}
  })
  it('offers a retry after load failure without posting credentials',async()=>{
    const {w,d,dialog,fetch,post,click}=fixture(); try {
      fetch.mockRejectedValueOnce(Error('offline')); Object.defineProperty(w,'PublicKeyCredential',{value:class {}}); d.querySelector<HTMLInputElement>('#username')!.value='test'; click('passkey-submit')
      await vi.waitFor(()=>expect(d.querySelector('#puzzle-status')!.textContent).toContain('失败')); expect(dialog.open).toBe(true); expect(post).not.toHaveBeenCalled(); click('refresh'); await vi.waitFor(()=>expect(d.querySelector<HTMLButtonElement>('#piece')!.disabled).toBe(false))
    } finally {w.close()}
  })
  it('preserves MFA, theme, OIDC and fixed state messages',()=>{
    const html=loginPage({state:'invalid',theme:'orbital-glass',oidcEnabled:true}); expect(html).toContain('账号、密码或验证码不正确');expect(html).toContain('data-lumo-theme="orbital-glass"');expect(html).toContain('pattern="[0-9]{6}"');expect(html).toContain('/auth/oidc/start')
  })
})
