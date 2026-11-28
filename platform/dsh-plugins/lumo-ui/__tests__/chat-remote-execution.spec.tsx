// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatRemoteExecution } from '../src/client/chat-remote-execution.tsx'
import { ApiError } from '../src/client/api.ts'
import { executionKey, executionPayload, type RemoteChatScope, type RemoteRequest } from '../src/client/chat-remote-api.ts'
import { writeDraft } from '../src/client/conversation-drafts.ts'

const scope: RemoteChatScope = { kind: 'session', id: 'chat-1', realm: 'realm', userId: 'user', projectId: 'project-1' }
const task = { id: 'task-1', title: 'Run project checks', intent: 'Run project checks', project_id: 'project-1', state: 'RUNNING', assigned_node_id: 'node-1', assignee_worker_id: 'agent:builder' }
const run = { id: 'run-1', task_id: 'task-1', attempt: 1, state: 'RUNNING', worker_id: 'agent:builder', assigned_node_id: 'node-1', session_ref: 'session-remote' }
let container: HTMLDivElement, root: Root
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const button = (name: string) => [...container.querySelectorAll('button')].find(el => (el.getAttribute('aria-label') ?? el.textContent) === name)!
const click = async (name: string) => act(async () => { button(name).click() })

function fixture() {
  let created = false, state = 'RUNNING', controlState = 'paused', lost = false, postCount = 0, clusterReady = true, denyPreview = false
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/lumo/api/capabilities') return { clusterReady }
    if (path.startsWith('/lumo/api/projects/directory')) return { viewer: { realm: 'realm', userId: 'user' }, projects: [{ id: 'project-1', name: 'Project One', status: 'active', yourRole: 'editor' }] }
    if (path === '/lumo/api/scheduler/clusters') return { clusters: [{ cluster_id: 'cluster-1', realm: 'realm', state: 'healthy' }] }
    if (path === '/lumo/api/delegations/preview') { if (denyPreview) throw new ApiError(403, { error: 'denied' }, 'denied'); return { candidates: [{ worker_id: 'agent:builder', display_name: 'Builder', eligible: true, rationale: ['项目允许'] }, { worker_id: 'agent:offline', display_name: 'Offline', eligible: false, rationale: [] }] } }
    if (path === '/lumo/api/delegations' && init?.method === 'POST') { postCount++; created = true; if (lost && postCount === 1) throw new TypeError('response lost'); return { task: { ...task, state }, run: { ...run, state } } }
    if (path === '/lumo/api/delegations/task-1') { if (!created) throw new Error('not created'); return { ...task, state } }
    if (path === '/lumo/api/tasks/task-1/runs') return { runs: [{ ...run, state }] }
    if (path === '/lumo/api/tasks/task-1/runs/run-1/result') { if (state !== 'COMPLETED') throw new ApiError(404, {}, 'pending'); return { task_id: task.id, run_id: run.id, state: 'COMPLETED', summary: 'Checks passed', output: '42 tests passed' } }
    if (path === '/lumo/api/tasks/task-1/runs/run-1/artifacts') return { artifacts: state === 'COMPLETED' ? [{ id: 'artifact-1', name: 'report.txt' }] : [] }
    if (path === '/lumo/api/sessions/session-remote/control') {
      if (init?.method === 'POST') controlState = JSON.parse(String(init.body)).command === 'resume' ? 'running' : 'paused'
      return { session_ref: 'session-remote', registered: true, state: controlState, base_state: 'running', revision: 2, available: [{ command: controlState === 'paused' ? 'resume' : 'pause', available: true, no_op: false, reason: '' }], queue: null }
    }
    if (path === '/lumo/api/delegations/task-1/cancel') { state = 'CANCELLING'; return { ...task, state } }
    throw new Error(`unexpected ${path}`)
  })
  return { request: request as typeof request & RemoteRequest, complete: () => { state = 'COMPLETED' }, loseResponse: () => { lost = true }, unavailable: () => { clusterReady = false }, deny: () => { denyPreview = true }, created: () => created }
}

describe('chat remote execution', () => {
  it('submits an explicit governed task and reads real paused state, completion and artifact content links', async () => {
    vi.useFakeTimers(); const f = fixture()
    await act(async () => root.render(<ChatRemoteExecution scope={scope} initialTask="Run project checks" request={f.request} />))
    expect(f.created()).toBe(false)
    await click('识别受管执行者')
    const select = container.querySelector<HTMLSelectElement>('[aria-label="远程受管执行者"]')!
    expect(select.value).toBe('agent:builder'); expect(select.options[2]?.disabled).toBe(true)
    await click('提交远程任务')
    const post = f.request.mock.calls.find(([path, init]) => path === '/lumo/api/delegations' && init?.method === 'POST')!
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ intent: 'Run project checks', project_id: 'project-1', assignee_worker_id: 'agent:builder', auto_assign: false, schedule: { requires: [{ key: 'subagent' }] } })
    expect(new Headers(post[1]?.headers).get('Idempotency-Key')).toBeTruthy()
    const status = container.querySelector('[aria-label="远程任务状态"]')!
    expect(status.textContent).toContain('已暂停'); expect(status.textContent).toContain('node-1'); expect(status.textContent).not.toContain('执行中')
    await click('恢复')
    expect(container.querySelector('[aria-label="远程任务状态"]')?.textContent).toContain('执行中')
    f.complete(); await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(container.textContent).toContain('Checks passed')
    expect(container.querySelector('a[download="report.txt"]')?.getAttribute('href')).toBe('/lumo/api/tasks/task-1/runs/run-1/artifacts/artifact-1/content')
    expect(container.textContent).toContain('task-1')
  })
  it('keeps the same persisted idempotency receipt across a lost response and remount', async () => {
    const f = fixture(); f.loseResponse()
    await act(async () => root.render(<ChatRemoteExecution scope={scope} initialTask="Run project checks" request={f.request} />))
    await click('识别受管执行者'); await click('提交远程任务')
    expect(container.textContent).toContain('上次提交尚待确认')
    await act(async () => root.render(<div />))
    await act(async () => root.render(<ChatRemoteExecution scope={scope} request={f.request} />))
    await click('核对上次提交')
    const writes = f.request.mock.calls.filter(([path]) => path === '/lumo/api/delegations')
    expect(writes).toHaveLength(2)
    expect(writes[0]?.[1]?.body).toBe(writes[1]?.[1]?.body)
    expect(new Headers(writes[0]?.[1]?.headers).get('Idempotency-Key')).toBe(new Headers(writes[1]?.[1]?.headers).get('Idempotency-Key'))
    expect(container.textContent).toContain('task-1'); expect(container.textContent).not.toContain('上次提交尚待确认')
  })
  it('fails closed when the current environment or delegation permission is unavailable', async () => {
    const f = fixture(); f.unavailable()
    await act(async () => root.render(<ChatRemoteExecution scope={scope} initialTask="Run checks" request={f.request} />))
    expect(container.textContent).toContain('远程执行不可用'); expect(button('提交远程任务')).toBeUndefined()
    const g = fixture(); g.deny()
    await act(async () => root.render(<ChatRemoteExecution key="permission" scope={scope} initialTask="Run checks" request={g.request} />))
    await click('识别受管执行者')
    expect(container.textContent).toContain('当前账号没有此远程执行权限'); expect(g.created()).toBe(false)
  })
  it('will not dispatch if its retry receipt cannot be persisted', async () => {
    const f = fixture()
    await act(async () => root.render(<ChatRemoteExecution scope={scope} initialTask="Run checks" request={f.request} />))
    await click('识别受管执行者')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    await click('提交远程任务')
    expect(f.created()).toBe(false); expect(container.textContent).toContain('任务尚未提交')
  })
  it('does not leak remote task history to another conversation or role', async () => {
    const f = fixture(); f.loseResponse()
    const room: RemoteChatScope = { ...scope, kind: 'room', id: 'room-1' }
    writeDraft(executionKey(room, 'role-a'), 'submission', { key: 'receipt-a', body: executionPayload('Run checks', 'project-1', 'agent:builder') })
    await act(async () => root.render(<ChatRemoteExecution scope={room} roles={[{ id: 'role-a', name: 'A' }, { id: 'role-b', name: 'B' }]} selectedRoleId="role-a" request={f.request} />))
    expect(button('核对上次提交')).toBeTruthy()
    await act(async () => root.render(<ChatRemoteExecution scope={room} roles={[{ id: 'role-a', name: 'A' }, { id: 'role-b', name: 'B' }]} selectedRoleId="role-b" request={f.request} />))
    expect(button('核对上次提交')).toBeUndefined()
    await act(async () => root.render(<ChatRemoteExecution scope={{ ...scope, id: 'other-chat' }} request={f.request} />))
    expect(container.querySelector('[aria-label="选择远程任务"]')).toBeNull()
  })
  it('does not turn role instructions alone into an executable user task', async () => {
    const f = fixture()
    await act(async () => root.render(<ChatRemoteExecution scope={{ ...scope, kind: 'room' }} roles={[{ id: 'role-a', name: 'Builder', instruction: 'Build and deploy services' }]} selectedRoleId="role-a" request={f.request} />))
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="远程任务内容"]')?.value).toBe('')
    expect(button('识别受管执行者').disabled).toBe(true)
    expect(f.created()).toBe(false)
  })
})
