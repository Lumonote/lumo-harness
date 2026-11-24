import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { syncOnce, mountMemorySync } from '../../desktop-assets/memory-sync.mjs'

const base = { enabled: true, server: 'https://lumo.example.com', hasToken: true, workspace: 'a'.repeat(64), device: 'dev1', cursor: 9, pending: 0, skipped: 0, lastSyncMs: 0, conflicts: [] }

function fakeDoc() {
  const els: Record<string, any> = {}
  const el = (id: string) => (els[id] ??= { id, textContent: '', value: '', checked: false, disabled: false, hidden: false, placeholder: '', dataset: {}, replaceChildren() {}, addEventListener() {} })
  return { els, doc: { getElementById: el, activeElement: null, createElement: () => el(String(Math.random())), defaultView: { addEventListener() {} } } }
}

describe('memory sync client', () => {
  it('delegates the whole push/pull round to Rust via invoke, no fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch' as any)
    const invoke = vi.fn(async () => base)
    const view = await syncOnce({ invoke, workspaceId: 'w' })
    expect(view.cursor).toBe(9)
    expect(invoke).toHaveBeenCalledWith('pet_memory_sync_run', { workspaceId: 'w' })
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('offline failure keeps the same queued-changes error message', async () => {
    const { doc, els } = fakeDoc()
    const invoke = vi.fn(async (cmd: string) => { if (cmd === 'pet_memory_sync_run') throw 'push_connect'; return base })
    const ui = mountMemorySync({ doc, invoke, listen: () => {}, getWorkspace: () => 'w', timer: {} })
    await ui.refresh()
    await ui.sync()
    expect(els['dev-sync-status'].textContent).toBe('暂时无法连接同步服务器，修改已在本机排队，重连后自动补同步（push_connect）')
    expect(els['dev-sync-status'].dataset.error).toBe('true')
  })

  it('page source no longer fetches external origins and CSP drops https:', () => {
    const src = readFileSync(new URL('../../desktop-assets/memory-sync.mjs', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\bfetch\s*\(/)
    const conf = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'))
    const connect = conf.app.security.csp.split(';').find((d: string) => d.trim().startsWith('connect-src'))
    expect(connect.split(/\s+/)).not.toContain('https:')
  })
})
