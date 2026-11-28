// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteHostsPanel } from '../src/client/remote-hosts-panel.tsx'

const target = { version: '0.1.0', dshSha: 'abc', dshTag: 'test' }
const host = { id: 'host-1', name: 'Build server', address: '10.0.0.5', port: 22, user: 'lumo', auth: { kind: 'agent' }, state: 'installed',
  probe: { os: 'linux', arch: 'arm64', deps: { node: 'v24.1.0', curl: '8', tar: '1.35' }, installed: { version: target.version, dshSha: target.dshSha } } }
let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
const button = (name: string) => [...container.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent) === name)!
const click = async (name: string) => act(async () => { button(name).click() })
const field = () => container.querySelector<HTMLInputElement>('input[required]')

describe('remote machine controls', () => {
  it('keeps tunnel creation behind the existing approval API', async () => {
    let requested = false, approved = false
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/tunnel')) { requested = true; return Response.json({ ok: true }) }
      if (path.endsWith('/answer')) { approved = true; return Response.json({ ok: true }) }
      if (path.endsWith('/asks')) return Response.json({ asks: requested && !approved ? [{ id: 'ask1', title: '建立隧道', status: 'pending', expires_at: new Date(Date.now() + 60000).toISOString() }] : [] })
      return Response.json({ hosts: [{ ...host, ...(approved ? { state: 'connected', tunnel: { status: 'up', localPort: 3081 } } : {}) }], target })
    })
    vi.stubGlobal('fetch', fetch)
    await act(async () => root.render(<RemoteHostsPanel />))
    await click('建立隧道')
    expect(container.querySelector('[aria-label=待批准]')).toBeTruthy()
    expect(container.querySelector('a')).toBeNull()
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/answer'))).toBe(false)
    await click('批准')
    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe('http://127.0.0.1:3081')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(fetch.mock.calls.find(([path]) => path.endsWith('/answer'))?.[1]?.body).toBe('{"value":"approve"}')
  })
  it('starts with a compact list and expands host entry only when requested', async () => {
    vi.stubGlobal('fetch', vi.fn(async path => Response.json(String(path).endsWith('/asks') ? { asks: [] } : { hosts: [host], target })))
    await act(async () => root.render(<RemoteHostsPanel />))
    expect(container.querySelector('article[aria-label="Build server"]')).toBeTruthy()
    expect(field()).toBeNull()
    await click('录入主机')
    expect(field()).toBe(document.activeElement)
    await click('取消')
    expect(field()).toBeNull()
  })
  it('refreshes asynchronous completion and disconnection without a manual refresh', async () => {
    vi.useFakeTimers()
    let state = 'connecting'
    const fetch = vi.fn(async path => Response.json(String(path).endsWith('/asks') ? { asks: [] } : { hosts: [{ ...host, state, tunnel: { status: state === 'connecting' ? 'starting' : state === 'connected' ? 'up' : 'down', localPort: 3081 } }], target }))
    vi.stubGlobal('fetch', fetch)
    await act(async () => root.render(<RemoteHostsPanel />))
    expect(container.querySelector('a')).toBeNull()
    expect(button('取消连接')).toBeTruthy()
    expect(button('探测').disabled).toBe(true)
    state = 'connected'
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(container.querySelector('a')?.getAttribute('href')).toBe('http://127.0.0.1:3081')
    expect(button('断开')).toBeTruthy()
    state = 'failed'
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(container.querySelector('a')).toBeNull()
    expect(button('建立隧道')).toBeTruthy()
  })
  it('pauses polling in background and refreshes on returning to the page', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async path => Response.json(String(path).endsWith('/asks') ? { asks: [] } : { hosts: [host], target }))
    vi.stubGlobal('fetch', fetch)
    await act(async () => root.render(<RemoteHostsPanel />))
    const initial = fetch.mock.calls.length
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetch).toHaveBeenCalledTimes(initial)
    hidden.mockReturnValue(false)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(fetch.mock.calls.length).toBeGreaterThan(initial)
    hidden.mockRestore()
  })
})
