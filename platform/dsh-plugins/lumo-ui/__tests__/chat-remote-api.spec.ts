import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/client/api.ts'
import { executionKey, executionPayload, executionState, loadExecutionOptions, previewExecution, readExecution, submitExecution, type ExecutionSnapshot, type RemoteRequest } from '../src/client/chat-remote-api.ts'

const signal = new AbortController().signal
const scope = { kind: 'session' as const, id: 'chat', realm: 'r', userId: 'u' }
describe('governed remote task client contract', () => {
  it('binds only to a project, governed worker and scheduler constraints', () => {
    const body = executionPayload('Review project\nRead approved project resources', 'p', 'agent:reviewer', 'cluster-a')
    expect(body).toMatchObject({ auto_assign: false, assignee_worker_id: 'agent:reviewer', project_id: 'p', schedule: { cluster_id: 'cluster-a', requires: [{ key: 'subagent' }] } })
    expect(body).not.toHaveProperty('host'); expect(body).not.toHaveProperty('cwd'); expect(body).not.toHaveProperty('command')
    expect(executionKey(scope, 'reviewer')).not.toBe(executionKey(scope, 'builder'))
  })
  it('does not allow a stale account identity to reuse the project directory', async () => {
    const request = vi.fn(async (path: string) => path.includes('capabilities') ? { clusterReady: true } : path.includes('directory') ? { viewer: { realm: 'r', userId: 'other' }, projects: [] } : { clusters: [] }) as RemoteRequest
    await expect(loadExecutionOptions(request, scope, signal)).rejects.toThrow('登录身份已变化')
  })
  it('keeps server-default scheduling available without global cluster-list permission', async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes('capabilities')) return { clusterReady: true }
      if (path.includes('directory')) return { viewer: { realm: 'r', userId: 'u' }, projects: [{ id: 'p', name: 'Project', status: 'active', yourRole: 'editor' }] }
      throw new ApiError(403, {}, 'admin only')
    }) as RemoteRequest
    const options = await loadExecutionOptions(request, scope, signal)
    expect(options.projects).toHaveLength(1); expect(options.clusters).toEqual([]); expect(options.clusterError).toContain('权限')
  })
  it('rejects malformed or mismatched candidates and creation receipts', async () => {
    const malformed = vi.fn().mockResolvedValue({ candidates: [{ worker_id: 'agent:x', display_name: 'x' }] }) as RemoteRequest
    await expect(previewExecution(malformed, 'work', 'p')).rejects.toThrow('响应无效')
    const create = vi.fn().mockResolvedValue({ accepted: true }) as RemoteRequest
    await expect(submitExecution(create, { key: 'receipt', body: executionPayload('work', 'p', 'agent:x') })).rejects.toThrow('缺少任务 ID')
  })
  it('preserves task reads when result and control faces are independently unavailable', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/lumo/api/delegations/task') return { id: 'task', title: 'work', intent: 'work', state: 'RUNNING' }
      if (path === '/lumo/api/tasks/task/runs') return { runs: [{ id: 'run', task_id: 'task', state: 'RUNNING', attempt: 1, session_ref: 'session' }] }
      if (path.endsWith('/artifacts')) return { artifacts: [{ id: 'report', name: 'Report' }] }
      if (path.endsWith('/result')) return { task_id: 'another-task', run_id: 'run', state: 'COMPLETED', summary: 'foreign output' }
      throw new ApiError(503, {}, 'unavailable')
    }) as RemoteRequest
    const value = await readExecution(request, 'task', '', signal)
    expect(value.task.id).toBe('task'); expect(value.result).toBeUndefined(); expect(value.resultError).toContain('不匹配')
    expect(value.artifacts).toHaveLength(1); expect(value.controlError).toContain('不可用')
  })
  it('never promotes queued/cancelling work to running based on a control projection', () => {
    const snapshot = { task: { state: 'QUEUED' }, run: { state: 'QUEUED' }, control: { registered: true, state: 'running' } } as ExecutionSnapshot
    expect(executionState(snapshot)).toBe('排队中')
    snapshot.run!.state = 'CANCELLING'; snapshot.control!.state = 'paused'
    expect(executionState(snapshot)).toBe('等待停止确认')
    snapshot.run!.state = 'RUNNING'
    expect(executionState(snapshot)).toBe('已暂停')
    snapshot.run!.state = 'COMPLETED'
    expect(executionState(snapshot)).toBe('已完成')
  })
})
