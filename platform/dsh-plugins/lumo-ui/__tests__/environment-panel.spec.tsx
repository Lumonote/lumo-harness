// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentEntry, EnvironmentPanel } from '../src/client/environment-panel.tsx'
import { installEnvironmentConnection } from '../src/client/environment-connection.ts'
import { readServerBook, serverOrigin, SERVER_BOOK_KEY, updateServerBook } from '../src/client/server-book.ts'
import { MarketSurface } from '../src/client/market-surface.tsx'
import { takeOperationsTarget } from '../src/client/operations-navigation.ts'
import type { DeploymentState } from '../src/client/surface-types.ts'

const deployment: DeploymentState = { mode: 'local', label: '本地', storage: 'sqlite', middleware: [], distributed: false, desktop: true, clusterReady: false, clusterOnly: false }
const props = { deployment, navigate: vi.fn(), refresh: vi.fn(), loading: false }
let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); takeOperationsTarget(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = async (node: ReactNode) => act(async () => root.render(node))
const button = (name: string) => [...container.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent) === name)!
const field = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
const link = (name: string) => container.querySelector<HTMLAnchorElement>(`a[aria-label="${name}"]`)
const click = async (name: string) => act(async () => { button(name).click() })
const change = async (name: string, value: string) => act(async () => { const input = field(name); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })

describe('server addresses and isolated login', () => {
  it.each(['javascript:alert(1)', 'file:///tmp/a', 'http://server.example', 'https://u:p@server.example', 'https://server.example/path', 'https://server.example/?token=secret', 'https://server.example/#secret', 'https://server.example\\@evil.example', 'https://ser\nver.example', ''])('rejects unsafe or credential-bearing server input %s', input => {
    expect(() => serverOrigin(input)).toThrow()
  })
  it('normalizes HTTPS addresses and accepts loopback SSH forward ports', () => {
    expect(serverOrigin(' https://SERVER.example:443/ ')).toBe('https://server.example')
    expect(serverOrigin('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
    expect(serverOrigin('http://[::1]:3080')).toBe('http://[::1]:3080')
  })
  it('preserves unrelated records and rejects duplicates, stale edits and full books', () => {
    updateServerBook({ save: { name: 'A', origin: 'https://a.example' } })
    updateServerBook({ save: { name: 'B', origin: 'https://b.example' } })
    expect(() => updateServerBook({ save: { name: 'again', origin: 'https://a.example/' } })).toThrow('已在')
    updateServerBook({ save: { name: 'Renamed', origin: 'https://a.example' }, previous: 'https://a.example' })
    expect(readServerBook().map(item => item.name)).toEqual(['Renamed', 'B'])
    updateServerBook({ remove: 'https://a.example' })
    expect(() => updateServerBook({ save: { name: 'A', origin: 'https://a.example' }, previous: 'https://a.example' })).toThrow('记录已变化')
    for (let n = 0; n < 11; n++) updateServerBook({ save: { name: String(n), origin: `https://s${n}.example` } })
    expect(() => updateServerBook({ save: { name: 'overflow', origin: 'https://full.example' } })).toThrow('最多')
  })
  it('does not overwrite corrupted or unsafe persisted records', () => {
    const raw = JSON.stringify([{ name: 'Unsafe', origin: 'javascript:alert(1)' }])
    localStorage.setItem(SERVER_BOOK_KEY, raw)
    expect(() => updateServerBook({ save: { name: 'Safe', origin: 'https://safe.example' } })).toThrow('未被覆盖')
    expect(localStorage.getItem(SERVER_BOOK_KEY)).toBe(raw)
  })
  it('saves, edits and removes servers without making cross-origin requests or claiming connection success', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await render(<EnvironmentPanel {...props} deployment={{ ...deployment, desktop: false }} />)
    await click('添加服务器')
    await change('服务器名称', '团队')
    await change('服务器地址', 'https://team.example')
    await click('保存')
    const anchor = link('连接 团队')!
    expect(anchor.getAttribute('href')).toBe('https://team.example')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(container.textContent).not.toContain('已连接')
    await click('编辑 团队')
    await change('服务器名称', '生产')
    await click('保存')
    expect(readServerBook()).toEqual([{ name: '生产', origin: 'https://team.example' }])
    await click('移除 生产')
    expect(readServerBook()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps input and explains write failures', async () => {
    await render(<EnvironmentPanel {...props} deployment={{ ...deployment, desktop: false }} />)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('存储不可用') })
    await click('添加服务器')
    await change('服务器名称', '团队')
    await change('服务器地址', 'https://team.example')
    await click('保存')
    expect(container.querySelector('[role=alert]')?.textContent).toContain('存储不可用')
    expect((field('服务器名称') as HTMLInputElement).value).toBe('团队')
  })
})

describe('native environment controls', () => {
  it('tracks the host lifecycle, reconnects through the public service, and withdraws on disposal', async () => {
    let state: 'connected' | 'connecting' | 'disconnected' = 'connected'
    const listeners = new Set<() => void>(), reconnect = vi.fn()
    const dispose = installEnvironmentConnection({ reconnect, state: { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } } })
    await render(<EnvironmentPanel {...props} />)
    expect(container.textContent?.includes('已连接')).toBeTruthy()
    await click('重新连接')
    expect(reconnect).toHaveBeenCalledOnce()
    act(() => { state = 'connecting'; listeners.forEach(listener => listener()) })
    expect((button('重新连接') as HTMLButtonElement).disabled).toBe(true)
    act(() => { state = 'disconnected'; listeners.forEach(listener => listener()) })
    expect(container.textContent?.includes('连接中断')).toBeTruthy()
    act(dispose)
    expect(listeners.size).toBe(0)
    expect(button('重新连接')).toBeUndefined()
  })
  it('opens the connection page from the conversation footer and consumes its navigation intent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ deployment })))
    await render(<EnvironmentEntry />)
    await click('环境与连接')
    await render(null)
    await render(<MarketSurface onClose={vi.fn()} renderOperations={area => <p>{area}</p>} renderSurface={() => null} />)
    expect(container.querySelector('[aria-label=当前环境]')).toBeTruthy()
    expect(takeOperationsTarget()).toBeNull()
    await click('SSH 远端机器')
    expect(container.textContent?.includes('hosts')).toBeTruthy()
  })
  it('uses actual deployment readiness and hides SSH controls for a server environment', async () => {
    await render(<EnvironmentPanel {...props} deployment={{ ...deployment, mode: 'cluster', clusterReady: false }} />)
    expect(container.textContent?.includes('集群尚未就绪')).toBeTruthy()
    expect(button('SSH 远端机器')).toBeUndefined()
    await click('集群与服务')
    expect(props.navigate).toHaveBeenCalledWith('operations')
  })
  it('keeps saved servers accessible while the current host is unavailable', async () => {
    updateServerBook({ save: { name: '备选', origin: 'https://alternate.example' } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('offline')))
    await render(<MarketSurface onClose={vi.fn()} renderOperations={() => null} renderSurface={() => null} />)
    expect(link('连接 备选')!).toBeTruthy()
    expect(container.textContent?.includes('环境信息不可用')).toBeTruthy()
    expect(button('集群与服务')).toBeUndefined()
  })
})
