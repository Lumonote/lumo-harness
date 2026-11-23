// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectMembersPanel } from '../src/client/cluster-panels.tsx'

afterEach(cleanup)
const members = [{ userId: 'alice', role: 'owner' }, { userId: 'bob', role: 'viewer' }]

it('protects the sole owner and submits the observed role through both member mutations', async () => {
  const request = vi.fn().mockResolvedValue({})
  render(<ProjectMembersPanel projectID="p/1" members={members} editable request={request} refresh={vi.fn()} />)
  expect((screen.getByRole('combobox', { name: 'alice 的项目角色' }) as HTMLSelectElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('搜索成员'), { target: { value: 'BO' } })
  expect(screen.queryByText('alice')).toBeNull()
  fireEvent.change(screen.getByLabelText('bob 的项目角色'), { target: { value: 'editor' } })
  await screen.findByText('项目角色已更新。')
  expect(request).toHaveBeenCalledWith('/lumo/api/projects/p%2F1/members/bob?expectedRole=viewer', { method: 'PATCH', body: '{"role":"editor"}' })
  fireEvent.click(screen.getByRole('button', { name: '移除' }))
  fireEvent.click(screen.getByRole('button', { name: '确认移除' }))
  await screen.findByText('项目成员已移除。')
  expect(request).toHaveBeenLastCalledWith('/lumo/api/projects/p%2F1/members/bob?expectedRole=viewer', { method: 'DELETE' })
})

it('loads the directory on demand, adds selected identities and discards stale state on project switch', async () => {
  const request = vi.fn().mockImplementation(async (path: string) => path.startsWith('/lumo/api/users?') ? {
    users: [{ id: 'carol', display_name: '卡罗尔', status: 'active' }], total: 1, has_more: false,
  } : {})
  const props = { members, editable: true, request, refresh: vi.fn() }
  const view = render(<ProjectMembersPanel projectID="a" {...props} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('添加方式'), { target: { value: 'directory' } })
  fireEvent.click(await screen.findByRole('button', { name: /卡罗尔/ }))
  fireEvent.click(screen.getByRole('button', { name: '添加成员' }))
  await screen.findByText('项目成员已添加。')
  expect(request).toHaveBeenCalledWith('/lumo/api/projects/a/members', { method: 'POST', body: '{"userId":"carol","role":"viewer"}' })
  fireEvent.change(screen.getByLabelText('筛选项目角色'), { target: { value: 'viewer' } })
  fireEvent.click(screen.getByRole('button', { name: '移除' }))
  view.rerender(<ProjectMembersPanel projectID="b" {...props} />)
  expect(screen.queryByRole('button', { name: '确认移除' })).toBeNull()
  expect(screen.getByText('alice')).toBeTruthy()
  view.rerender(<ProjectMembersPanel projectID="b" {...props} editable={false} />)
  expect(within(view.container).queryByLabelText('添加方式')).toBeNull()
})
