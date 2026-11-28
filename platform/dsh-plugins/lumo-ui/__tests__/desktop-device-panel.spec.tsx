// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DesktopDevicePanel, type DeviceSnapshot } from '../src/client/desktop-device-panel.tsx'
import { loadSharedServerBook } from '../src/client/shared-server-book.ts'
import { SERVER_BOOK_KEY } from '../src/client/server-book.ts'

let host: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals() })
const snapshot: DeviceSnapshot = { available: true, config: { gateway: 'https://device.example.com', realm: 'team', node_id: 'laptop', trust_file: '/trusted/publishers.json', server_ca: '', task_runner_socket: '', allowed_digests: [], client_version: '0.1.0' }, status: { state: 'connecting', connected: false, paused: false, process_running: true, certificate_expires: '2026-11-29T00:00:00Z', certificate_valid: true } }
it('does not treat a running process as a connected device and sends pause through the local API', async () => {
  const fetcher = vi.fn(async (path: string) => Response.json(path.endsWith('/pause') ? { ...snapshot, status: { ...snapshot.status, desired_paused: true } } : snapshot))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => root.render(<DesktopDevicePanel servers={[]} />))
  expect(host.textContent).toContain('正在连接设备网关'); expect(host.textContent).not.toContain('设备通道已连接')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '暂停接单')!.click())
  expect(fetcher).toHaveBeenCalledWith('/lumo/api/environment/device/pause', expect.objectContaining({ method: 'POST' }))
  expect(host.textContent).toContain('正在暂停接单')
})
it('migrates browser addresses through an atomic merge and clears legacy data only after success', async () => {
  localStorage.setItem(SERVER_BOOK_KEY, JSON.stringify([{ name: 'Old', origin: 'https://old.example.com' }]))
  let fail = true
  const fetcher = vi.fn(async (_: string, init: RequestInit) => init.method === 'POST' && fail ? Response.json({ error: 'disk full' }, { status: 400 }) : Response.json({ servers: [{ name: 'Old', origin: 'https://old.example.com' }] }))
  vi.stubGlobal('fetch', fetcher)
  await expect(loadSharedServerBook(true)).rejects.toThrow('disk full')
  expect(localStorage.getItem(SERVER_BOOK_KEY)).not.toBeNull()
  fail = false
  expect((await loadSharedServerBook(true)).native).toBe(true)
  expect(localStorage.getItem(SERVER_BOOK_KEY)).toBeNull()
})
