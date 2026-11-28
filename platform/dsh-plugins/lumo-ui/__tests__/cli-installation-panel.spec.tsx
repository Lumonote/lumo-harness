// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CliInstallationPanel } from '../src/client/cli-installation-panel.tsx'

let container: HTMLDivElement, root: Root
const tool = { engineId: 'trae', supported: true, source: 'TRAE 官方安装器', directory: '/lumo/cli/trae' }
const result = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const open = async () => act(async () => { const details = container.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })

it('loads on demand, starts online installation and retains progress after reopening', async () => {
  let current: any = tool
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') current = { ...tool, job: { id: JSON.parse(init.body as string).requestId, status: 'running', stage: '下载与安装', log: 'downloading', action: 'install' } }
    return result({ tool: current })
  })
  vi.stubGlobal('fetch', fetch)
  await act(async () => root.render(<CliInstallationPanel engineId="trae" available={false} onChanged={vi.fn()} />))
  expect(fetch).not.toHaveBeenCalled(); await open()
  await act(async () => button('在线安装').click())
  expect(JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as string)).toMatchObject({ action: 'install', version: 'latest' })
  expect(container.textContent).toContain('下载与安装'); expect(button('在线安装').disabled).toBe(true)
  await act(async () => { const d = container.querySelector('details')!; d.open = false; d.dispatchEvent(new Event('toggle')) })
  await open(); expect(container.textContent).toContain('downloading'); expect(button('取消安装')).toBeTruthy()
})

it('uses the installed version for reinstall and refreshes the shared engine catalog after success', async () => {
  let current: any = { ...tool, installation: { version: '0.217.0' } }
  const changed = vi.fn(), fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') current = { ...current, job: { id: 'done', status: 'succeeded', stage: '安装完成', log: 'verified' } }
    return result({ tool: current })
  })
  vi.stubGlobal('fetch', fetch)
  await act(async () => root.render(<CliInstallationPanel engineId="trae" available onChanged={changed} />)); await open()
  await act(async () => button('重新安装').click())
  expect(JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as string)).toMatchObject({ action: 'reinstall', version: '0.217.0' })
  expect(changed).toHaveBeenCalledTimes(1); expect(container.textContent).toContain('后续连接使用此版本')
})

it('shows disk failure, offers retry and discards a late response after switching tools', async () => {
  let finish!: (response: Response) => void
  const fetch = vi.fn(async (path: string) => path.includes('/codex/') ? new Promise<Response>(resolve => { finish = resolve })
    : result({ tool: { ...tool, job: { status: 'failed', stage: '安装失败', error: '磁盘空间不足', action: 'install' } } }))
  vi.stubGlobal('fetch', fetch)
  await act(async () => root.render(<CliInstallationPanel key="codex" engineId="codex" available onChanged={vi.fn()} />)); await open()
  await act(async () => root.render(<CliInstallationPanel key="trae" engineId="trae" available={false} onChanged={vi.fn()} />)); await open()
  await act(async () => finish(result({ tool: { ...tool, engineId: 'codex', installation: { version: 'wrong' } } })))
  expect(container.textContent).toContain('磁盘空间不足'); expect(button('重试安装')).toBeTruthy(); expect(container.textContent).not.toContain('wrong')
})
