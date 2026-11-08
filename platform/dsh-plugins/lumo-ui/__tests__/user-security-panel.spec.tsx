// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { UserSecurityPanel } from '../src/client/user-security-panel.tsx'

afterEach(cleanup)
const overview = {
  user_id: 'employee', status: 'active', organization_admin: false,
  actions: [{ action: 'task:delegate', name: '任务委派', description: '项目权限仍需满足' }],
  resolution: { direct_roles: ['child', 'deny'], effective_roles: ['child', 'deny', 'realm_admin'], actions: { 'task:delegate': { allowed: false, explicit_deny: true, matched_policies: ['realm:role:deny:deny'] } } },
}
const session = { id: 'session-a', client_ip: '127.0.0.1', created_at: '2026-11-08T01:00:00Z', last_seen_at: '2026-11-08T01:05:00Z', expires_at: '2026-11-09T01:00:00Z' }
const sessionPage = { sessions: [session], total: 1, limit: 25, offset: 0, has_more: false }
const eventPage = { events: [{ id: 1, event: 'admin_session_revoked', created_at: '2026-11-08T02:00:00Z', detail: { actor: 'admin', reason: '设备遗失', count: 1 } }], total: 1, limit: 25, offset: 0, has_more: false }
function baseRequest() { return vi.fn().mockResolvedValueOnce(overview).mockResolvedValueOnce(sessionPage).mockResolvedValueOnce(eventPage) }

it('shows deny override and inherited administrator without promoting organization access', async () => {
  const request = baseRequest()
  render(<UserSecurityPanel request={request} userId="employee" userName="员工" />)
  await screen.findByText('显式拒绝')
  expect(screen.getByText('未授权')).toBeTruthy()
  expect(screen.getByText('child、deny、realm_admin')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '账户记录' }))
  expect(screen.getByText('管理员强制下线')).toBeTruthy()
  expect(screen.getByText('操作人 admin · 1 个会话')).toBeTruthy()
  expect(screen.getByText('设备遗失')).toBeTruthy()
})

it('requires reason and confirmation before single-session logout and refreshes the authoritative state', async () => {
  const request = baseRequest().mockResolvedValueOnce({ revoked: 1 })
    .mockResolvedValueOnce(overview).mockResolvedValueOnce({ ...sessionPage, sessions: [], total: 0 }).mockResolvedValueOnce(eventPage)
  render(<UserSecurityPanel request={request} userId="employee" userName="员工" />)
  await screen.findByText('显式拒绝')
  fireEvent.click(screen.getByRole('tab', { name: '登录会话 · 1' }))
  fireEvent.click(screen.getByRole('button', { name: '注销会话 session-a' }))
  expect(request).toHaveBeenCalledTimes(3)
  const confirm = screen.getByRole('button', { name: '确认下线' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: '下线原因' }), { target: { value: '  设备遗失  ' } })
  fireEvent.click(confirm)
  await screen.findByText('已注销 1 个登录会话。')
  expect(request).toHaveBeenNthCalledWith(4, '/lumo/api/users/employee/sessions/session-a', { method: 'DELETE', body: '{"reason":"设备遗失"}' })
  await screen.findByText('当前页没有活跃登录会话。')
  expect(screen.queryByRole('button', { name: '确认下线' })).toBeNull()
})

it('supports bulk logout and does not mutate on cancellation', async () => {
  const request = baseRequest().mockResolvedValueOnce({ revoked: 1 })
    .mockResolvedValueOnce(overview).mockResolvedValueOnce({ ...sessionPage, sessions: [], total: 0 }).mockResolvedValueOnce(eventPage)
  render(<UserSecurityPanel request={request} userId="employee" userName="员工" />)
  await screen.findByText('显式拒绝')
  fireEvent.click(screen.getByRole('tab', { name: '登录会话 · 1' }))
  fireEvent.click(screen.getByRole('button', { name: '全部下线' }))
  fireEvent.click(screen.getByRole('button', { name: '取消下线' }))
  expect(request).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button', { name: '全部下线' }))
  fireEvent.change(screen.getByRole('textbox', { name: '下线原因' }), { target: { value: '离职交接' } })
  fireEvent.click(screen.getByRole('button', { name: '确认下线' }))
  await screen.findByText('已注销 1 个登录会话。')
  expect(request).toHaveBeenNthCalledWith(4, '/lumo/api/users/employee/sessions', { method: 'DELETE', body: '{"reason":"离职交接"}' })
})

it('paginates audit events without losing session page scope', async () => {
  const request = vi.fn().mockResolvedValueOnce(overview).mockResolvedValueOnce(sessionPage).mockResolvedValueOnce({ ...eventPage, total: 26, has_more: true })
    .mockResolvedValueOnce(overview).mockResolvedValueOnce(sessionPage).mockResolvedValueOnce({ ...eventPage, offset: 25, total: 26 })
  render(<UserSecurityPanel request={request} userId="employee" userName="员工" />)
  await screen.findByText('显式拒绝')
  fireEvent.click(screen.getByRole('tab', { name: '账户记录' }))
  fireEvent.click(within(screen.getByRole('navigation', { name: '账户记录分页' })).getByRole('button', { name: '下一页' }))
  await screen.findByText('共 26 条 · 26–26')
  expect(request).toHaveBeenLastCalledWith('/lumo/api/users/employee/security-events?limit=25&offset=25')
  expect(request).toHaveBeenNthCalledWith(5, '/lumo/api/users/employee/sessions?limit=25&offset=0')
})

it('clears prior employee facts and ignores late responses when the selected user changes', async () => {
  let finish: (value: unknown) => void = () => {}
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(sessionPage).mockResolvedValueOnce(eventPage)
    .mockResolvedValueOnce({ ...overview, user_id: 'other', resolution: { ...overview.resolution, direct_roles: ['other-role'], effective_roles: ['other-role'] } })
    .mockResolvedValueOnce({ ...sessionPage, sessions: [], total: 0 }).mockResolvedValueOnce({ ...eventPage, events: [], total: 0 })
  const view = render(<UserSecurityPanel request={request} userId="employee" userName="员工" />)
  view.rerender(<UserSecurityPanel request={request} userId="other" userName="另一人" />)
  await screen.findByText('显式拒绝')
  await act(async () => { finish(overview) })
  expect(screen.queryByText('child、deny、realm_admin')).toBeNull()
  expect(screen.getByRole('region', { name: '员工访问与安全 · 另一人' })).toBeTruthy()
})

it('clears sensitive stale facts when authority is revoked during refresh', async () => {
  const request = baseRequest().mockRejectedValueOnce(new Error('组织管理员权限已撤销')).mockResolvedValueOnce(sessionPage).mockResolvedValueOnce(eventPage)
  render(<UserSecurityPanel request={request} userId="employee" userName="员工" />)
  await screen.findByText('显式拒绝')
  fireEvent.click(screen.getByRole('button', { name: '刷新账户安全' }))
  expect((await screen.findByRole('alert')).textContent).toContain('组织管理员权限已撤销')
  expect(screen.queryByText('child、deny、realm_admin')).toBeNull()
  expect(screen.queryByRole('button', { name: '全部下线' })).toBeNull()
})
