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
