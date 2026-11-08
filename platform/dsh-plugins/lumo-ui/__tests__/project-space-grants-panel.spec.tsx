// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectSpaceGrantsPanel } from '../src/client/project-space-grants-panel.tsx'
import { ProjectSpacesPanel } from '../src/client/project-resources-panel.tsx'

afterEach(cleanup)
const shared = { projectID: 'project/1', spaceID: 'space/1', members: [{ userId: 'alice', role: 'owner' }, { userId: 'bob', role: 'editor' }], editable: true }
const grant = { user_id: 'bob', permissions: ['read', 'edit'], revision: 4 }

it('captures the grant revision, saves independent permissions and confirms revocation', async () => {
  const request = vi.fn().mockResolvedValueOnce({ grants: [grant] }).mockResolvedValueOnce({ ...grant, permissions: ['read'], revision: 5 }).mockResolvedValueOnce({ ...grant, permissions: [], revision: 6 })
  render(<ProjectSpaceGrantsPanel {...shared} request={request} />)
  await screen.findByText('读取 · 编辑')
  fireEvent.change(screen.getByRole('combobox', { name: '空间授权成员' }), { target: { value: 'bob' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '空间编辑' }))
  fireEvent.click(screen.getByRole('button', { name: '保存空间授权' }))
  await screen.findByText('空间授权已保存。')
  expect(request).toHaveBeenNthCalledWith(2, '/lumo/api/projects/project%2F1/spaces/space%2F1/grants/bob', { method: 'PUT', body: '{"permissions":["read"],"expectedRevision":4}' })
  fireEvent.click(screen.getByRole('button', { name: '撤回全部权限' }))
  expect(request).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: '确认撤回授权' }))
  await screen.findByText('空间授权已撤回。')
  expect(request).toHaveBeenLastCalledWith('/lumo/api/projects/project%2F1/spaces/space%2F1/grants/bob', { method: 'PUT', body: '{"permissions":[],"expectedRevision":5}' })
})

it('blocks stale retries until explicit reload and bootstraps a member at revision zero', async () => {
  const request = vi.fn().mockResolvedValueOnce({ grants: [] }).mockRejectedValueOnce(Object.assign(new Error('stale grant'), { status: 409 })).mockResolvedValueOnce({ grants: [{ ...grant, revision: 2 }] })
  render(<ProjectSpaceGrantsPanel {...shared} request={request} />)
  await screen.findByText('尚未向成员授予此空间权限。')
  fireEvent.change(screen.getByRole('combobox', { name: '空间授权成员' }), { target: { value: 'bob' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '空间读取' }))
  fireEvent.click(screen.getByRole('button', { name: '保存空间授权' }))
  expect((await screen.findByRole('alert')).textContent).toContain('重新读取授权')
  expect(request.mock.calls[1]![1].body).toBe('{"permissions":["read"],"expectedRevision":0}')
  expect((screen.getByRole('button', { name: '保存空间授权' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '重新读取授权' }))
  await screen.findByText('读取 · 编辑')
  expect((screen.getByRole('combobox', { name: '空间授权成员' }) as HTMLSelectElement).value).toBe('')
})

it('mounts permission controls only for the project owner and keeps archived grants read only', async () => {
  const request = vi.fn().mockResolvedValue({ grants: [grant] })
  const props = { request, projectID: 'project', spaces: [{ spaceId: 'space', name: '资料' }], editable: false, refresh: vi.fn(), members: shared.members }
  const view = render(<ProjectSpacesPanel {...props} />)
  expect(screen.queryByRole('button', { name: '管理授权 · 资料' })).toBeNull()
  view.rerender(<ProjectSpacesPanel {...props} canManageGrants />)
  fireEvent.click(screen.getByRole('button', { name: '管理授权 · 资料' }))
  await screen.findByText('读取 · 编辑')
  expect(screen.queryByRole('button', { name: '保存空间授权' })).toBeNull()
})

it('permits only revocation for a member removed while their grant is selected', async () => {
  const request = vi.fn().mockResolvedValueOnce({ grants: [grant] }).mockResolvedValueOnce({ ...grant, permissions: [], revision: 5 })
  const f = render(<ProjectSpaceGrantsPanel {...shared} request={request} />)
  await screen.findByText('读取 · 编辑')
  fireEvent.change(screen.getByRole('combobox', { name: '空间授权成员' }), { target: { value: 'bob' } })
  f.rerender(<ProjectSpaceGrantsPanel {...shared} request={request} members={[shared.members[0]!]} />)
  expect((screen.getByRole('button', { name: '保存空间授权' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.submit(screen.getByRole('combobox').closest('form')!)
  expect(request).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '撤回全部权限' }))
  fireEvent.click(screen.getByRole('button', { name: '确认撤回授权' }))
  await screen.findByText('空间授权已撤回。')
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ permissions: [], expectedRevision: 4 })
  expect((screen.getByRole('button', { name: '撤回全部权限' }) as HTMLButtonElement).disabled).toBe(true)
})

it('isolates permissions and ignores a late mutation when switching spaces', async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn().mockResolvedValueOnce({ grants: [grant] })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ grants: [] })
  const f = render(<ProjectSpaceGrantsPanel {...shared} request={request} />)
  await screen.findByText('读取 · 编辑')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bob' } })
  fireEvent.click(screen.getByRole('button', { name: '保存空间授权' }))
  f.rerender(<ProjectSpaceGrantsPanel {...shared} request={request} spaceID="second" />)
  await screen.findByText('尚未向成员授予此空间权限。')
  await act(async () => finish({ ...grant, revision: 5 }))
  expect(screen.queryByText('读取 · 编辑')).toBeNull()
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
  expect(screen.queryByText('空间授权已保存。')).toBeNull()
})

it.each([{ grants: [null] }, { grants: [{ ...grant, permissions: null }] }, { grants: [grant, grant] }])('rejects malformed grants without crashing %j', async response => {
  render(<ProjectSpaceGrantsPanel {...shared} request={vi.fn().mockResolvedValue(response)} />)
  expect((await screen.findByRole('alert')).textContent).toContain('空间授权响应无效')
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('does not accept a save receipt for a different member', async () => {
  const request = vi.fn().mockResolvedValueOnce({ grants: [grant] }).mockResolvedValueOnce({ ...grant, user_id: 'alice', revision: 5 })
  render(<ProjectSpaceGrantsPanel {...shared} request={request} />)
  await screen.findByText('读取 · 编辑')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bob' } })
  fireEvent.click(screen.getByRole('button', { name: '保存空间授权' }))
  expect((await screen.findByRole('alert')).textContent).toContain('保存回执无效')
  expect(screen.queryByText('空间授权已保存。')).toBeNull()
  expect((screen.getByRole('button', { name: '保存空间授权' }) as HTMLButtonElement).disabled).toBe(true)
})
