// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, getConfig, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LumoOverlay } from '../src/client/index.tsx'

const project = { id: 'project-a', name: '团队项目', realm: 'realm-a', status: 'active' }
const overview = {
  generatedAt: '2026-11-07T00:00:00Z',
  deployment: { mode: 'cluster', label: '服务器集群', storage: 'postgres', middleware: [], distributed: true, desktop: false, clusterReady: true, clusterOnly: true },
  services: {}, cluster: { nodes: [] }, projects: [project], flows: [], connectors: [], plugins: [],
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function mount(status = 'active', options: {
  overviewReady?: Promise<void>; directoryReady?: () => Promise<void>; changingOverview?: boolean
} = {}) {
  let dashboardReads = 0
  let overviewReads = 0
  let failRefresh = false
  let failLifecycle = true
  const calls: string[] = []
  history.replaceState({}, '', '/?lumo=operations')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    if (path === '/lumo/api/overview') {
      if (options.overviewReady) await options.overviewReady
      return json(options.changingOverview
        ? { ...overview, generatedAt: new Date(Date.parse(overview.generatedAt) + ++overviewReads).toISOString() }
        : overview)
    }
    if (new URL(path, 'https://lumo.test').pathname === '/lumo/api/projects/directory') {
      if (options.directoryReady) await options.directoryReady()
      return json({
        projects: [{ ...project, status, yourRole: 'owner', memberCount: 1, createdAt: overview.generatedAt }],
        summary: { total: 1, active: status === 'active' ? 1 : 0, archived: status === 'archived' ? 1 : 0 },
        total: 1, limit: 20, offset: 0, hasMore: false,
      })
    }
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
  // waitFor's async wrapper drains pending updates before resolving. The
  // directory can disappear during that gap, so check and click in one callback.
  // Mark the action first: observer callbacks must never replay the click.
  let opened = false
  await waitFor(() => {
    if (opened) return
    expect((screen.getByRole('button', { name: '重新读取' }) as HTMLButtonElement).disabled).toBe(false)
    const directory = screen.getByRole('region', { name: '项目目录' })
    expect(directory.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false')
    const button = within(directory).getByRole('button', { name: '打开项目 团队项目' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    opened = true
    fireEvent.click(button)
  })
  const sheet = await screen.findByRole('complementary', { name: '项目详情' })
  return { ...view, calls, sheet: () => within(sheet), failRefresh: () => { failRefresh = true }, allowLifecycle: () => { failLifecycle = false }, reads: () => dashboardReads }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState({}, '', '/') })

describe('project operations parent callbacks', () => {
  it('opens the current project row when the overview replaces the preliminary directory', async () => {
    let releaseOverview!: () => void
    const overviewReady = new Promise<void>(resolve => { releaseOverview = resolve })
    const mounting = mount('active', { overviewReady })
    const preliminary = await screen.findByRole('button', { name: '打开项目 团队项目' })
    const overviewLoading = (screen.getByRole('button', { name: '重新读取' }) as HTMLButtonElement).disabled
    const openedPreliminary = vi.mocked(fetch).mock.calls.some(([path]) => String(path) === '/lumo/api/projects/project-a/dashboard')
    releaseOverview()
    const f = await mounting
    expect(overviewLoading).toBe(true)
    expect(openedPreliminary).toBe(false)
    expect(preliminary.isConnected).toBe(false)
    expect(f.reads()).toBe(1)
    expect(f.sheet().getByRole('heading', { name: '团队项目' })).toBeTruthy()
  })

  it('opens only once when the directory is refreshed before the readiness wait returns', async () => {
    const asyncWrapper = getConfig().asyncWrapper
    let refreshed = false
    let releaseDirectory!: () => void
    const directoryReady = new Promise<void>(resolve => { releaseDirectory = resolve })
    // Reproduce pending UI work between waitFor's successful callback and its
    // awaited return, using the public wrapper hook and real parent refresh.
    configure({ asyncWrapper: async callback => {
      const result = await asyncWrapper(callback)
      if (!refreshed) {
        refreshed = true
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新读取' })) })
      }
      return result
    } })
    try {
      const f = await mount('active', { changingOverview: true,
        directoryReady: () => refreshed ? directoryReady : Promise.resolve(),
      })
      expect(refreshed).toBe(true)
      expect(screen.queryByRole('button', { name: '打开项目 团队项目' })).toBeNull()
      expect(f.sheet().getByRole('heading', { name: '团队项目' })).toBeTruthy()
      expect(f.reads()).toBe(1)
      await act(async () => { releaseDirectory(); await directoryReady })
      expect(screen.getByRole('button', { name: '打开项目 团队项目' })).toBeTruthy()
      expect(f.reads()).toBe(1)
    } finally {
      releaseDirectory()
      configure({ asyncWrapper })
    }
  })

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
