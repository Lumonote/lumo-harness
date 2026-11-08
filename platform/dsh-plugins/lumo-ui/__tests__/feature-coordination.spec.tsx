// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LumoOverlay } from '../src/client/index.tsx'
import { OPERATIONS_TARGET_EVENT, queueOperationsTarget, takeOperationsTarget } from '../src/client/operations-navigation.ts'

const project = (id: string) => ({ id, name: `项目 ${id}`, realm: 'realm-a', status: 'active' })
const overview = { generatedAt: '2026-11-08T00:00:00Z', deployment: { mode: 'cluster', label: '集群', storage: 'postgres', middleware: [], distributed: true, desktop: false, clusterReady: true, clusterOnly: true }, services: {}, cluster: { nodes: [] }, projects: [project('a'), project('b')], flows: [], connectors: [], plugins: [] }
const task = { id: 'task-a', title: '需要交接的任务', state: 'RUNNING', selected_skills: [], assignee_user_id: 'u-a' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish }); return { resolve, promise } }

function fixture(custom: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const result = custom(path, init)
    if (result) return result
    const url = new URL(path, 'http://lumo.test')
    if (path === '/lumo/api/overview') return json(overview)
    if (path === '/lumo/api/governance') return json({ features: { ok: true } })
    if (path === '/auth/account') return json({ realm: 'realm-a', userId: 'owner', roles: ['realm_admin'] })
    if (path === '/lumo/api/capabilities') return json({ organization: true })
    if (path === '/lumo/api/agent-presets') return json({ agent_presets: [] })
    if (path === '/lumo/api/workers') return json({ workers: [] })
    if (path === '/lumo/api/users') return json({ users: [{ id: 'u-a', display_name: '员工 A' }, { id: 'u-b', display_name: '员工 B' }] })
    if (path.endsWith('/tags')) return json({ tags: [] })
    if (path === '/lumo/api/delegations') return json({ tasks: [] })
    if (path === '/lumo/api/desktop-nodes') return json({ nodes: [] })
    if (path === '/lumo/api/collaboration/teams') return json({ teams: [] })
    if (url.pathname === '/lumo/api/collaboration/threads') return json({ threads: [], capabilities: { controlState: true, threadRegistry: true }, errors: [] })
    if (url.pathname === '/lumo/api/projects/directory') return json({ projects: overview.projects.map(p => ({ ...p, yourRole: 'owner', memberCount: 1 })), summary: { total: 2, active: 2, archived: 0 }, total: 2, limit: 20, offset: 0, hasMore: false })
    if (/^\/lumo\/api\/projects\/[ab]\/dashboard$/u.test(path)) return json({ project: project(path.split('/')[4]!), yourRole: 'owner', members: [], spaces: [], artifacts: [], automations: [], usage: [] })
    if (url.pathname === '/lumo/api/workforce/progress') return json({ items: [{ task, health: { blocked: false, overdue: false, stale: false, awaiting_review: false } }], summary: { total: 1, active: 1, blocked: 0, overdue: 0, stale: 0, awaiting_review: 0, accepted: 0 }, summary_scope: 'page' })
    if (path === '/lumo/api/delegations/task-a') return json(task)
    if (path === '/lumo/api/tasks/task-a/runs') return json({ runs: [] })
    if (path === '/lumo/api/tasks/task-a/audit') return json({ events: [] })
    if (path === '/lumo/api/tasks/task-a/collaboration') return json({}, 403)
    if (path === '/lumo/api/tasks/task-a/progress') return json({ current_run_id: '', revision: 0, progress: null, history: [], can_update: false })
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => { cleanup(); takeOperationsTarget(); vi.unstubAllGlobals(); history.replaceState({}, '', '/') })

describe('cross feature coordination', () => {
  const preview = { intent: '整理合同', required_tags: null, required_skills: ['合同'], intent_terms: null, inferred_tags: null, inferred_skills: ['合同'], candidates: [
    { user_id: '', worker_id: 'agent:legal', worker_kind: 'agent', display_name: '合同专家', tags: null, skills: ['合同'], matched_tags: null, matched_skills: ['合同'], score: 85, active_tasks: 0, eligible: true, rationale: null },
  ] }
  async function delivery() {
    render(<LumoOverlay {...{} as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '协作执行委派、专家与运行证据' }))
    const input = screen.getByPlaceholderText(/描述交付结果/u)
    fireEvent.change(input, { target: { value: '整理合同' } })
    return input
  }

  it('accepts Go null lists, selects an Agent by worker ID, and sends once', async () => {
    history.replaceState({}, '', '/?lumo=operations')
    const send = defer<Response>()
    const fetch = fixture((path, init) => path === '/lumo/api/delegations/preview' ? json(preview) : path === '/lumo/api/delegations' && init?.method === 'POST' ? send.promise : undefined)
    await delivery()
    fireEvent.click(screen.getByRole('button', { name: '识别候选人' }))
    const candidate = await screen.findByRole('button', { name: /合同专家.*85/u })
    fireEvent.click(candidate)
    const submit = screen.getByRole('button', { name: '确认分发给 合同专家' })
    fireEvent.click(submit); fireEvent.click(submit)
    await waitFor(() => expect(fetch.mock.calls.filter(([path, init]) => path === '/lumo/api/delegations' && init?.method === 'POST')).toHaveLength(1))
    const write = fetch.mock.calls.find(([path, init]) => path === '/lumo/api/delegations' && init?.method === 'POST')!
    expect(JSON.parse(write[1]!.body as string)).toMatchObject({ assignee_worker_id: 'agent:legal', assignee_user_id: '', auto_assign: false })
    await act(async () => { send.resolve(json({ task })); await send.promise })
  })

  it('invalidates candidate preview after editing task constraints', async () => {
    history.replaceState({}, '', '/?lumo=operations')
    fixture(path => path === '/lumo/api/delegations/preview' ? json(preview) : undefined)
    const input = await delivery()
    fireEvent.click(screen.getByRole('button', { name: '识别候选人' }))
    await screen.findByRole('button', { name: /自动分发 · 推荐 合同专家/u })
    fireEvent.change(input, { target: { value: '新的交付目标' } })
    expect(screen.queryByRole('button', { name: /自动分发 · 推荐 合同专家/u })).toBeNull()
  })

  it('preserves the next draft when a previous dispatch finishes late', async () => {
    history.replaceState({}, '', '/?lumo=operations')
    const send = defer<Response>()
    fixture((path, init) => path === '/lumo/api/delegations/preview' ? json(preview) : path === '/lumo/api/delegations' && init?.method === 'POST' ? send.promise : undefined)
    const input = await delivery()
    fireEvent.click(screen.getByRole('button', { name: '识别候选人' }))
    fireEvent.click(await screen.findByRole('button', { name: /自动分发 · 推荐 合同专家/u }))
    fireEvent.change(input, { target: { value: '下一条任务草稿' } })
    await act(async () => { send.resolve(json({ task })); await send.promise })
    await screen.findByText(/已按意图、标签、技能和负载自动分发/u)
    expect((input as HTMLTextAreaElement).value).toBe('下一条任务草稿')
  })

  it('renders an empty candidate response without permitting automatic dispatch', async () => {
    history.replaceState({}, '', '/?lumo=operations')
    fixture(path => path === '/lumo/api/delegations/preview' ? json({ ...preview, candidates: null }) : undefined)
    await delivery()
    fireEvent.click(screen.getByRole('button', { name: '识别候选人' }))
    const submit = await screen.findByRole('button', { name: '自动分发' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('0 个可分发对象')).toBeTruthy()
  })

  it('opens the exact authorized task from the collaboration progress board', async () => {
    history.replaceState({}, '', '/?lumo=collaboration')
    const fetch = fixture()
    render(<LumoOverlay {...{} as never} />)
    fireEvent.click(await screen.findByRole('tab', { name: '团队进度' }))
    fireEvent.click(await screen.findByRole('button', { name: '协作与运行' }))
    await screen.findByText('执行详情 · 需要交接的任务')
    expect(new URL(location.href).searchParams.get('lumo')).toBe('operations')
    expect(fetch.mock.calls.some(([path]) => path === '/lumo/api/delegations/task-a')).toBe(true)
  })

  it('keeps the newest project when an older open finishes later', async () => {
    const first = defer<Response>()
    history.replaceState({}, '', '/?lumo=operations')
    fixture(path => path === '/lumo/api/projects/a/dashboard' ? first.promise : undefined)
    render(<LumoOverlay {...{} as never} />)
    await waitFor(() => expect((screen.getByRole('button', { name: '重新读取' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(await screen.findByRole('button', { name: '打开项目 项目 a' }))
    fireEvent.click(screen.getByRole('button', { name: '打开项目 项目 b' }))
    const sheet = await screen.findByRole('complementary', { name: '项目详情' })
    expect(within(sheet).getByRole('heading', { name: '项目 b' })).toBeTruthy()
    await act(async () => { first.resolve(json({ project: project('a'), yourRole: 'owner' })); await first.promise })
    expect(within(sheet).getByRole('heading', { name: '项目 b' })).toBeTruthy()
  })

  it('does not reopen a project after closing its pending refresh', async () => {
    let reads = 0
    const refresh = defer<Response>()
    history.replaceState({}, '', '/?lumo=operations')
    fixture(path => path === '/lumo/api/projects/a/dashboard' && ++reads > 1 ? refresh.promise : undefined)
    render(<LumoOverlay {...{} as never} />)
    await waitFor(() => expect((screen.getByRole('button', { name: '重新读取' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(await screen.findByRole('button', { name: '打开项目 项目 a' }))
    const sheet = within(await screen.findByRole('complementary', { name: '项目详情' }))
    fireEvent.click(sheet.getByRole('button', { name: '刷新' }))
    fireEvent.click(sheet.getByRole('button', { name: '关闭项目详情' }))
    await act(async () => { refresh.resolve(json({ project: project('a'), yourRole: 'owner' })); await refresh.promise })
    expect(screen.queryByRole('complementary', { name: '项目详情' })).toBeNull()
  })

  it('consumes a project navigation intent once, including when operations is already mounted', async () => {
    history.replaceState({}, '', '/?lumo=operations')
    fixture()
    render(<LumoOverlay {...{} as never} />)
    act(() => { queueOperationsTarget({ kind: 'project', id: 'b' }); window.dispatchEvent(new Event(OPERATIONS_TARGET_EVENT)) })
    const sheet = within(await screen.findByRole('complementary', { name: '项目详情' }))
    expect(sheet.getByRole('heading', { name: '项目 b' })).toBeTruthy()
    expect(takeOperationsTarget()).toBeNull()
  })

  it('retains the project name after a failed creation', async () => {
    history.replaceState({}, '', '/?lumo=operations')
    fixture((path, init) => path === '/lumo/api/projects' && init?.method === 'POST' ? json({ error: '创建失败' }, 503) : undefined)
    render(<LumoOverlay {...{} as never} />)
    const input = await screen.findByPlaceholderText('项目名称')
    fireEvent.change(input, { target: { value: '保留的项目' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByText('创建失败')
    expect((input as HTMLInputElement).value).toBe('保留的项目')
  })
})
