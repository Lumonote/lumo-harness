// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ClusterNodesPanel } from '../src/client/cluster-panels.tsx'

const node = { id: 'created-server', realm: 'r', cluster_id: 'east', owner_user_id: 'alice', display_name: '计算主机', os: 'linux', arch: 'amd64', capacity: 1, client_version: '1', status: 'PENDING_ACTIVATION', scheduling_eligible: false, capabilities: [], last_seen_at: new Date().toISOString() }
const gateway = 'https://devices.example'
function makeStatus() {
  return { device: { ...node, node_id: node.id, revision: 1, applied_revision: 0, policy: { name: 'worker', client_version: '1', artifacts: [{ name: 'worker', version: '1', digest: 'ok' }] }, certificate_serial: '', certificate_expires: '', connection_expires: '', report_error: '' }, gateway_url: gateway, connected: false, permissions: { enroll: true, command: true, start: true }, process_runtime: true }
}
const enrollment = { realm: node.realm, node_id: node.id, code: 'ticket-123', expires_in: 3, gateway_url: gateway }
function fixture(existing = true) {
  let registered = existing
  const state = { details: makeStatus(), denied: false, pending: null as null | Promise<ReturnType<typeof makeStatus>>, enrollment: null as null | Promise<typeof enrollment> }
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/capabilities')) return { clusterReady: true, organization: false }
    if (path.endsWith('/desktop-nodes')) {
      if (init?.method === 'POST') { registered = true; return node }
      return { nodes: registered ? [node] : [] }
    }
    if (path.endsWith('/commands')) return { commands: [] }
    if (path.endsWith('/enrollment')) return state.enrollment ?? enrollment
    if (state.denied) throw Error('权限已撤销')
    if (state.pending) return state.pending
    return state.details
  })
  render(<ClusterNodesPanel request={request as <T>(path: string, init?: RequestInit) => Promise<T>} />)
  return { state, request }
}
afterEach(() => { cleanup(); vi.useRealTimers() })

it('opens the server-issued node ID for a newly registered Linux server', async () => {
  const { request } = fixture(false)
  fireEvent.click(await screen.findByRole('button', { name: '接入 Linux 服务器' }))
  expect((screen.getByLabelText('操作系统') as HTMLSelectElement).value).toBe('linux')
  fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: node.display_name } })
  fireEvent.change(screen.getByLabelText('集群 ID'), { target: { value: node.cluster_id } })
  fireEvent.change(screen.getByLabelText('客户端版本'), { target: { value: '1' } })
  fireEvent.submit(screen.getByLabelText('设备名称').closest('form')!)
  await screen.findByRole('complementary', { name: '计算主机 设备接入详情' })
  await screen.findByText('等待激活')
  expect(request.mock.calls.some(([path, init]) => path.endsWith('/desktop-nodes') && JSON.parse(String(init?.body ?? '{}')).os === 'linux')).toBe(true)
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('expires a one-time code and removes it immediately on loss of detail access', async () => {
  const { state } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: '接入详情' }))
  await screen.findByText('等待激活')
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '签发激活码' })) })
  expect(screen.getByText('ticket-123')).toBeTruthy()
  await act(async () => { vi.advanceTimersByTime(3001) })
  expect(screen.queryByText('ticket-123')).toBeNull()
  expect(screen.queryByRole('button', { name: '复制激活码' })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '签发激活码' })) })
  state.denied = true
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新遥测' })) })
  expect(screen.getByText('权限已撤销')).toBeTruthy()
  expect(screen.queryByText('ticket-123')).toBeNull()
  expect(screen.queryByText(gateway)).toBeNull()
})

it('checks the connection and application report before considering a pending node ready', async () => {
  const { state } = fixture()
  state.details.connected = true
  Object.assign(state.details.device, { certificate_serial: '1', certificate_expires: new Date(Date.now()+300000).toISOString(), connection_expires: new Date(Date.now()+30000).toISOString(), report_error: 'install_failed' })
  fireEvent.click(await screen.findByRole('button', { name: '接入详情' }))
  await screen.findByText('制品安装失败')
  expect((screen.getByRole('button', { name: '签发激活码' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('option', { name: '启动受控进程' }) as HTMLOptionElement).disabled).toBe(true)
  state.details.device.connection_expires = new Date(Date.now()-1000).toISOString()
  fireEvent.click(screen.getByRole('button', { name: '刷新遥测' }))
  await screen.findByText('已登记身份，当前未连接')
  expect((screen.getByRole('button', { name: '下发命令' }) as HTMLButtonElement).disabled).toBe(true)
})

it('does not restore old connection details when a delayed poll finishes after an access denial', async () => {
  const { state } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: '接入详情' }))
  await screen.findByText('等待激活')
  let finish!: (value: ReturnType<typeof makeStatus>) => void
  state.pending = new Promise(resolve => { finish = resolve })
  fireEvent.click(screen.getByRole('button', { name: '刷新遥测' }))
  state.denied = true
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(screen.getByText('权限已撤销')).toBeTruthy()
  await act(async () => { finish(makeStatus()) })
  expect(screen.queryByText(gateway)).toBeNull()
})

it.each(['access', 'policy', 'certificate'] as const)('discards a delayed enrollment after %s changes even when the original status is restored', async (change) => {
  const { state } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: '接入详情' }))
  await screen.findByText('等待激活')
  let finish!: (value: typeof enrollment) => void
  state.enrollment = new Promise(resolve => { finish = resolve })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '签发激活码' })) })
  if (change === 'access') state.denied = true
  else if (change === 'policy') state.details = { ...makeStatus(), device: { ...makeStatus().device, revision: 2 } }
  else state.details = { ...makeStatus(), device: { ...makeStatus().device, certificate_serial: 'new-identity' } }
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  state.denied = false; state.details = makeStatus()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await act(async () => { finish(enrollment) })
  expect(screen.queryByText('ticket-123')).toBeNull()
  expect(screen.queryByRole('button', { name: '复制激活码' })).toBeNull()
  expect(screen.queryByText('一次性激活码已签发。')).toBeNull()
})
