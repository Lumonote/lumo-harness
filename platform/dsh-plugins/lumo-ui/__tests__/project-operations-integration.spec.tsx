// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LumoOverlay } from '../src/client/index.tsx'

const project = { id: 'project-a', name: '团队项目', realm: 'realm-a', status: 'active' }
const overview = {
  generatedAt: '2026-11-07T00:00:00Z',
  deployment: { mode: 'cluster', label: '服务器集群', storage: 'postgres', middleware: [], distributed: true, desktop: false, clusterReady: true, clusterOnly: true },
  services: {}, cluster: { nodes: [] }, projects: [project], flows: [], connectors: [], plugins: [],
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function mount(status = 'active') {
  let dashboardReads = 0
  let failRefresh = false
  let failLifecycle = true
  const calls: string[] = []
  history.replaceState({}, '', '/?lumo=operations')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    if (path === '/lumo/api/overview') return json(overview)
    if (path === '/auth/account') return json({ realm: 'realm-a', userId: 'owner', roles: ['realm_admin'] })
    if (path === '/lumo/api/capabilities') return json({ organization: true })
    if (path === '/lumo/api/governance') return json({})
    if (path === '/lumo/api/delegations') return json({ tasks: [] })
    if (path === '/lumo/api/users') return json({ users: [] })
    if (path === '/lumo/api/agent-presets') return json({ agent_presets: [] })
    if (path === '/lumo/api/workers') return json({ workers: [] })
    if (path === '/lumo/api/projects/project-a/dashboard') {
      dashboardReads++
      return failRefresh ? json({ message: '项目详情刷新不可用' }, 503) : json({ project: { ...project, status }, yourRole: 'owner', members: [], spaces: [], artifacts: [], automations: [], usage: [] })
    }
    if (path === '/lumo/api/projects/project-a' && method === 'PATCH') return json({ ...project, name: '更新名称' })
    if (path === '/lumo/api/projects/project-a/spaces' && method === 'POST') return json({ spaceId: 'space-a', name: '知识空间' }, 201)
    if (/^\/lumo\/api\/projects\/project-a\/(?:archive|unarchive)$/u.test(path) && method === 'POST') return failLifecycle ? json({ message: '项目状态变更被拒绝' }, 409) : json({ ...project, status: status === 'active' ? 'archived' : 'active' })
    throw new Error(`Unexpected request ${method} ${path}`)
  }))
  const view = render(<LumoOverlay {...{} as never} />)
  fireEvent.click(await screen.findByRole('button', { name: /团队项目.*详情/u }))
  const sheet = await screen.findByRole('complementary', { name: '项目详情' })
  return { ...view, calls, sheet: () => within(sheet), failRefresh: () => { failRefresh = true }, allowLifecycle: () => { failLifecycle = false }, reads: () => dashboardReads }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState({}, '', '/') })

describe('project operations parent callbacks', () => {
  it('shows dashboard refresh errors inside the open project sheet', async () => {
    const f = await mount()
    f.failRefresh()
    fireEvent.click(f.sheet().getByRole('button', { name: '刷新' }))
    expect((await f.sheet().findByRole('alert')).textContent).toBe('项目详情刷新不可用')
    expect(screen.getByRole('complementary', { name: '项目详情' })).toBeTruthy()
    expect(f.reads()).toBe(2)
  })

  it.each(['settings', 'spaces'])('reports a saved %s mutation separately from failed parent refresh', async action => {
    const f = await mount()
    f.failRefresh()
    if (action === 'settings') {
      fireEvent.change(f.sheet().getByRole('textbox', { name: '项目名称' }), { target: { value: '更新名称' } })
      fireEvent.click(f.sheet().getByRole('button', { name: '保存名称' }))
    } else {
      fireEvent.change(f.sheet().getByRole('textbox', { name: '项目空间名称' }), { target: { value: '知识空间' } })
      fireEvent.click(f.sheet().getByRole('button', { name: '创建空间' }))
    }
    expect((await f.sheet().findByRole('alert')).textContent).toBe('已保存，刷新失败：项目详情刷新不可用')
    expect(f.sheet().getByRole('status').textContent).toBe(action === 'settings' ? '项目名称已保存。' : '项目空间已创建。')
    expect(screen.getByRole('complementary', { name: '项目详情' })).toBeTruthy()
  })

  it.each(['active', 'archived'])('retains the %s project sheet after rejected lifecycle changes and closes only on success', async status => {
    const f = await mount(status)
    const actionName = status === 'active' ? '归档项目' : '恢复项目'
    const action = status === 'active' ? 'archive' : 'unarchive'
    fireEvent.click(f.sheet().getByRole('button', { name: actionName }))
    expect((await f.sheet().findByRole('alert')).textContent).toBe('项目状态变更被拒绝')
    expect(screen.getByRole('complementary', { name: '项目详情' })).toBeTruthy()
    expect(screen.queryByText(status === 'active' ? '项目已归档。' : '项目已恢复。')).toBeNull()
    f.allowLifecycle()
    fireEvent.click(f.sheet().getByRole('button', { name: actionName }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '项目详情' })).toBeNull())
    expect(screen.getByText(status === 'active' ? '项目已归档。' : '项目已恢复。')).toBeTruthy()
    expect(f.calls.filter(call => call === `POST /lumo/api/projects/project-a/${action}`)).toHaveLength(2)
  })
})
