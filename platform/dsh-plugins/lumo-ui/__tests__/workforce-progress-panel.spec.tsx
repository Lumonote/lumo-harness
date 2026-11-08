// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskProgressPanel, WorkforceProgressPanel } from '../src/client/workforce-progress-panel.tsx'
afterEach(() => { cleanup(); vi.useRealTimers() })
const progress = { task_id: 'task-1', run_id: 'run-1', revision: 3, status: 'on_track', percent: 25, summary: '已完成资料整理', next_step: '提交复核', updated_by: 'alice', updated_at: '2026-11-08T01:00:00Z', source: 'user' }
const view = { current_run_id: 'run-1', revision: 3, progress, history: [progress], can_update: true }
const page = { items: [{ task: { id: 'task-1', title: '合同审查', state: 'RUNNING', assignee_name: '小林' }, progress, health: { blocked: true, overdue: false, stale: false, awaiting_review: false } }], summary: { total: 1, active: 1, blocked: 1, overdue: 0, stale: 0, awaiting_review: 0, accepted: 0 }, summary_scope: 'page', next_cursor: '' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish }); return { promise, resolve } }
async function edit() { fireEvent.click(await screen.findByRole('button', { name: '更新进度' })); fireEvent.change(screen.getByLabelText('已完成的进展'), { target: { value: '第一阶段已提交' } }) }
it('saves a blocked handoff with a fixed run/revision and deduplicates submits', async () => {
 const save = deferred<unknown>(); const request = vi.fn().mockResolvedValue(view)
 render(<TaskProgressPanel request={request} taskID="task-1" />); await edit()
 fireEvent.change(screen.getByLabelText('推进状态'), { target: { value: 'blocked' } })
 fireEvent.change(screen.getByLabelText('阻塞原因与所需协助'), { target: { value: ' 等待法务附件 ' } })
 request.mockImplementationOnce(() => save.promise)
 fireEvent.click(screen.getByRole('button', { name: '保存进度' })); fireEvent.submit(screen.getByLabelText('已完成的进展').closest('form')!)
 expect(request).toHaveBeenCalledTimes(2)
 expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ run_id: 'run-1', expected_revision: 3, status: 'blocked', percent: 25, summary: '第一阶段已提交', next_step: '提交复核', blocked_reason: '等待法务附件', due_at: null })
 await act(async () => save.resolve(progress)); expect((await screen.findByRole('status')).textContent).toContain('进度已记录')
})
it('requires reload after CAS conflict without silently retrying an old draft', async () => {
 const request = vi.fn().mockResolvedValueOnce(view).mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 })).mockResolvedValue({ ...view, revision: 4, current_run_id: 'run-2', progress: null })
 render(<TaskProgressPanel request={request} taskID="task-1" />); await edit(); fireEvent.click(screen.getByRole('button', { name: '保存进度' }))
 expect((await screen.findByRole('alert')).textContent).toContain('执行尝试已变化')
 expect((screen.getByRole('button', { name: '保存进度' }) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.click(screen.getByRole('button', { name: '读取最新记录' })); fireEvent.click(await screen.findByRole('button', { name: '更新进度' }))
 expect((screen.getByLabelText('已完成的进展') as HTMLTextAreaElement).value).toBe(''); expect(request).toHaveBeenCalledTimes(3)
})
it('retains the original edit baseline when an earlier background refresh returns a new run', async () => {
 vi.useFakeTimers(); const refresh = deferred<typeof view>()
 const request = vi.fn().mockResolvedValue(view).mockImplementationOnce(() => Promise.resolve(view)).mockImplementationOnce(() => refresh.promise)
 render(<TaskProgressPanel request={request} taskID="task-1" />); await act(async () => {})
 await act(async () => { vi.advanceTimersByTime(30000) })
 fireEvent.click(screen.getByRole('button', { name: '更新进度' })); fireEvent.change(screen.getByLabelText('已完成的进展'), { target: { value: '旧运行的草稿' } })
 await act(async () => refresh.resolve({ ...view, current_run_id: 'run-2', revision: 4 }))
 await act(async () => fireEvent.click(screen.getByRole('button', { name: '保存进度' })))
 expect(JSON.parse(request.mock.calls[2]![1].body)).toMatchObject({ run_id: 'run-1', expected_revision: 3, summary: '旧运行的草稿' })
})
it('hides write controls for completed tasks and read-only participants', async () => {
 const request = vi.fn().mockResolvedValue({ ...view, can_update: false }); render(<TaskProgressPanel request={request} taskID="task-1" />)
 await screen.findAllByText('已完成资料整理'); expect(screen.queryByRole('button', { name: '更新进度' })).toBeNull()
})
it('discards a previous task response after switching target', async () => {
 const first = deferred<typeof view>(); const request = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ ...view, progress: { ...progress, task_id: 'task-2', summary: '另一个任务' }, history: [] })
 const result = render(<TaskProgressPanel request={request} taskID="task-1" />); result.rerender(<TaskProgressPanel request={request} taskID="task-2" />)
 await screen.findByText('另一个任务'); await act(async () => first.resolve(view)); expect(screen.queryByText('已完成资料整理')).toBeNull()
})
it('paginates authorized scope and clears data after permission rejection', async () => {
 const request = vi.fn().mockImplementation((path: string) => Promise.resolve(path === '/auth/account' ? { roles: ['realm_admin'] } : path.includes('cursor=next') ? { ...page, items: [], next_cursor: '' } : { ...page, next_cursor: 'next' }))
 render(<WorkforceProgressPanel request={request} />); await screen.findByText('合同审查'); expect(screen.getByText(/统计与筛选仅覆盖当前页/)).toBeDefined()
 fireEvent.click(screen.getByRole('button', { name: '下一页' })); await screen.findByText('第 2 页 · 0 / 0 项')
 fireEvent.change(screen.getByLabelText('任务范围'), { target: { value: 'all' } }); await screen.findByText('第 1 页 · 1 / 1 项')
 expect(request).toHaveBeenLastCalledWith('/lumo/api/workforce/progress?scope=all&limit=50&cursor=')
 request.mockRejectedValueOnce(new Error('forbidden')); fireEvent.click(screen.getByRole('button', { name: '刷新看板' })); await screen.findByRole('alert'); expect(screen.queryByText('合同审查')).toBeNull()
})

it('reports malformed successful responses without crashing either panel', async () => {
 const request = vi.fn().mockResolvedValue({})
 const result = render(<TaskProgressPanel request={request} taskID="task-1" />)
 expect((await screen.findByRole('alert')).textContent).toContain('响应无效')
 result.unmount()
 render(<WorkforceProgressPanel request={request} />)
 expect((await screen.findByRole('alert')).textContent).toContain('响应无效')
 expect(screen.queryByRole('button', { name: '查看与汇报' })).toBeNull()
})
