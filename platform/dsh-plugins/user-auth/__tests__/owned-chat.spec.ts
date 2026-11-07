import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ownedChatHtml, ownedChatScript } from '../src/owned-chat.ts'
describe('owned text Session page', () => {
  it('uses only the authenticated transport and renders untrusted text without HTML injection', () => {
    expect(() => new Script(ownedChatScript)).not.toThrow()
    expect(ownedChatHtml).toContain('/lumo/chat.js')
    expect(ownedChatScript).toContain("'/lumo/sessions/'")
    expect(ownedChatScript).toContain('document.createTextNode(text)')
    expect(ownedChatScript).not.toContain('innerHTML')
    expect(ownedChatScript).not.toContain('/api/')
    expect(ownedChatScript).not.toContain('WebSocket')
  })
})
