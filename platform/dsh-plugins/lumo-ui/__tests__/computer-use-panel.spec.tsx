// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { ComputerUsePanel } from '../src/client/computer-use-panel.tsx'
import { installComputerUseServices, type ComputerUseClientServices } from '../src/client/computer-use-services.ts'
import type { ComputerUseStatus } from '../src/computer-use-api.ts'

const disabled: ComputerUseStatus = { enabled: false, phase: 'disabled', authorizedSessionId: null, ownerSessionId: null, startedAt: null, lastActivityAt: null, inFlight: 0, events: [], provider: 'dsh-cua', platform: 'darwin', nativeSupport: true, controlRevision: 0 }
const ready: ComputerUseStatus = { ...disabled, enabled: true, phase: 'ready', authorizedSessionId: 'session-1', controlRevision: 1 }
const disposers: Array<() => void> = []
afterEach(() => { cleanup(); disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.useRealTimers() })
function mount(status = disabled, selected = true, strict = false) {
  let snapshot: ReturnType<ComputerUseClientServices['sessions']['list']['getSnapshot']> = { phase: 'ready', byId: { 'session-1': { displayTitle: '整理桌面', retainedBy: { mainView: selected ? 1 : 0 } }, background: { displayTitle: '后台任务', retainedBy: { tool: 1 } } } }
  const listeners = new Set<() => void>()
  const list = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const selectPanel = vi.fn()
  disposers.push(installComputerUseServices(window, { sessions: { list }, layout: { selectPanel } }))
  const fetchMock = vi.fn(async () => Response.json(status))
  vi.stubGlobal('fetch', fetchMock)
  const onClose = vi.fn()
  const panel = <ComputerUsePanel onClose={onClose} />
  const view = render(strict ? <StrictMode>{panel}</StrictMode> : panel)
  return { fetchMock, selectPanel, onClose, view, list, select(id: string) { snapshot = { phase: 'ready', byId: { [id]: { displayTitle: '切换后的对话', retainedBy: { mainView: 1 } } } }; listeners.forEach(listener => listener()) }, listeners }
}
async function settled() { await act(async () => {}) }

describe('computer operation panel', () => {
  it('rejects malformed status instead of offering authorization', async () => {
    mount({ ...disabled, phase: 'unknown' } as unknown as ComputerUseStatus)
    await settled()
    expect(screen.queryByRole('alert')?.textContent).toContain('状态响应无效')
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('blocks authorization after a failed poll until fresh status is read', async () => {
    vi.useFakeTimers()
    const test = mount()
    await settled()
    test.fetchMock.mockRejectedValueOnce(Error('offline'))
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('alert').textContent).toContain('保留上次成功读取的状态')
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await settled()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('restarts status loading after StrictMode effect cleanup', async () => {
    const test = mount(disabled, true, true)
    await settled()
    expect(test.fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('已关闭')).not.toBeNull()
  })
  it.each([
    null,
    { ...disabled, events: null },
    { ...disabled, controlRevision: -1 },
    { ...disabled, inFlight: '0' },
    { ...disabled, enabled: true },
    { ...disabled, events: [{ id: 1, at: 9e15, sessionId: 'session-1', callId: 'call', tool: 'computer', method: null, state: 'succeeded' }] },
    { ...disabled, events: [{ id: 1, at: 1, sessionId: 'session-1', callId: 'call', tool: 'computer', method: null, state: 'unknown' }] },
  ])('keeps malformed payload %j out of the rendered state', async status => {
    mount(status as ComputerUseStatus)
    await settled()
    expect(screen.getByRole('alert').textContent).toContain('状态响应无效')
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('listitem')).toBeNull()
  })
  it('clears authorization details and events after browser authentication expires', async () => {
    vi.useFakeTimers()
    const test = mount({ ...ready, events: [{ id: 1, at: 1, sessionId: 'private-session', callId: 'call', tool: 'computer', method: 'private-action', state: 'succeeded' }] })
    await settled()
    expect(screen.getByText('private-action')).toBeTruthy()
    test.fetchMock.mockResolvedValueOnce(Response.json({ error: 'browser_auth_required' }, { status: 401 }))
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.getByRole('alert').textContent).toContain('本机浏览器登录已失效')
    expect(screen.getByRole('alert').textContent).not.toContain('保留上次')
    expect(screen.queryByText('private-action')).toBeNull()
    expect(screen.queryByText('等待当前对话调用')).toBeNull()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('discards pending authorization when the selected conversation changes', async () => {
    const test = mount()
    await settled()
    let finishEnable: ((response: Response) => void) | undefined
    test.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishEnable = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    const enableSignal = test.fetchMock.mock.calls.at(-1)?.[1]?.signal
    let finishRead: ((response: Response) => void) | undefined
    test.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve }))
    act(() => test.select('session-2'))
    expect(enableSignal?.aborted).toBe(true)
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finishEnable?.(Response.json(ready)) })
    expect(screen.queryByText('等待当前对话调用')).toBeNull()
    await act(async () => { finishRead?.(Response.json({ ...disabled, controlRevision: 2 })) })
    test.fetchMock.mockResolvedValueOnce(Response.json({ ...ready, authorizedSessionId: 'session-2', controlRevision: 3 }))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    await settled()
    expect(test.fetchMock).toHaveBeenLastCalledWith('/lumo/api/computer-use/enable', expect.objectContaining({ body: JSON.stringify({ sessionId: 'session-2', controlRevision: 2 }) }))
    expect(screen.getByRole('button', { name: '当前对话已获授权' })).toBeTruthy()
  })
  it('clears the previous service state and ignores its pending poll after client replacement', async () => {
    vi.useFakeTimers()
    const test = mount(ready)
    await settled()
    let finishOld: ((response: Response) => void) | undefined
    test.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve }))
    await act(async () => { vi.advanceTimersByTime(2000) })
    const oldSignal = test.fetchMock.mock.calls.at(-1)?.[1]?.signal
    let finishNew: ((response: Response) => void) | undefined
    test.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishNew = resolve }))
    act(() => { disposers.push(installComputerUseServices(window, { sessions: { list: test.list }, layout: { selectPanel: vi.fn() } })) })
    expect(oldSignal?.aborted).toBe(true)
    expect(screen.queryByText('等待当前对话调用')).toBeNull()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finishOld?.(Response.json(ready)) })
    expect(screen.queryByText('等待当前对话调用')).toBeNull()
    await act(async () => { finishNew?.(Response.json(disabled)) })
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it.each([
    { ...ready, authorizedSessionId: 'wrong-session' },
    { ...ready, controlRevision: 0 },
  ])('rejects an authorization receipt for the wrong scope or revision: %j', async receipt => {
    const test = mount()
    await settled()
    test.fetchMock.mockResolvedValueOnce(Response.json(receipt))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    await settled()
    expect(screen.getByRole('alert').textContent).toContain('状态响应无效')
    expect(screen.queryByText('等待当前对话调用')).toBeNull()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '立即停止' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('keeps stop available when the server returns an enabled stop receipt', async () => {
    const test = mount(ready)
    await settled()
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }))
    await settled()
    expect(screen.getByRole('alert').textContent).toContain('状态响应无效')
    expect((screen.getByRole('button', { name: '立即停止' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('authorizes only the actual selected session, follows session changes, and opens the public plugin panel', async () => {
    const test = mount()
    await screen.findByText('已关闭')
    test.fetchMock.mockResolvedValueOnce(Response.json(ready))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    await screen.findByText('等待当前对话调用')
    expect(test.fetchMock).toHaveBeenLastCalledWith('/lumo/api/computer-use/enable', expect.objectContaining({ credentials: 'same-origin', method: 'POST', body: JSON.stringify({ sessionId: 'session-1', controlRevision: 0 }) }))
    expect((screen.getByRole('button', { name: '当前对话已获授权' }) as HTMLButtonElement).disabled).toBe(true)
    test.fetchMock.mockResolvedValueOnce(Response.json(ready))
    act(() => test.select('session-2'))
    await settled()
    test.fetchMock.mockResolvedValueOnce(Response.json({ ...ready, authorizedSessionId: 'session-2', controlRevision: 2 }))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    await settled()
    expect(test.fetchMock).toHaveBeenLastCalledWith('/lumo/api/computer-use/enable', expect.objectContaining({ body: JSON.stringify({ sessionId: 'session-2', controlRevision: 1 }) }))
    fireEvent.click(screen.getByRole('button', { name: '前往插件' }))
    expect(test.selectPanel).toHaveBeenCalledExactlyOnceWith('plugins')
    expect(test.onClose).toHaveBeenCalledOnce()
  })
  it('requires an open conversation and available native provider before authorization', async () => {
    const test = mount({ ...disabled, provider: null }, false)
    await screen.findByText('已关闭')
    expect(screen.getByText('请先打开一个对话')).toBeTruthy()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => test.select('session-2'))
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect(test.fetchMock).toHaveBeenCalledTimes(2)
  })
  it('reports unsupported Windows truthfully and never offers OS authorization', async () => {
    mount({ ...disabled, platform: 'win32', nativeSupport: false })
    expect(await screen.findByText(/此功能需要 macOS 14 及以上，当前系统暂不可用/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /授予.*权限/ })).toBeNull()
  })
  it('does not claim a registered unsupported driver is usable', async () => {
    mount({ ...disabled, provider: 'mcp' })
    await screen.findByText('已关闭')
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('尚未启用')).toBeTruthy()
  })
  it('preserves the last known state when stopping fails and supports a successful retry', async () => {
    const test = mount({ ...ready, phase: 'running', ownerSessionId: 'session-1', inFlight: 2 })
    await screen.findByText('正在操作电脑')
    test.fetchMock.mockRejectedValueOnce(Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }))
    expect((await screen.findByRole('alert')).textContent).toContain('保留上次成功读取的状态')
    expect(screen.getByText('正在操作电脑')).toBeTruthy()
    test.fetchMock.mockResolvedValueOnce(Response.json({ ...disabled, phase: 'stopping', ownerSessionId: 'session-1', inFlight: 1 }))
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }))
    await screen.findByText('正在停止，等待已发出的操作结束')
    expect(test.fetchMock).toHaveBeenLastCalledWith('/lumo/api/computer-use/stop', expect.objectContaining({ method: 'POST', body: '{}' }))
    expect((screen.getByRole('button', { name: '正在停止…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('keeps plugin navigation failure actionable and displays a bounded event log', async () => {
    const test = mount({ ...ready, events: Array.from({ length: 60 }, (_, id) => ({ id, at: Date.now() + id, sessionId: 'session-1', callId: `call-${id}`, tool: 'computer', method: `action-${id}`, state: 'succeeded' })) })
    await screen.findByText('等待当前对话调用')
    expect(screen.getAllByRole('listitem')).toHaveLength(50)
    expect(screen.getAllByRole('listitem')[0]?.textContent).toContain('action-59')
    expect(screen.queryByText('action-0')).toBeNull()
    test.selectPanel.mockImplementationOnce(() => { throw Error('not_registered') })
    fireEvent.click(screen.getByRole('button', { name: '前往插件' }))
    expect(screen.getByRole('alert').textContent).toContain('插件面板尚未就绪')
    expect(test.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '前往插件' }))
    expect(test.onClose).toHaveBeenCalledOnce()
  })
  it('discards a late poll after stop and cancels polling and session subscriptions on unmount', async () => {
    vi.useFakeTimers()
    const test = mount(ready)
    await settled()
    let complete: ((response: Response) => void) | undefined
    test.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve }))
    await act(async () => { vi.advanceTimersByTime(2000) })
    const oldSignal = test.fetchMock.mock.calls.at(-1)?.[1]?.signal
    test.fetchMock.mockResolvedValueOnce(Response.json({ ...disabled, phase: 'stopping', inFlight: 1, ownerSessionId: 'session-1' }))
    fireEvent.click(screen.getByRole('button', { name: '立即停止' }))
    await settled()
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { complete?.(Response.json(ready)) })
    expect(screen.getByText('正在停止，等待已发出的操作结束')).toBeTruthy()
    test.view.unmount()
    const calls = test.fetchMock.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(6000) })
    expect(test.fetchMock).toHaveBeenCalledTimes(calls)
    expect(test.listeners.size).toBe(0)
  })
  it('times out a hanging read and makes retry available without losing the last status', async () => {
    vi.useFakeTimers()
    const test = mount(ready)
    await settled()
    test.fetchMock.mockImplementationOnce((_url, options) => new Promise<Response>((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('aborted'))) }))
    await act(async () => { vi.advanceTimersByTime(2000) })
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(screen.getByRole('alert').textContent).toContain('读取超时')
    expect(screen.getByText('等待当前对话调用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await settled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('can stop while authorization is pending and ignores its late successful response', async () => {
    const test = mount()
    await screen.findByText('已关闭')
    let finishEnable: ((response: Response) => void) | undefined
    test.fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishEnable = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    expect(screen.getByRole('button', { name: '正在授权…' })).toBeTruthy()
    const enableSignal = test.fetchMock.mock.calls.at(-1)?.[1]?.signal
    const stop = screen.getByRole('button', { name: '立即停止' }) as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    test.fetchMock.mockResolvedValueOnce(Response.json({ ...disabled, controlRevision: 1 }))
    fireEvent.click(stop)
    await settled()
    expect(enableSignal?.aborted).toBe(true)
    expect(test.fetchMock).toHaveBeenLastCalledWith('/lumo/api/computer-use/stop', expect.objectContaining({ method: 'POST', body: '{}' }))
    await act(async () => { finishEnable?.(Response.json(ready)) })
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect(screen.queryByText('等待当前对话调用')).toBeNull()
    test.fetchMock.mockResolvedValueOnce(Response.json({ ...ready, controlRevision: 2 }))
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' }))
    await settled()
    expect(test.fetchMock).toHaveBeenLastCalledWith('/lumo/api/computer-use/enable', expect.objectContaining({ body: JSON.stringify({ sessionId: 'session-1', controlRevision: 1 }) }))
  })
})
