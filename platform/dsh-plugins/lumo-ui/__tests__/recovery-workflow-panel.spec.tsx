// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RecoveryWorkflowPanel } from '../src/client/recovery-workflow-panel.tsx'

afterEach(cleanup)
const item = { id: 'request-1', realm: 'r1', operation: 'restore', namespace: 'backups', target_id: 'tenant-a/db', recovery_point: 'snapshot-1', reason: '恢复事故', requested_by: 'alice', approved_by: '', expires_at: '2099-01-01T00:00:00Z', status: 'pending', revision: 1, provider_id: 'trusted', request_digest: 'a'.repeat(64), execution_id: 'execution-1', fencing_token: 0 }
const provider = { enabled: true, id: 'trusted', operations: ['restore', 'key_destroy'], scopes: [{ operation: 'restore', realm: 'r1', namespace: 'backups', prefix: 'tenant-a/' }, { operation: 'key_destroy', realm: 'r1', namespace: 'keys', prefix: 'tenant-a/' }] }
const listing = { requests: [item], provider, actor: { user_id: 'bob', realm: 'r1' } }
const audit = [{ id: 1, event: 'requested', actor: 'alice', revision: 1, fencing_token: 0, created_at: '2026-11-01T00:00:00Z' }]
it('shows the provider gate and never renders executable controls when it is disabled', async () => {
  const request = vi.fn().mockResolvedValue({ ...listing, requests: [], provider: { enabled: false, operations: null, scopes: [] } })
  render(<RecoveryWorkflowPanel request={request} />)
  await screen.findByText('执行服务未配置，恢复和密钥销毁暂不可用。历史请求仍可查看。')
  expect(screen.queryByRole('button', { name: '创建审批请求' })).toBeNull()
  expect(screen.queryByRole('button', { name: '执行已批准请求' })).toBeNull()
})
it('requires a second person to approve, confirms the immutable target and sends revision plus digest', async () => {
  const approved = { ...item, status: 'approved', revision: 2, approved_by: 'bob' }
  const request = vi.fn().mockResolvedValueOnce(listing).mockResolvedValueOnce({ request: item, audit }).mockResolvedValueOnce(approved).mockResolvedValueOnce({ request: approved, audit: [...audit, { ...audit[0], id: 2, event: 'approved', actor: 'bob', revision: 2 }] })
  render(<RecoveryWorkflowPanel request={request} />)
  fireEvent.click(await screen.findByRole('button', { name: /恢复数据 · tenant-a\/db/ }))
  fireEvent.click(await screen.findByRole('button', { name: '审批请求' }))
  expect(request).toHaveBeenCalledTimes(2)
  expect(screen.getByText(/请核对目标/).textContent).toContain('backups / tenant-a/db')
  fireEvent.click(screen.getByRole('button', { name: '确认审批' }))
  await screen.findByText('恢复数据 · 已批准')
  expect(request).toHaveBeenNthCalledWith(3, '/lumo/api/recovery-requests/request-1/approve', { method: 'POST', body: JSON.stringify({ expected_revision: 1, request_digest: item.request_digest }) })
  expect(screen.queryByRole('button', { name: '执行已批准请求' })).toBeNull()
  expect(screen.getByText('批准请求')).toBeTruthy()
})
it('requires the exact target to execute key destruction and blocks retry after an uncertain error until refresh', async () => {
  const key = { ...item, operation: 'key_destroy', recovery_point: '', status: 'approved', approved_by: 'bob', revision: 3 }
  const unknown = { ...key, status: 'uncertain', revision: 5, fencing_token: 1, last_error: 'provider_unavailable' }
  const value = { ...listing, requests: [key], actor: { user_id: 'alice', realm: 'r1' } }
  const request = vi.fn().mockResolvedValueOnce(value).mockResolvedValueOnce({ request: key, audit })
    .mockRejectedValueOnce(Object.assign(new Error('结果尚未确认'), { status: 503 }))
    .mockResolvedValueOnce({ ...value, requests: [unknown] }).mockResolvedValueOnce({ request: unknown, audit })
  render(<RecoveryWorkflowPanel request={request} />)
  fireEvent.click(await screen.findByRole('button', { name: /销毁租户密钥 · tenant-a\/db/ }))
  fireEvent.click(await screen.findByRole('button', { name: '执行已批准请求' }))
  expect((screen.getByRole('button', { name: '确认执行' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: '确认销毁目标' }), { target: { value: 'tenant-a/wrong' } })
  expect((screen.getByRole('button', { name: '确认执行' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: '确认销毁目标' }), { target: { value: key.target_id } })
  fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
  expect((await screen.findByRole('alert')).textContent).toContain('请刷新恢复审批后再继续')
  expect((screen.getByRole('button', { name: '确认执行' }) as HTMLButtonElement).disabled).toBe(true)
  expect(request).toHaveBeenNthCalledWith(3, '/lumo/api/recovery-requests/request-1/execute', { method: 'POST', body: JSON.stringify({ expected_revision: 3, request_digest: key.request_digest }) })
  fireEvent.click(screen.getByRole('button', { name: '刷新恢复审批' }))
  await screen.findByText('销毁租户密钥 · 结果待确认')
  expect(screen.queryByRole('button', { name: '撤销请求' })).toBeNull()
  expect(screen.getByRole('button', { name: '核对执行回执' })).toBeTruthy()
})
it('hides self approval and submits an allowlisted opaque target with a fixed expiration', async () => {
  const request = vi.fn().mockResolvedValueOnce({ ...listing, actor: { user_id: 'alice', realm: 'r1' } }).mockResolvedValueOnce({ request: item, audit }).mockResolvedValueOnce({ ...item, id: 'request-new' })
  render(<RecoveryWorkflowPanel request={request} />)
  fireEvent.click(await screen.findByRole('button', { name: /恢复数据 · tenant-a\/db/ }))
  await screen.findByText('恢复数据 · 等待审批')
  expect(screen.queryByRole('button', { name: '审批请求' })).toBeNull()
  fireEvent.change(screen.getByLabelText('目标标识'), { target: { value: 'tenant-a/db-2' } })
  fireEvent.change(screen.getByLabelText('恢复点标识'), { target: { value: 'snapshot-2' } })
  fireEvent.change(screen.getByLabelText('申请原因'), { target: { value: '事故恢复' } })
  fireEvent.click(screen.getByRole('button', { name: '创建审批请求' }))
  await screen.findByText('请求已创建，请另一位管理员核对并审批。')
  const body = JSON.parse(request.mock.calls[2]![1].body)
  expect(body).toMatchObject({ operation: 'restore', namespace: 'backups', target_id: 'tenant-a/db-2', recovery_point: 'snapshot-2', reason: '事故恢复' })
  expect(Object.keys(body).sort()).toEqual(['expires_at', 'namespace', 'operation', 'reason', 'recovery_point', 'target_id'])
  expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(59 * 60_000)
})
it('binds target namespaces to the selected operation', async () => {
  const request = vi.fn().mockResolvedValue(listing)
  render(<RecoveryWorkflowPanel request={request} />)
  const operations = await screen.findByLabelText('恢复操作类型')
  const namespaces = screen.getByLabelText('恢复目标命名空间') as HTMLSelectElement
  expect([...namespaces.options].map(option => option.value)).toEqual(['backups'])
  fireEvent.change(operations, { target: { value: 'key_destroy' } })
  expect([...namespaces.options].map(option => option.value)).toEqual(['keys'])
  expect(namespaces.value).toBe('keys')
})
it('starts a fresh load after strict effect cleanup or a changed request entrypoint', async () => {
  const initial = vi.fn().mockImplementation(() => new Promise(() => {}))
  const next = vi.fn().mockResolvedValue(listing)
  const panel = render(<StrictMode><RecoveryWorkflowPanel request={initial} /></StrictMode>)
  expect(initial).toHaveBeenCalledTimes(2)
  panel.rerender(<StrictMode><RecoveryWorkflowPanel request={next} /></StrictMode>)
  await screen.findByRole('button', { name: /恢复数据 · tenant-a\/db/ })
  expect(next).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('button', { name: '刷新恢复审批' }) as HTMLButtonElement).disabled).toBe(false)
})
