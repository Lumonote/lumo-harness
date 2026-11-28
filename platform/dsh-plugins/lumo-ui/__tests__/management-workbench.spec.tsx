// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketSurface } from '../src/client/market-surface.tsx'
import { SettingsManagement } from '../src/client/settings-management.tsx'
import { OPEN_EVENT, navigationSurfaces } from '../src/client/surface-navigation.ts'
import { WorkbenchRail } from '../src/client/surface-shell.tsx'
import { managementEntries } from '../src/client/management-catalog.ts'

const runtime = { deployment: { mode: 'cluster', clusterReady: true }, plugins: [] }
const props = { onClose: vi.fn(), renderOperations: (area: string) => <p>正在管理 {area}</p>, renderSurface: (surface: string) => <p>正在配置 {surface}</p> }
let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const render = async (node: ReactNode) => act(async () => root.render(node))
const button = (name: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.startsWith(name))!
const click = async (name: string) => act(async () => { button(name).click() })
const fixture = (local = false) => {
  const request = vi.fn(async (input: string | URL | Request) => {
    const path = String(input)
    if (path === '/lumo/api/overview') return Response.json(local ? { ...runtime, deployment: { mode: 'local', clusterReady: false } } : runtime)
    if (path === '/auth/account') return Response.json({ roles: ['realm_admin'] })
    if (path === '/lumo/api/capabilities') return Response.json({ organization: true })
    return Response.json({ items: [] })
  })
  vi.stubGlobal('fetch', request)
  return request
}

describe('settings-owned management workbench', () => {
  it('closes settings before opening management', async () => {
    const sequence: string[] = []
    const open = (event: Event) => sequence.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_EVENT, open)
    vi.useFakeTimers()
    try {
      await render(<SettingsManagement close={() => sequence.push('closed')} />)
      await click('打开管理工作台')
      expect(sequence).toEqual(['closed'])
      await act(async () => { await vi.runAllTimersAsync() })
      expect(sequence).toEqual(['closed', 'market'])
    } finally { window.removeEventListener(OPEN_EVENT, open); vi.useRealTimers() }
  })
  it.each([false, true])('omits creation and management from both sidebar navigation lists (local=%s)', async local => {
    const available = navigationSurfaces(local)
    await render(<WorkbenchRail surface="market" available={available} select={vi.fn()} />)
    expect(available.some(surface => ['market', 'operations', 'design', 'presentation'].includes(surface))).toBe(false)
    const navigation = container.querySelector('nav[aria-label="工作领域"]')!
    expect(navigation.textContent).not.toMatch(/管理工作台|工作工具|项目运营|开放设计|PPT/)
  })
  it('keeps management categories together and loads registry only when selected', async () => {
    const request = fixture()
    await render(<MarketSurface {...props} />)
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '灰度')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('项目资产')).toBeUndefined()
    expect(request.mock.calls.some(([path]) => String(path).includes('/registry/'))).toBe(false)
    await click('制品目录与灰度')
    expect(container.querySelector('[aria-label="能力生命周期"]')).not.toBeNull()
    expect(request.mock.calls.some(([path]) => String(path).includes('/registry/artifacts?'))).toBe(true)
    await click('项目与任务')
    expect(container.textContent).toContain('正在管理 projects')
    await click('协作执行')
    expect(container.textContent).toContain('正在管理 delivery')
    await click('能力配置')
    expect(container.textContent).toContain('正在配置 skills')
    await click('全部管理')
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('')
  })
  it('offers local engine and host management without requesting organization or registry data', async () => {
    const request = fixture(true)
    await render(<MarketSurface {...props} />)
    await click('引擎会话')
    expect(container.textContent).toContain('正在管理 engines')
    expect(button('账户与权限')).toBeUndefined()
    expect(request.mock.calls.every(([path]) => path === '/lumo/api/overview')).toBe(true)
  })
  it('hides organization, recovery and platform usage from ordinary members', () => {
    const entries = managementEntries({ local: false, clusterReady: true, organization: false, platformAdmin: false }).map(entry => entry.id)
    for (const id of ['users', 'departments', 'roles', 'recovery', 'storage', 'token-usage']) expect(entries).not.toContain(id)
    expect(entries).toContain('permissions'); expect(entries).toContain('projects')
  })
  it('does not show guessed management capabilities after overview fails and supports retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await render(<MarketSurface {...props} />)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(button('集群与服务')).toBeUndefined()
    fixture(true)
    await click('重试')
    expect(button('本机状态')).toBeDefined()
  })
})
