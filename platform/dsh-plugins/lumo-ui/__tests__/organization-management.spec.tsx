// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrganizationManagement } from '../src/client/index.tsx'

interface DirectoryUser { id: string; display_name: string; primary_dept_id: string; status: string }
interface DirectoryPage { users: DirectoryUser[]; total: number; has_more: boolean }
const user = (id: string, status = 'active', primary_dept_id = 'main'): DirectoryUser => ({ id, display_name: `用户 ${id}`, status, primary_dept_id })
const firstUsers = Array.from({ length: 50 }, (_, index) => user(`person-${String(index + 1).padStart(3, '0')}`))
const lastUsers = Array.from({ length: 5 }, (_, index) => user(`person-${index + 51}`, 'disabled', 'late'))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function mount(directory: (params: URLSearchParams) => DirectoryPage | Response | Promise<DirectoryPage | Response> = params => Number(params.get('offset')) === 50 ? { users: lastUsers, total: 55, has_more: false } : { users: firstUsers, total: 55, has_more: true }) {
  const calls: Array<{ method: string; url: URL; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'https://lumo.test')
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'POST' && url.pathname === '/lumo/api/users') return json(user(String(JSON.parse(String(init?.body)).id)), 201)
    if (url.pathname === '/lumo/api/users') {
      const result = await directory(url.searchParams)
      return result instanceof Response ? result : json(result)
    }
    if (url.pathname === '/lumo/api/roles') return json({ roles: [{ id: 'employee', name: '员工', status: 'active' }] })
    if (url.pathname === '/lumo/api/departments') return json({ departments: [{ id: 'main', name: '总部', status: 'active' }, { id: 'late', name: '分部', status: 'active' }] })
    if (/^\/lumo\/api\/users\/[^/]+\/access$/u.test(url.pathname)) return json({ username: '', login_enabled: false, roles: [] })
    throw new Error(`Unexpected request ${method} ${url.pathname}`)
  }))
  const view = render(<OrganizationManagement view="users" />)
  const reads = () => calls.filter(call => call.method === 'GET' && call.url.pathname === '/lumo/api/users')
  const pager = () => within(screen.getByRole('navigation', { name: '用户列表分页' }))
  return { ...view, calls, reads, pager }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('organization user management', () => {
  it('requests and displays all user pages with authoritative ranges', async () => {
    const f = mount()
    await waitFor(() => expect(f.pager().getByRole('status').textContent).toBe('共 55 位用户 · 第 1–50 位'))
    expect(Object.fromEntries(f.reads()[0]!.url.searchParams)).toEqual({ limit: '50', offset: '0' })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(f.pager().getByRole('status').textContent).toBe('共 55 位用户 · 第 51–55 位'))
    expect(f.reads().at(-1)!.url.searchParams.get('offset')).toBe('50')
    expect(screen.getByRole('button', { name: /用户 person-51/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /用户 person-001/u })).toBeNull()
    expect((f.pager().getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(f.pager().getByRole('button', { name: '上一页' }))
    await screen.findByRole('button', { name: /用户 person-001/u })
    expect(f.reads().at(-1)!.url.searchParams.get('offset')).toBe('0')
  })

  it('filters the whole directory, returns to its first page, and debounces literal search input', async () => {
    const f = mount(params => {
      if (params.has('status') || params.has('department_id') || params.has('q')) return { users: [user('tail', 'disabled', 'late')], total: 1, has_more: false }
      return Number(params.get('offset')) === 50 ? { users: lastUsers, total: 55, has_more: false } : { users: firstUsers, total: 55, has_more: true }
    })
    await screen.findByRole('button', { name: /用户 person-001/u })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await screen.findByRole('button', { name: /用户 person-51/u })
    fireEvent.change(screen.getByRole('combobox', { name: '用户状态' }), { target: { value: 'disabled' } })
    await screen.findByRole('button', { name: /用户 tail/u })
    expect(Object.fromEntries(f.reads().at(-1)!.url.searchParams)).toEqual({ limit: '50', offset: '0', status: 'disabled' })
    fireEvent.change(screen.getByRole('combobox', { name: '所属部门' }), { target: { value: 'late' } })
    await waitFor(() => expect(f.reads().at(-1)!.url.searchParams.get('department_id')).toBe('late'))
    const beforeSearch = f.reads().length
    fireEvent.change(screen.getByRole('textbox', { name: '搜索用户' }), { target: { value: '  王 & 100%_  ' } })
    expect(f.reads()).toHaveLength(beforeSearch)
    await waitFor(() => expect(f.reads().at(-1)!.url.searchParams.get('q')).toBe('王 & 100%_'))
    expect(Object.fromEntries(f.reads().at(-1)!.url.searchParams)).toEqual({ limit: '50', offset: '0', q: '王 & 100%_', status: 'disabled', department_id: 'late' })
  })

  it('keeps the successful page after a failed next-page request and retries the same offset', async () => {
    let nextAttempts = 0
    const f = mount(params => {
      if (params.get('offset') === '50') {
        nextAttempts++
        return nextAttempts === 1 ? json({ message: '目录服务暂不可用' }, 503) : { users: lastUsers, total: 55, has_more: false }
      }
      return { users: firstUsers, total: 55, has_more: true }
    })
    await screen.findByRole('button', { name: /用户 person-001/u })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await screen.findByText('目录服务暂不可用')
    expect(f.pager().getByRole('status').textContent).toBe('共 55 位用户 · 第 1–50 位')
    expect(screen.getByRole('button', { name: /用户 person-001/u })).toBeTruthy()
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(f.pager().getByRole('status').textContent).toBe('共 55 位用户 · 第 51–55 位'))
    expect(f.reads().map(call => call.url.searchParams.get('offset'))).toEqual(['0', '50', '50'])
    expect(screen.queryByText('目录服务暂不可用')).toBeNull()
  })

  it('ignores an obsolete page response after the filter has changed', async () => {
    let resolvePage!: (page: DirectoryPage) => void
    const pendingPage = new Promise<DirectoryPage>(resolve => { resolvePage = resolve })
    const f = mount(params => {
      if (params.get('status') === 'disabled') return { users: [user('disabled-person', 'disabled')], total: 1, has_more: false }
      return params.get('offset') === '50' ? pendingPage : { users: firstUsers, total: 55, has_more: true }
    })
    await screen.findByRole('button', { name: /用户 person-001/u })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    expect(f.pager().getByRole('status').textContent).toBe('共 55 位用户 · 第 1–50 位')
    fireEvent.change(screen.getByRole('combobox', { name: '用户状态' }), { target: { value: 'disabled' } })
    await screen.findByRole('button', { name: /用户 disabled-person/u })
    await act(async () => { resolvePage({ users: lastUsers, total: 55, has_more: false }); await pendingPage })
    expect(f.pager().getByRole('status').textContent).toBe('共 1 位用户 · 第 1–1 位')
    expect(screen.queryByRole('button', { name: /用户 person-51/u })).toBeNull()
  })

  it.each([5, 0])('corrects an obsolete last page when the directory shrinks to %i users', async total => {
    let shrinking = false
    const f = mount(params => {
      const offset = Number(params.get('offset'))
      if (shrinking) return { users: offset === 0 ? firstUsers.slice(0, total) : [], total, has_more: false }
      return offset === 50 ? { users: lastUsers, total: 55, has_more: false } : { users: firstUsers, total: 55, has_more: true }
    })
    await screen.findByRole('button', { name: /用户 person-001/u })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await screen.findByRole('button', { name: /用户 person-51/u })
    shrinking = true
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(f.pager().getByRole('status').textContent).toBe(total ? '共 5 位用户 · 第 1–5 位' : '共 0 位用户 · 当前页为空'))
    expect(f.reads().map(call => call.url.searchParams.get('offset'))).toEqual(['0', '50', '50', '0'])
  })

  it('locates a newly created user beyond the first matching page and clears old filters', async () => {
    const f = mount(params => params.get('q') === 'new'
      ? params.get('offset') === '50' ? { users: [user('new')], total: 51, has_more: false } : { users: firstUsers, total: 51, has_more: true }
      : { users: lastUsers, total: 5, has_more: false })
    await screen.findByRole('button', { name: /用户 person-51/u })
    fireEvent.change(screen.getByRole('combobox', { name: '用户状态' }), { target: { value: 'disabled' } })
    fireEvent.change(screen.getByRole('combobox', { name: '所属部门' }), { target: { value: 'late' } })
    await waitFor(() => expect(f.reads().at(-1)!.url.searchParams.get('department_id')).toBe('late'))
    fireEvent.click(screen.getByRole('button', { name: '新建用户' }))
    const form = screen.getByRole('form', { name: '新建用户' })
    for (const [name, value] of Object.entries({ id: 'new', display_name: '新用户', username: 'new', password: 'strong-password', confirmation: 'strong-password' })) {
      fireEvent.change(form.querySelector(`[name="${name}"]`)!, { target: { value } })
    }
    fireEvent.submit(form)
    await screen.findByText('用户「新用户」已创建。')
    await waitFor(() => expect(screen.getByRole('button', { name: /用户 new/u }).getAttribute('aria-pressed')).toBe('true'))
    expect((screen.getByRole('textbox', { name: '搜索用户' }) as HTMLInputElement).value).toBe('new')
    expect((screen.getByRole('combobox', { name: '用户状态' }) as HTMLSelectElement).value).toBe('all')
    expect((screen.getByRole('combobox', { name: '所属部门' }) as HTMLSelectElement).value).toBe('')
    expect(f.reads().slice(-2).map(call => Object.fromEntries(call.url.searchParams))).toEqual([{ limit: '50', offset: '0', q: 'new' }, { limit: '50', offset: '50', q: 'new' }])
    expect(f.pager().getByRole('status').textContent).toBe('共 51 位用户 · 第 51–51 位')
  })

  it('admits one write for duplicate submissions in the same batch and permits retry after failure', async () => {
    mount()
    await screen.findByRole('button', { name: /用户 person-001/u })
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    let finish!: (response: Response) => void
    let writes = 0
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === '/lumo/api/users' && init?.method === 'POST') {
        writes++
        return writes === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(json(user('new'), 201))
      }
      return originalFetch(input, init)
    })
    fireEvent.click(screen.getByRole('button', { name: '新建用户' }))
    const form = screen.getByRole('form', { name: '新建用户' })
    for (const [name, value] of Object.entries({ id: 'new', display_name: '新用户', username: 'new', password: 'strong-password', confirmation: 'strong-password' })) {
      fireEvent.change(form.querySelector(`[name="${name}"]`)!, { target: { value } })
    }
    act(() => { fireEvent.submit(form); fireEvent.submit(form) })
    expect(writes).toBe(1)
    finish(json({ message: '暂时无法创建用户' }, 503))
    await screen.findByText('暂时无法创建用户')
    fireEvent.submit(form)
    await screen.findByText('用户「新用户」已创建。')
    expect(writes).toBe(2)
  })
})
