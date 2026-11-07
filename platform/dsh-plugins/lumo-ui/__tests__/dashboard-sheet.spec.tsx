// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSheet } from '../src/client/index.tsx'

afterEach(cleanup)
const rule = { automationId: 'auto/1', projectId: 'p/1', triggerKind: 'event', triggerSpec: 'task.done', flowRef: 'flow-1', enabled: true, revision: 1 }
const data = { project: { id: 'p/1', name: 'Project', status: 'active', realm: 'realm' }, yourRole: 'owner', members: [{ userId: 'owner', role: 'owner' }], spaces: [], artifacts: [], automations: [rule], usage: [] }
function mount(extra = {}) {
  const request = vi.fn().mockResolvedValue({})
  const refresh = vi.fn().mockResolvedValue(undefined)
  const lifecycle = vi.fn().mockResolvedValue(undefined)
  return { request, refresh, lifecycle, ...render(<DashboardSheet data={data} clusterReady close={vi.fn()} request={request} refresh={refresh} lifecycle={lifecycle} {...extra} />) }
}
describe('project dashboard permissions and actions', () => {
  it('offers editor resource/settings writes and reserves member/lifecycle management for owners', () => {
    mount({ data: { ...data, yourRole: 'editor' } })
    expect(screen.getByRole('textbox', { name: '项目名称' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建空间' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '编辑自动化 auto/1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '添加成员' })).toBeNull()
    expect(screen.queryByRole('button', { name: '归档项目' })).toBeNull()
  })
  it.each([
    { yourRole: 'viewer', status: 'active' },
    { yourRole: 'owner', status: 'archived' },
  ])('hides all resource edits for $yourRole in $status', state => {
    mount({ data: { ...data, yourRole: state.yourRole, project: { ...data.project, status: state.status } } })
    expect(screen.queryByRole('textbox', { name: '项目名称' })).toBeNull()
    expect(screen.queryByRole('button', { name: '创建空间' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑自动化 auto/1' })).toBeNull()
    expect(screen.queryByRole('button', { name: '停用自动化 auto/1' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除自动化 auto/1' })).toBeNull()
    if (state.yourRole === 'owner') {
      expect(screen.getByRole('button', { name: '添加成员' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '恢复项目' })).toBeTruthy()
    }
  })
  it('hides cluster mutations when the control plane is unavailable', () => {
    mount({ clusterReady: false })
    expect(screen.queryByRole('button', { name: '归档项目' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加成员' })).toBeNull()
    expect(screen.queryByRole('button', { name: '创建空间' })).toBeNull()
  })
  it('preserves complete rule settings when toggling, and waits for delete confirmation', async () => {
    const f = mount()
    fireEvent.click(screen.getByRole('button', { name: '停用自动化 auto/1' }))
    await screen.findByText('规则已停用。')
    expect(f.request).toHaveBeenLastCalledWith('/lumo/api/projects/p%2F1/automations/auto%2F1', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, triggerKind: 'event', triggerSpec: 'task.done', flowRef: 'flow-1', enabled: false }) })
    fireEvent.click(screen.getByRole('button', { name: '删除自动化 auto/1' }))
    expect(f.request).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '确认删除自动化' }))
    await screen.findByText('自动化规则已删除。')
    expect(f.request).toHaveBeenLastCalledWith('/lumo/api/projects/p%2F1/automations/auto%2F1?expectedRevision=1', { method: 'DELETE' })
  })
  it('populates rule editing and retains its disabled state on save', async () => {
    const f = mount({ data: { ...data, automations: [{ ...rule, enabled: false }] } })
    fireEvent.click(screen.getByRole('button', { name: '编辑自动化 auto/1' }))
    expect((screen.getByRole('textbox', { name: '规则 ID' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: '规则启用状态' }) as HTMLInputElement).checked).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: '自动化触发规则' }), { target: { value: 'task.updated' } })
    fireEvent.click(screen.getByRole('button', { name: '保存自动化修改' }))
    await screen.findByText('自动化规则已保存。')
    expect(JSON.parse(f.request.mock.calls[0]![1].body)).toEqual({ expectedRevision: 1, triggerKind: 'event', triggerSpec: 'task.updated', flowRef: 'flow-1', enabled: false })
  })
  it('deduplicates lifecycle requests and displays rejected actions', async () => {
    let reject!: (value: unknown) => void
    const lifecycle = vi.fn().mockImplementation(() => new Promise((_resolve,fail) => { reject = fail }))
    mount({ lifecycle })
    const archive = screen.getByRole('button', { name: '归档项目' })
    fireEvent.click(archive); fireEvent.click(archive)
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith('archive')
    reject(new Error('archive failed'))
    expect((await screen.findByRole('alert')).textContent).toBe('archive failed')
  })
  it('deduplicates resource submissions and distinguishes a saved result from refresh failure', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    mount({ request, refresh })
    fireEvent.change(screen.getByRole('textbox', { name: '项目空间名称' }), { target: { value: ' New ' } })
    fireEvent.submit(screen.getByRole('textbox', { name: '项目空间名称' }).closest('form')!)
    fireEvent.submit(screen.getByRole('textbox', { name: '项目空间名称' }).closest('form')!)
    expect(request).toHaveBeenCalledOnce()
    finish({})
    expect((await screen.findByRole('alert')).textContent).toBe('已保存，刷新失败：offline')
    expect(screen.getByRole('status').textContent).toBe('项目空间已创建。')
    await waitFor(() => expect((screen.getByRole('textbox', { name: '项目空间名称' }) as HTMLInputElement).value).toBe(''))
  })
})
