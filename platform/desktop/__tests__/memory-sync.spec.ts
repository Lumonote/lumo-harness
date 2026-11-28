import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { syncOnce, mountMemorySync } from '../../desktop-assets/memory-sync.mjs'

const base = { enabled: true, server: 'https://lumo.example.com', hasToken: true, workspace: 'a'.repeat(64), projectId: 'a'.repeat(64), deferred: 0, scope: 'scope-a', identity: null, device: 'dev1', cursor: 9, pending: 0, skipped: 0, lastSyncMs: 0, conflicts: [] }

function fakeDoc() {
  const els: Record<string, any> = {}
  const el = (id: string) => (els[id] ??= { id, textContent: '', value: '', checked: false, disabled: false, hidden: false, placeholder: '', dataset: {}, handlers: {}, replaceChildren() {}, append() {}, addEventListener(event: string, fn: () => void) { this.handlers[event] = fn } })
  return { els, doc: { getElementById: el, activeElement: null, createElement: () => el(String(Math.random())), defaultView: { addEventListener() {} } } }
}

describe('memory sync client', () => {
  it('delegates the whole push/pull round to Rust via invoke, no fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch' as any)
    const invoke = vi.fn(async () => base)
    const view = await syncOnce({ invoke, workspaceId: 'w' })
    expect(view.cursor).toBe(9)
    expect(invoke).toHaveBeenCalledWith('pet_memory_sync_run', { workspaceId: 'w', full: false })
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  it('offline failure keeps the same queued-changes error message', async () => {
    const { doc, els } = fakeDoc()
    const invoke = vi.fn(async (cmd: string) => { if (cmd === 'pet_memory_sync_run') throw 'push_connect'; return base })
    const ui = mountMemorySync({ doc, invoke, listen: () => {}, getWorkspace: () => 'w', timer: {} })
    await ui.refresh()
    await ui.sync()
    expect(els['dev-sync-status'].textContent).toBe('同步未完成，本机修改和待接收内容均已保留（push_connect）')
    expect(els['dev-sync-status'].dataset.error).toBe('true')
  })

  it('discards an old workspace response after switching projects', async () => {
    const { doc, els } = fakeDoc()
    let workspace = 'a'
    let finish!: (v: typeof base) => void
    const invoke = vi.fn(async (_cmd: string, args: any) => args.workspaceId === 'a'
      ? new Promise<typeof base>(resolve => { finish = resolve }) : { ...base, server: 'https://new.example.com' })
    const ui = mountMemorySync({ doc, invoke, listen: () => {}, getWorkspace: () => workspace, timer: {} })
    const old = ui.refresh()
    workspace = 'b'
    await ui.refresh()
    finish({ ...base, server: 'https://old.example.com' })
    await old
    expect(els['dev-sync-server'].value).toBe('https://new.example.com')
  })

  it('saves the explicit shared project ID and retains a token draft if saving fails', async () => {
    const { doc, els } = fakeDoc()
    const handlers: Record<string, () => void> = {}
    const invoke = vi.fn(async (_cmd: string, args: any) => { if (args.request?.op === 'configure') throw Error('save failed'); return base })
    const ui = mountMemorySync({ doc, invoke, listen: (el: any, event: string, fn: any) => { handlers[el.id + ':' + event] = fn }, getWorkspace: () => 'w', timer: {} })
    await ui.refresh()
    els['dev-sync-project'].value = 'b'.repeat(64)
    els['dev-sync-token'].value = 'new-token'
    handlers['dev-sync-save:click']()
    await vi.waitFor(() => expect(els['dev-sync-status'].textContent).toBe('save failed'))
    expect(invoke).toHaveBeenLastCalledWith('pet_memory_sync', { workspaceId: 'w', request: { op: 'configure', enabled: true, server: base.server, projectId: 'b'.repeat(64), token: 'new-token' } })
    expect(els['dev-sync-token'].value).toBe('new-token')
    expect(els['dev-sync-project'].value).toBe('b'.repeat(64))
  })

  it('shows persisted backlog instead of claiming complete synchronization', async () => {
    const { doc, els } = fakeDoc()
    const ui = mountMemorySync({ doc, invoke: async () => ({ ...base, deferred: 2 }), listen: () => {}, getWorkspace: () => 'w', timer: {} })
    await ui.refresh(); await ui.sync()
    expect(els['dev-sync-summary'].textContent).toContain('待接收 2 条')
    expect(els['dev-sync-status'].textContent).toContain('释放记忆容量后会自动重试')
  })

  it('ignores old sync completion after switching and stops polling on dispose', async () => {
    const { doc, els } = fakeDoc()
    let ws = 'a', complete!: (v: typeof base) => void
    const timer = { setInterval: vi.fn(() => 7), clearInterval: vi.fn() }
    const onChanged = vi.fn()
    const invoke = vi.fn(async (cmd: string, args: any) => cmd === 'pet_memory_sync_run' ? new Promise<typeof base>(r => { complete = r }) : { ...base, server: args.workspaceId === 'a' ? base.server : 'https://b.example' })
    const ui = mountMemorySync({ doc, invoke, listen: () => {}, getWorkspace: () => ws, timer, onChanged })
    await ui.refresh(); const running = ui.sync()
    ws = 'b'; await ui.refresh()
    complete(base); await running
    expect(els['dev-sync-server'].value).toBe('https://b.example')
    expect(onChanged).not.toHaveBeenCalled()
    ui.dispose(); expect(timer.clearInterval).toHaveBeenCalledWith(7)
  })

  it('page source no longer fetches external origins and CSP drops https:', () => {
    const src = readFileSync(new URL('../../desktop-assets/memory-sync.mjs', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\bfetch\s*\(/)
    const conf = JSON.parse(readFileSync(new URL('../tauri.conf.json', import.meta.url), 'utf8'))
    const connect = conf.app.security.csp.split(';').find((d: string) => d.trim().startsWith('connect-src'))
    expect(connect.split(/\s+/)).not.toContain('https:')
  })

  it('requests an explicit full reconciliation and shows the last completed full scan', async () => {
    const { doc, els } = fakeDoc()
    const handlers: Record<string, () => void> = {}
    const invoke = vi.fn(async () => ({ ...base, lastFullSyncMs: 1_700_000_000_000 }))
    const ui = mountMemorySync({ doc, invoke, listen: (el: any, event: string, fn: any) => { handlers[el.id + ':' + event] = fn }, getWorkspace: () => 'w', timer: {} })
    await ui.refresh()
    expect(els['dev-sync-full-status'].textContent).toContain('上次完整对齐：')
    expect(els['dev-sync-full-status'].textContent).not.toContain('尚未完成')
    handlers['dev-sync-full:click']()
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('pet_memory_sync_run', { workspaceId: 'w', full: true }))
  })

  it('lets the user recover a retained queued version after the cloud record disappeared', async () => {
    const { doc, els } = fakeDoc()
    const saved = { id: 'a', payload: '{"title":"待接收","body":"已保留"}', deleted: false, device: 'old-server' }
    const state = { ...base, conflicts: [{ id: 'a', local: null, remote: { ...saved, deleted: true, payload: '', device: '' }, remoteMissing: true, alternatives: [saved] }] }
    const invoke = vi.fn(async () => state)
    const ui = mountMemorySync({ doc, invoke, listen: () => {}, getWorkspace: () => 'w', timer: {} })
    await ui.refresh()
    const choose = Object.values(els).find((el: any) => el.textContent === '采用已保留版本 1') as any
    expect(choose).toBeDefined()
    expect(Object.values(els).some((el: any) => el.textContent.includes('当前云端（记录缺失）'))).toBe(true)
    choose.handlers.click()
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('pet_memory_sync', { workspaceId: 'w', request: { op: 'resolve', id: 'a', choice: 'saved:0', scope: 'scope-a' } }))
  })
})
