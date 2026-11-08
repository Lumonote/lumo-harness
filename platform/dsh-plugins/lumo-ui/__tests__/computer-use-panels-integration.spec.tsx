// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerUsePanel } from '../src/client/computer-use-panel.tsx'
import { installComputerUseServices } from '../src/client/computer-use-services.ts'
import type { ComputerUseStatus } from '../src/computer-use-api.ts'

const disabled: ComputerUseStatus = { enabled: false, phase: 'disabled', authorizedSessionId: null, ownerSessionId: null, startedAt: null, lastActivityAt: null, inFlight: 0, events: [], provider: 'dsh-cua', platform: 'darwin', nativeSupport: true, controlRevision: 0 }
const ready: ComputerUseStatus = { ...disabled, enabled: true, phase: 'ready', authorizedSessionId: 'session-local', controlRevision: 1 }
const requestId = 'a'.repeat(43), digest = 'sha256:' + 'b'.repeat(64)
const remote = { envelope: { version: 1, request_id: requestId, digest, plan_json: '{}' }, plan: { realm: 'r', node_id: 'laptop-1', owner_user_id: 'local-owner', project_id: 'project-remote', session_ref: 'session-remote', capability: 'computer.observe', expires_at: '2099-01-01T00:00:00Z', intent: '核对远程请求', channel: 'feishu', subject: 'group-1', sender_user_id: 'employee-1', team_id: 'team-1', agent_id: 'agent-1' }, state: 'pending', revision: 1, summary: '' }
const disposers: Array<() => void> = []
afterEach(() => { cleanup(); disposers.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.useRealTimers() })
const settled = async () => { await act(async () => {}) }
function mount(dispatch: (url: string, init?: RequestInit) => Promise<Response>) {
  const snapshot = { phase: 'ready', byId: { 'session-local': { displayTitle: '本机对话', retainedBy: { mainView: 1 } } } }
  disposers.push(installComputerUseServices(window, { sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }, layout: { selectPanel: vi.fn() } }))
  const fetcher = vi.fn(dispatch); vi.stubGlobal('fetch', fetcher)
  const view = render(<ComputerUsePanel onClose={vi.fn()} />)
  return { fetcher, view }
}

describe('combined local controls and remote request confirmation', () => {
  it('loads local status and the remote list independently with concurrent URL-scoped requests', async () => {
    let finishLocal!: (response: Response) => void, finishRemote!: (response: Response) => void
    const f = mount((url) => {
      if (url === '/lumo/api/computer-use') return new Promise(resolve => { finishLocal = resolve })
      if (url === '/lumo/api/remote-computer') return new Promise(resolve => { finishRemote = resolve })
      throw Error('unexpected URL ' + url)
    })
    expect(f.fetcher.mock.calls.map(([url]) => url).sort()).toEqual(['/lumo/api/computer-use', '/lumo/api/remote-computer'])
    await act(async () => { finishRemote(Response.json({ requests: [remote] })) })
    expect(screen.getByRole('heading', { name: '远程操作请求' })).toBeTruthy()
    expect(screen.getByText('目标 laptop-1 · 对话 session-remote')).toBeTruthy()
    expect((screen.getByRole('button', { name: '允许此次请求' }) as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { finishLocal(Response.json(disabled)) })
    expect(screen.getByRole('heading', { name: '电脑操作' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps remote confirmation usable when the separate local control status fails', async () => {
    const f = mount(async (url, init) => {
      if (url === '/lumo/api/computer-use') return Response.json({}, { status: 500 })
      if (url === '/lumo/api/remote-computer') return Response.json({ requests: [remote] })
      if (url === `/lumo/api/remote-computer/${requestId}/decide`) {
        expect(init?.body).toBe(JSON.stringify({ digest, approve: false }))
        return Response.json({ requests: [{ ...remote, state: 'denied' }] })
      }
      throw Error('unexpected URL ' + url)
    })
    await settled()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' })); await settled()
    expect(screen.getByText('已拒绝 · 仅观察')).toBeTruthy()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/enable'))).toBe(false)
  })

  it('keeps local session authorization usable when the remote request read fails', async () => {
    const f = mount(async (url, init) => {
      if (url === '/lumo/api/computer-use') return Response.json(disabled)
      if (url === '/lumo/api/remote-computer') return Response.json({}, { status: 500 })
      if (url === '/lumo/api/computer-use/enable') {
        expect(init?.body).toBe(JSON.stringify({ sessionId: 'session-local', controlRevision: 0 }))
        return Response.json(ready)
      }
      throw Error('unexpected URL ' + url)
    })
    await settled()
    expect(screen.getByRole('alert').textContent).toContain('远程请求读取失败')
    expect((screen.getByRole('button', { name: '允许当前对话操作电脑' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '允许当前对话操作电脑' })); await settled()
    expect(screen.getByText('等待当前对话调用')).toBeTruthy()
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/decide'))).toBe(false)
  })

  it('hides an unavailable remote service while preserving the local stop control', async () => {
    const f = mount(async (url) => {
      if (url === '/lumo/api/computer-use') return Response.json(ready)
      if (url === '/lumo/api/remote-computer') return Response.json({}, { status: 503 })
      if (url === '/lumo/api/computer-use/stop') return Response.json({ ...disabled, controlRevision: 2 })
      throw Error('unexpected URL ' + url)
    })
    await settled()
    expect(screen.queryByRole('heading', { name: '远程操作请求' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '立即停止' })); await settled()
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect(f.fetcher).toHaveBeenLastCalledWith('/lumo/api/computer-use/stop', expect.objectContaining({ method: 'POST', body: '{}' }))
  })
})
