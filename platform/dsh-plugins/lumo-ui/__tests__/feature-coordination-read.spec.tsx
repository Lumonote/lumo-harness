// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LumoOverlay } from '../src/client/index.tsx'
import { takeOperationsTarget } from '../src/client/operations-navigation.ts'

const project = { id: 'a', name: '项目 a', realm: 'realm-a', status: 'active' }
const dashboard = { project, yourRole: 'owner', members: [], spaces: [], artifacts: [], automations: [], usage: [] }
const overview = {
  generatedAt: '2026-11-08T00:00:00Z',
  deployment: { mode: 'cluster', label: '集群', storage: 'postgres', middleware: [], distributed: true, desktop: false, clusterReady: true, clusterOnly: true },
  services: {}, cluster: { nodes: [] }, projects: [project], flows: [], connectors: [], plugins: [],
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish }); return { resolve, promise } }

async function mount(custom: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  history.replaceState({}, '', '/?lumo=operations')
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
    if (url.pathname === '/lumo/api/projects/directory') return json({ projects: [{ ...project, yourRole: 'owner', memberCount: 1 }], summary: { total: 1, active: 1, archived: 0 }, total: 1, limit: 20, offset: 0, hasMore: false })
    if (path === '/lumo/api/projects/a/dashboard') return json(dashboard)
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  render(<LumoOverlay {...{} as never} />)
  await waitFor(() => expect((screen.getByRole('button', { name: '重新读取' }) as HTMLButtonElement).disabled).toBe(false))
  return fetch
}

afterEach(() => { cleanup(); takeOperationsTarget(); vi.unstubAllGlobals(); history.replaceState({}, '', '/') })

describe('project and employee read coordination', () => {
  it('does not let the older refresh from a parallel project save overwrite the latest dashboard', async () => {
    let reads = 0
    const older = defer<Response>()
    const newer = defer<Response>()
    await mount((path, init) => {
      if (path === '/lumo/api/projects/a/dashboard') {
        reads++
        if (reads === 2) return older.promise
        if (reads === 3) return newer.promise
      }
      if (path === '/lumo/api/projects/a/spaces' && init?.method === 'POST') return json({ spaceId: 'space-a', name: '知识空间' }, 201)
      if (path === '/lumo/api/projects/a/artifacts/skill/review' && init?.method === 'PUT') return json({ kind: 'skill', name: 'review', version: '1' })
      return undefined
    })
    fireEvent.click(await screen.findByRole('button', { name: '打开项目 项目 a' }))
    const sheet = within(await screen.findByRole('complementary', { name: '项目详情' }))
    fireEvent.change(sheet.getByRole('textbox', { name: '项目空间名称' }), { target: { value: '知识空间' } })
    fireEvent.click(sheet.getByRole('button', { name: '创建空间' }))
    await waitFor(() => expect(reads).toBe(2))
    fireEvent.change(sheet.getByRole('textbox', { name: '制品名称' }), { target: { value: 'review' } })
    fireEvent.change(sheet.getByRole('textbox', { name: '制品版本' }), { target: { value: '1' } })
    fireEvent.click(sheet.getByRole('button', { name: '挂载制品' }))
    await waitFor(() => expect(reads).toBe(3))
    await act(async () => {
      newer.resolve(json({ ...dashboard, project: { ...project, name: '最新项目快照' }, spaces: [{ spaceId: 'space-a', name: '知识空间' }], artifacts: [{ kind: 'skill', name: 'review', version: '1' }] }))
      await newer.promise
    })
    expect(sheet.getByRole('heading', { name: '最新项目快照' })).toBeTruthy()
    expect(sheet.getByText('review', { selector: 'b' })).toBeTruthy()
    await act(async () => { older.resolve(json({ ...dashboard, project: { ...project, name: '旧项目快照' } })); await older.promise })
    expect(sheet.getByRole('heading', { name: '最新项目快照' })).toBeTruthy()
    expect(sheet.queryByRole('heading', { name: '旧项目快照' })).toBeNull()
    expect(sheet.getByText('review', { selector: 'b' })).toBeTruthy()
    expect(sheet.getByText('知识空间', { selector: 'b' })).toBeTruthy()
  })

  it('allows explicit retry of a failed tag read for the same employee', async () => {
    let reads = 0
    await mount((path, init) => path === '/lumo/api/users/u-a/tags' && init?.method !== 'PUT'
      ? ++reads === 1 ? json({ message: '标签服务暂不可用' }, 503) : json({ tags: ['合同'] })
      : undefined)
    fireEvent.click(screen.getByRole('button', { name: '协作执行委派、专家与运行证据' }))
    await screen.findByText('标签服务暂不可用')
    expect((screen.getByRole('textbox', { name: '标签' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新读取标签' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '标签' }) as HTMLInputElement).value).toBe('合同'))
    expect((screen.getByRole('button', { name: '保存标签' }) as HTMLButtonElement).disabled).toBe(false)
    expect(reads).toBe(2)
  })

  it('treats a null tag list from Go as an empty profile that can receive its first tag', async () => {
    const fetch = await mount((path, init) => path === '/lumo/api/users/u-a/tags'
      ? json({ tags: init?.method === 'PUT' ? ['合同'] : null }) : undefined)
    fireEvent.click(screen.getByRole('button', { name: '协作执行委派、专家与运行证据' }))
    const input = screen.getByRole('textbox', { name: '标签' }) as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '合同' } })
    fireEvent.click(screen.getByRole('button', { name: '保存标签' }))
    await screen.findByText('人员标签已保存，后续意图分发会使用最新画像。')
    const write = fetch.mock.calls.find(([path, init]) => path === '/lumo/api/users/u-a/tags' && init?.method === 'PUT')
    expect(JSON.parse(write![1]!.body as string)).toEqual({ tags: ['合同'] })
  })

  it('does not let a late write for the previous employee alter the new employee draft or unlock their pending save', async () => {
    const previousWrite = defer<Response>()
    const currentWrite = defer<Response>()
    const fetch = await mount((path, init) => {
      if (path === '/lumo/api/users/u-a/tags') return init?.method === 'PUT' ? previousWrite.promise : json({ tags: ['A 原标签'] })
      if (path === '/lumo/api/users/u-b/tags') return init?.method === 'PUT' ? currentWrite.promise : json({ tags: ['B 原标签'] })
      return undefined
    })
    fireEvent.click(screen.getByRole('button', { name: '协作执行委派、专家与运行证据' }))
    const input = screen.getByRole('textbox', { name: '标签' }) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('A 原标签'))
    fireEvent.change(input, { target: { value: 'A 新标签' } })
    fireEvent.click(screen.getByRole('button', { name: '保存标签' }))
    fireEvent.change(screen.getByRole('combobox', { name: '人员' }), { target: { value: 'u-b' } })
    await waitFor(() => expect(input.value).toBe('B 原标签'))
    fireEvent.change(input, { target: { value: 'B 新标签' } })
    fireEvent.click(screen.getByRole('button', { name: '保存标签' }))
    await act(async () => { previousWrite.resolve(json({ tags: ['A 新标签'] })); await previousWrite.promise })
    expect(input.value).toBe('B 新标签')
    expect(input.disabled).toBe(true)
    expect(screen.queryByText('人员标签已保存，后续意图分发会使用最新画像。')).toBeNull()
    fireEvent.submit(input.closest('form')!)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2)
    await act(async () => { currentWrite.resolve(json({ tags: ['B 已保存'] })); await currentWrite.promise })
    expect(input.value).toBe('B 已保存')
    expect(input.disabled).toBe(false)
    expect(screen.getByText('人员标签已保存，后续意图分发会使用最新画像。')).toBeTruthy()
  })
})
