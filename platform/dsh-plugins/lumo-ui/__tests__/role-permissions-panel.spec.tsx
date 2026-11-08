// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { RolePermissionsPanel } from '../src/client/role-permissions-panel.tsx'

afterEach(cleanup)
const roles = [{ id: 'custom', name: '自定义', status: 'active' }, { id: 'operator', name: '运营', status: 'active' }, { id: 'child', name: '子角色', status: 'active', parent_role_id: 'custom' }]
const actions = [{ action: 'task:delegate', name: '任务委派', description: '项目权限仍需满足' }, { action: 'task:execution:update', name: '执行状态更新', description: '不授予组织管理' }]
const base = {
  role_id: 'custom', status: 'active', revision: 3, permissions: [{ action: 'task:delegate', effect: 'deny' }],
  resolution: { effective_roles: ['custom'], facts: [], actions: { 'task:delegate': { allowed: false, explicit_deny: true, matched_policies: ['realm:role:custom:deny'] }, 'task:execution:update': { allowed: false, explicit_deny: false, matched_policies: [] } } },
}
it('saves inheritance and action rules using the current revision, then confirms reset', async () => {
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(base)
    .mockResolvedValueOnce({ ...base, parent_role_id: 'operator', revision: 4 })
    .mockResolvedValueOnce({ ...base, parent_role_id: 'operator', revision: 5, permissions: [{ action: 'task:delegate', effect: 'allow' }] })
    .mockResolvedValueOnce({ ...base, parent_role_id: 'operator', revision: 6, permissions: [] })
  render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('显式拒绝')
  expect(screen.queryByRole('option', { name: '子角色' })).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: '任务委派策略' }), { target: { value: 'allow' } })
  fireEvent.change(screen.getByRole('combobox', { name: '继承父角色' }), { target: { value: 'operator' } })
  fireEvent.click(screen.getByRole('button', { name: '保存继承关系' }))
  await screen.findByText('角色继承已保存。')
  expect(request).toHaveBeenNthCalledWith(3, '/lumo/api/roles/custom/parent', { method: 'PUT', body: '{"expected_revision":3,"parent_role_id":"operator"}' })
  // Saving the parent must preserve the unsaved action draft.
  expect((screen.getByRole('combobox', { name: '任务委派策略' }) as HTMLSelectElement).value).toBe('allow')
  fireEvent.click(screen.getByRole('button', { name: '保存动作权限' }))
  await screen.findByText('角色动作权限已保存。')
  expect(request).toHaveBeenNthCalledWith(4, '/lumo/api/roles/custom/permissions', { method: 'PUT', body: '{"expected_revision":4,"permissions":[{"action":"task:delegate","effect":"allow"},{"action":"task:execution:update","effect":"inherit"}]}' })
  fireEvent.click(screen.getByRole('button', { name: '恢复全部默认' }))
  expect(request).toHaveBeenCalledTimes(4)
  fireEvent.click(screen.getByRole('button', { name: '确认恢复默认' }))
  await screen.findByText('显式规则已清除，已恢复默认。')
  expect(request).toHaveBeenLastCalledWith('/lumo/api/roles/custom/permissions', { method: 'DELETE', body: '{"expected_revision":5}' })
})
it('preserves a stale draft and requires explicit reload before another write', async () => {
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(base)
    .mockRejectedValueOnce(Object.assign(new Error('策略版本冲突'), { status: 409 }))
    .mockResolvedValueOnce({ actions }).mockResolvedValueOnce({ ...base, revision: 8, permissions: [] })
  render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('显式拒绝')
  fireEvent.change(screen.getByRole('combobox', { name: '任务委派策略' }), { target: { value: 'allow' } })
  fireEvent.click(screen.getByRole('button', { name: '保存动作权限' }))
  expect((await screen.findByRole('alert')).textContent).toContain('草稿已保留')
  expect((screen.getByRole('combobox', { name: '任务委派策略' }) as HTMLSelectElement).value).toBe('allow')
  expect((screen.getByRole('button', { name: '保存动作权限' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '重新读取角色权限' }))
  await screen.findByText('已保存的权限解释 · v8')
  expect((screen.getByRole('combobox', { name: '任务委派策略' }) as HTMLSelectElement).value).toBe('inherit')
})
it('ignores a late response after selecting a different role', async () => {
  let finish: (value: unknown) => void = () => {}
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ actions }).mockResolvedValueOnce({ ...base, role_id: 'operator', revision: 9 })
  const view = render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  view.rerender(<RolePermissionsPanel request={request} role={roles[1]!} roles={roles} />)
  await screen.findByText('已保存的权限解释 · v9')
  finish(base)
  expect(screen.queryByText('已保存的权限解释 · v3')).toBeNull()
})

it('disables unchanged writes and respects a parent operation lock without losing the draft', async () => {
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(base)
  const view = render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('显式拒绝')
  expect((screen.getByRole('button', { name: '保存动作权限' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: '任务委派策略' }), { target: { value: 'allow' } })
  view.rerender(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} disabled />)
  fireEvent.click(screen.getByRole('button', { name: '保存动作权限' })); expect(request).toHaveBeenCalledTimes(2)
  expect((screen.getByRole('combobox', { name: '任务委派策略' }) as HTMLSelectElement).disabled).toBe(true)
  view.rerender(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  expect((screen.getByRole('combobox', { name: '任务委派策略' }) as HTMLSelectElement).value).toBe('allow')
  expect((screen.getByRole('button', { name: '保存动作权限' }) as HTMLButtonElement).disabled).toBe(false)
})
it('reloads externally changed role status and ignores an old pending mutation', async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(base).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ actions }).mockResolvedValueOnce({ ...base, status: 'disabled', revision: 5 })
  const view = render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} refreshKey={1} />)
  await screen.findByText('显式拒绝'); fireEvent.change(screen.getByRole('combobox', { name: '任务委派策略' }), { target: { value: 'allow' } }); fireEvent.click(screen.getByRole('button', { name: '保存动作权限' }))
  view.rerender(<RolePermissionsPanel request={request} role={{ ...roles[0]!, status: 'disabled' }} roles={roles} refreshKey={2} />)
  await screen.findByText('已保存的权限解释 · v5')
  await act(async () => { finish({ ...base, revision: 4 }) })
  expect(screen.queryByText('角色动作权限已保存。')).toBeNull(); expect(screen.getByText(/此角色已停用/u)).toBeTruthy()
})
it('removes editable policy after authorization is revoked during a write', async () => {
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(base).mockRejectedValueOnce(Object.assign(Error('权限已撤销'), { status: 403 }))
  render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('显式拒绝'); fireEvent.change(screen.getByRole('combobox', { name: '任务委派策略' }), { target: { value: 'allow' } }); fireEvent.click(screen.getByRole('button', { name: '保存动作权限' }))
  await screen.findByText('权限已撤销'); expect(screen.queryByRole('combobox', { name: '任务委派策略' })).toBeNull()
})
it.each([Error('连接断开'), null])('requires authoritative reload after an uncertain write result %s', async failure => {
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(base)
  if (failure) request.mockRejectedValueOnce(failure)
  else request.mockResolvedValueOnce({ ...base, revision: 4, resolution: { ...base.resolution, facts: null } })
  render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('显式拒绝'); fireEvent.change(screen.getByRole('combobox', { name: '任务委派策略' }), { target: { value: 'allow' } }); fireEvent.click(screen.getByRole('button', { name: '保存动作权限' }))
  expect((await screen.findByRole('alert')).textContent).toContain('请重新读取角色权限')
  expect((screen.getByRole('button', { name: '保存动作权限' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('combobox', { name: '任务委派策略' }) as HTMLSelectElement).value).toBe('allow')
})
it('fails closed for malformed authorization decisions instead of rendering a broken panel', async () => {
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce({ ...base, resolution: { ...base.resolution, actions: { 'task:delegate': { allowed: true, explicit_deny: false } } } })
  render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('角色权限响应无效，请重试。'); expect(screen.queryByRole('button', { name: '保存动作权限' })).toBeNull()
})
it('recomputes inherited permissions after the parent role is disabled', async () => {
  const withParent = { ...base, parent_role_id: 'operator' }
  const request = vi.fn().mockResolvedValueOnce({ actions }).mockResolvedValueOnce(withParent)
    .mockResolvedValueOnce({ actions }).mockResolvedValueOnce({ ...withParent, resolution: { ...base.resolution, effective_roles: ['custom'] } })
  const view = render(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles} />)
  await screen.findByText('显式拒绝')
  view.rerender(<RolePermissionsPanel request={request} role={roles[0]!} roles={roles.map(role => role.id === 'operator' ? { ...role, status: 'disabled' } : role)} />)
  await screen.findByRole('option', { name: '运营（已停用）' }); expect(request).toHaveBeenCalledTimes(4)
})
