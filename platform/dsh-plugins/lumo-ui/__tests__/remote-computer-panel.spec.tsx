// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteComputerPanel } from '../src/client/remote-computer-panel.tsx'
import type { RemoteComputerLocalRequest } from '../../../shared/seam-contracts/remote-computer.ts'

const id = 'a'.repeat(43), digest = 'sha256:' + 'b'.repeat(64)
function request(overrides: Partial<RemoteComputerLocalRequest> = {}): RemoteComputerLocalRequest {
  return { envelope: { version: 1, request_id: id, digest, plan_json: '{}' }, plan: { realm: 'realm-1', node_id: 'laptop-1', owner_user_id: 'local-owner', project_id: 'project-1', session_ref: 'session-1', capability: 'computer.observe', expires_at: '2099-01-01T12:00:00Z', intent: '查看目标应用', channel: 'feishu', subject: 'group-1', sender_user_id: 'employee-1', team_id: 'team-1', agent_id: 'agent-1' }, state: 'pending', revision: 1, summary: '', ...overrides }
}
const response = (rows: unknown[] = [request()]) => Response.json({ requests: rows })
function mount(rows: unknown[] = [request()], strict = false) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response(rows)); vi.stubGlobal('fetch', fetcher)
  const panel = <RemoteComputerPanel />, view = render(strict ? <StrictMode>{panel}</StrictMode> : panel)
  return { fetcher, view }
}
const settled = async () => { await act(async () => {}) }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('local human confirmation of remote computer requests', () => {
  it('shows target, source, scope, capability and expiry before offering an explicit decision', async () => {
    const f = mount(); await settled()
    expect(screen.getByText('查看目标应用')).toBeTruthy()
    expect(screen.getByText('等待本机确认 · 仅观察')).toBeTruthy()
    expect(screen.getByText('来源 feishu / group-1 · 发起人 employee-1')).toBeTruthy()
    expect(screen.getByText('团队 team-1 · 项目 project-1')).toBeTruthy()
    expect(screen.getByText('目标 laptop-1 · 对话 session-1')).toBeTruthy()
    expect(screen.getByText(/截止 /).textContent).toContain('2099')
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith('/lumo/api/remote-computer', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(f.fetcher.mock.calls[0]![1]).not.toHaveProperty('body')
  })

  it.each([['允许此次请求', true, 'running'], ['拒绝', false, 'denied']] as const)('submits %s once with only the observed exact digest', async (label, approve, state) => {
    const f = mount(); await settled()
    f.fetcher.mockResolvedValueOnce(response([request({ state })]))
    fireEvent.click(screen.getByRole('button', { name: label })); await settled()
    expect(f.fetcher).toHaveBeenLastCalledWith(`/lumo/api/remote-computer/${id}/decide`, expect.objectContaining({ credentials: 'same-origin', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ digest, approve }) }))
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '允许此次请求' })).toBeNull()
  })

  it('revokes one running request with its exact digest and never supplies an owner or session', async () => {
    const f = mount([request({ state: 'running' })]); await settled()
    f.fetcher.mockResolvedValueOnce(response([request({ state: 'cancelled', summary: '本机用户已停止' })]))
    fireEvent.click(screen.getByRole('button', { name: '停止此次请求' })); await settled()
    expect(f.fetcher).toHaveBeenLastCalledWith(`/lumo/api/remote-computer/${id}/revoke`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ digest }) }))
    expect(screen.getByText('本机用户已停止')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '停止此次请求' })).toBeNull()
  })

  it('disables an expired approval while preserving an explicit denial', async () => {
    const row = request(); row.plan.expires_at = '2000-01-01T00:00:00Z'
    const f = mount([row]); await settled()
    const approve = screen.getByRole('button', { name: '允许此次请求' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true); fireEvent.click(approve)
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(false)
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['conflict', 'connection loss'] as const)('does not automatically replay a decision after %s', async kind => {
    vi.useFakeTimers()
    const f = mount(); await settled()
    if (kind === 'conflict') f.fetcher.mockResolvedValueOnce(Response.json({ error: 'stale' }, { status: 409 }))
    else f.fetcher.mockRejectedValueOnce(Error('connection lost after commit'))
    fireEvent.click(screen.getByRole('button', { name: '允许此次请求' })); await settled()
    expect(screen.getByRole('alert').textContent).toContain('不会自动再次执行')
    expect((screen.getByRole('button', { name: '允许此次请求' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { vi.advanceTimersByTime(9000) })
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(f.fetcher.mock.calls.slice(2).every(([, init]) => init?.method === undefined)).toBe(true)
  })

  it('blocks other decisions and automatic polls while one explicit mutation is pending', async () => {
    vi.useFakeTimers()
    const second = request({ envelope: { version: 1, request_id: 'c'.repeat(43), digest: 'sha256:' + 'd'.repeat(64), plan_json: '{}' } })
    const f = mount([request(), second]); await settled()
    let finish!: (value: Response) => void
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getAllByRole('button', { name: '允许此次请求' })[0]!)
    expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    await act(async () => { vi.advanceTimersByTime(6000) })
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { finish(response([request({ state: 'running' }), second])) })
    expect((screen.getByRole('button', { name: '停止此次请求' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('uses a fresh digest only after an explicit status reread following a stale decision', async () => {
    const f = mount(); await settled()
    f.fetcher.mockResolvedValueOnce(Response.json({ error: 'stale' }, { status: 409 }))
    fireEvent.click(screen.getByRole('button', { name: '允许此次请求' })); await settled()
    const fresh = request({ envelope: { version: 1, request_id: id, digest: 'sha256:' + 'c'.repeat(64), plan_json: '{}' } })
    fresh.plan.intent = '核对更新后的目标'
    f.fetcher.mockResolvedValueOnce(response([fresh]))
    fireEvent.click(screen.getByRole('button', { name: '刷新' })); await settled()
    expect(screen.getByText('核对更新后的目标')).toBeTruthy()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    f.fetcher.mockResolvedValueOnce(response([request({ state: 'running' })]))
    fireEvent.click(screen.getByRole('button', { name: '允许此次请求' })); await settled()
    expect(f.fetcher.mock.calls.at(-1)![1]!.body).toBe(JSON.stringify({ digest: fresh.envelope.digest, approve: true }))
  })

  it('clears prior private request facts when local browser authentication expires', async () => {
    const f = mount(); await settled()
    f.fetcher.mockResolvedValueOnce(Response.json({ error: 'browser_auth_required' }, { status: 401 }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' })); await settled()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByText('查看目标应用')).toBeNull()
    expect(screen.queryByRole('button', { name: '允许此次请求' })).toBeNull()
  })

  it('keeps a timed-out mutation uncertain even if its delayed response ignores cancellation', async () => {
    vi.useFakeTimers()
    const f = mount(); await settled()
    let finish!: (value: Response) => void
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '允许此次请求' }))
    const signal = f.fetcher.mock.calls.at(-1)![1]!.signal
    await act(async () => { vi.advanceTimersByTime(10001) })
    expect(signal?.aborted).toBe(true)
    await act(async () => { finish(response([request({ state: 'running', summary: 'late receipt' })])) })
    expect(screen.getByRole('alert').textContent).toContain('尚未确认')
    expect(screen.queryByText('late receipt')).toBeNull()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('ignores a late obsolete read after a newer explicit refresh', async () => {
    let finish!: (value: Response) => void
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    render(<RemoteComputerPanel />)
    const firstSignal = fetcher.mock.calls[0]![1]!.signal
    // A failed first load exposes the refresh control; the next background
    // read is then superseded by an explicit user refresh.
    await act(async () => { finish(Response.json({}, { status: 500 })) })
    let finishOld!: (value: Response) => void
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    const oldSignal = fetcher.mock.calls.at(-1)![1]!.signal
    fetcher.mockResolvedValueOnce(response([request({ state: 'completed', summary: 'current receipt' })]))
    fireEvent.click(screen.getByRole('button', { name: '刷新' })); await settled()
    expect(firstSignal?.aborted).toBe(true); expect(oldSignal?.aborted).toBe(true)
    await act(async () => { finishOld(response([request({ state: 'pending', summary: 'obsolete receipt' })])) })
    expect(screen.getByText('current receipt')).toBeTruthy(); expect(screen.queryByText('obsolete receipt')).toBeNull()
    expect(screen.queryByRole('button', { name: '允许此次请求' })).toBeNull()
  })

  it('aborts on unmount and keeps a late old mutation out of the next panel', async () => {
    const f = mount(); await settled()
    let finish!: (value: Response) => void
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '允许此次请求' }))
    const signal = f.fetcher.mock.calls.at(-1)![1]!.signal
    f.view.unmount(); expect(signal?.aborted).toBe(true)
    f.fetcher.mockResolvedValueOnce(response([])); render(<RemoteComputerPanel />); await settled()
    await act(async () => { finish(response([request({ state: 'running', summary: 'old private request' })])) })
    expect(screen.getByText('暂无远程操作请求。')).toBeTruthy()
    expect(screen.queryByText('old private request')).toBeNull()
  })

  it('shows an unknown outcome without presenting another execution button', async () => {
    const f = mount([request({ state: 'unknown', summary: '等待核对外部效果' })]); await settled()
    expect(screen.getByText('结果待核对 · 仅观察')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '允许此次请求' })).toBeNull()
    expect(screen.queryByRole('button', { name: '停止此次请求' })).toBeNull()
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })

  it('restarts passive loading under StrictMode and isolates the first late response', async () => {
    const f = mount([], true); await settled()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true)
    expect(screen.getByText('暂无远程操作请求。')).toBeTruthy()
  })

  it.each([null, { requests: 'wrong' }, { requests: [request({ state: 'toString' as never })] }, { requests: [{ ...request(), envelope: { request_id: 'bad', digest } }] }, { requests: [{ ...request(), summary: { unsafe: 'object' } }] }])('refuses malformed data before offering desktop authority: %j', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)))
    render(<RemoteComputerPanel />); await settled()
    expect(screen.getByRole('alert').textContent).toContain('读取失败')
    expect(screen.queryByRole('button', { name: '允许此次请求' })).toBeNull()
  })
})
