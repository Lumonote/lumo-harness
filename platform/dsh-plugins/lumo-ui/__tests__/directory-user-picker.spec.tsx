// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryUserPicker } from '../src/client/directory-user-picker.tsx'

const user = (id: string, status = 'active') => ({ id, display_name: `同事 ${id}`, status, primary_dept_id: 'department' })
const first = Array.from({ length: 20 }, (_, index) => user(`person-${index + 1}`))
const page = (users = first, total = 25, has_more = true) => ({ users, total, has_more })
function mount(request = vi.fn().mockImplementation((path: string) => Promise.resolve(new URL(path, 'https://example.test').searchParams.get('offset') === '20' ? page([user('person-25')], 25, false) : page())), initialUserId = '') {
  const view = render(<form aria-label="部门设置"><DirectoryUserPicker request={request} initialUserId={initialUserId} /></form>)
  return { ...view, request, value: () => new FormData(screen.getByRole('form', { name: '部门设置' }) as HTMLFormElement).get('manager_user_id'), pager: () => within(screen.getByRole('navigation', { name: '用户列表分页' })) }
}
afterEach(cleanup)

describe('department manager directory selection', () => {
  it('selects active users across pages independently of the organization screen page', async () => {
    const f = mount()
    await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
    expect(new URL(f.request.mock.calls[0]![0], 'https://example.test').search).toBe('?limit=20&offset=0&status=active')
    expect(f.value()).toBe('')
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    fireEvent.click(await screen.findByRole('button', { name: /同事 person-25/u }))
    expect(f.value()).toBe('person-25')
    fireEvent.click(f.pager().getByRole('button', { name: '上一页' }))
    await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
    expect(f.value()).toBe('person-25')
    expect(screen.getByText('已选择：同事 person-25 · person-25')).toBeTruthy()
  })

  it('preserves an existing manager outside the loaded page until an explicit clear or new choice', async () => {
    const f = mount(undefined, 'original-manager')
    await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
    expect(f.value()).toBe('original-manager')
    fireEvent.click(screen.getByRole('button', { name: '清除负责人' }))
    expect(f.value()).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /同事 person-2(?![0-9])/u }))
    expect(f.value()).toBe('person-2')
  })

  it('resets its submitted manager when the enclosing department form resets', async () => {
    const f = mount()
    fireEvent.click(await screen.findByRole('button', { name: /同事 person-2(?![0-9])/u }))
    expect(f.value()).toBe('person-2')
    act(() => { (screen.getByRole('form', { name: '部门设置' }) as HTMLFormElement).reset() })
    expect(f.value()).toBe('')
    expect(screen.getByText('未指定负责人')).toBeTruthy()
  })

  it('searches by name after debounce and resets the offset while preserving its selected manager', async () => {
    const request = vi.fn().mockResolvedValue(page())
    const f = mount(request, 'original')
    await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(f.pager().getByRole('status').textContent).toContain('第 21–25 位'))
    const before = request.mock.calls.length
    fireEvent.change(screen.getByRole('textbox', { name: '负责人搜索' }), { target: { value: ' 王 & 100%_ ' } })
    expect(request).toHaveBeenCalledTimes(before)
    await waitFor(() => expect(request.mock.calls.at(-1)![0]).toContain('q='))
    expect(Object.fromEntries(new URL(request.mock.calls.at(-1)![0], 'https://example.test').searchParams)).toEqual({ limit: '20', offset: '0', status: 'active', q: '王 & 100%_' })
    expect(f.value()).toBe('original')
  })

  it('retains selection and successful range on failure, and allows retry of that page', async () => {
    const request = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('目录读取失败')).mockResolvedValueOnce(page([user('person-25')], 25, false))
    const f = mount(request, 'original')
    await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await screen.findByRole('alert')
    expect(f.pager().getByRole('status').textContent).toBe('共 25 位用户 · 第 1–20 位')
    expect(f.value()).toBe('original')
    fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
    await screen.findByRole('button', { name: /同事 person-25/u })
    expect(request.mock.calls.slice(1).map(call => new URL(call[0], 'https://example.test').searchParams.get('offset'))).toEqual(['20', '20'])
  })

  it('does not let a late old search replace a newer result or select a suspended user', async () => {
    let finish!: (value: ReturnType<typeof page>) => void
    const pending = new Promise<ReturnType<typeof page>>(resolve => { finish = resolve })
    const request = vi.fn().mockImplementation((path: string) => {
      const query = new URL(path, 'https://example.test').searchParams.get('q')
      return query === 'old' ? pending : Promise.resolve(query === 'new' ? page([user('new'), user('suspended', 'suspended')], 2, false) : page())
    })
    const f = mount(request)
    await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
    fireEvent.change(screen.getByRole('textbox', { name: '负责人搜索' }), { target: { value: 'old' } })
    await waitFor(() => expect(request.mock.calls.at(-1)![0]).toContain('q=old'))
    fireEvent.change(screen.getByRole('textbox', { name: '负责人搜索' }), { target: { value: 'new' } })
    await screen.findByRole('button', { name: /同事 new/u })
    await act(async () => { finish(page([user('old')], 1, false)); await pending })
    expect(screen.queryByRole('button', { name: /同事 old/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /同事 suspended/u }))
    expect(f.value()).toBe('')
  })
})

it('switches the selected manager when the owning department receives a new saved manager', async () => {
  const request = vi.fn().mockResolvedValue(page())
  const view = render(<form aria-label="部门设置"><DirectoryUserPicker request={request} initialUserId="first-manager" /></form>)
  await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
  fireEvent.click(screen.getByRole('button', { name: /同事 person-2(?![0-9])/u }))
  view.rerender(<form aria-label="部门设置"><DirectoryUserPicker request={request} initialUserId="second-manager" /></form>)
  expect(new FormData(screen.getByRole('form', { name: '部门设置' }) as HTMLFormElement).get('manager_user_id')).toBe('second-manager')
  await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
})
it('retries the failed page and prevents selecting stale candidates after failure', async () => {
  const request = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(Error('读取失败')).mockResolvedValueOnce(page([user('person-25')], 25, false))
  const f = mount(request)
  await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
  fireEvent.click(f.pager().getByRole('button', { name: '下一页' })); await screen.findByRole('alert')
  expect((screen.getByRole('button', { name: /同事 person-1(?![0-9])/u }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '重试读取负责人' })); await screen.findByRole('button', { name: /同事 person-25/u })
  expect(new URL(request.mock.calls.at(-1)![0], 'https://example.test').searchParams.get('offset')).toBe('20')
})
it('form reset invalidates an unfinished page request and restores first-page candidates', async () => {
  let finish!: (value: ReturnType<typeof page>) => void
  const request = vi.fn().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(page())
  const f = mount(request, 'original')
  await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u })
  fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
  act(() => (screen.getByRole('form', { name: '部门设置' }) as HTMLFormElement).reset())
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
  await act(async () => { finish(page([user('stale')], 25, false)) })
  expect(screen.queryByRole('button', { name: /同事 stale/u })).toBeNull(); expect(f.value()).toBe('original')
  expect(f.pager().getByRole('status').textContent).toContain('第 1–20 位')
})
it('rejects malformed directory data and removes stale names on permission revocation', async () => {
  const request = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(Object.assign(Error('无权读取目录'), { status: 403 })).mockResolvedValueOnce({ users: [null], total: 1, has_more: false })
  const f = mount(request)
  await screen.findByRole('button', { name: /同事 person-1(?![0-9])/u }); fireEvent.click(f.pager().getByRole('button', { name: '下一页' }))
  await screen.findByText('无权读取目录'); expect(screen.queryByRole('button', { name: /同事 person-/u })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重试读取负责人' })); await screen.findByText('用户目录响应无效，请重新读取。')
})
