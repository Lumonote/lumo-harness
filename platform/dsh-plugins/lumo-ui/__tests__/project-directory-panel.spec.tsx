// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectDirectoryPanel, projectDirectoryURL, type ProjectDirectoryResponse } from '../src/client/project-directory-panel.tsx'
import { ApiError } from '../src/client/api.ts'
import { directoryCacheKey } from '../src/client/project-directory-cache.ts'

afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers() })
const initialPath = '/lumo/api/projects/directory?limit=20&offset=0&sort=recent'
const project = { id: 'p/1', name: 'Project Alpha', status: 'active' as const, yourRole: 'owner' as const, memberCount: 3, createdAt: '2026-01-01T00:00:00Z' }
function page(extra: Partial<ProjectDirectoryResponse> = {}): ProjectDirectoryResponse {
  return { projects: [project], summary: { total: 1, active: 1, archived: 0 }, total: 1, limit: 20, offset: 0, hasMore: false, ...extra }
}
function mount(request = vi.fn().mockResolvedValue(page())) {
  const onOpen = vi.fn()
  return { request, onOpen, ...render(<ProjectDirectoryPanel request={request} onOpen={onOpen} />) }
}
describe('project directory', () => {
  const actor = { realm: 'team', userId: 'alice' }
  const cachedPage = () => page({ viewer: actor })

  it('shows only the same account and query snapshot during an outage, then replaces it on reconnect', async () => {
    const request = vi.fn().mockResolvedValueOnce(cachedPage()).mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(page({ viewer: actor, projects: [] }))
    const onOpen = vi.fn()
    const view = render(<ProjectDirectoryPanel request={request} actor={actor} onOpen={onOpen} />)
    await screen.findByText('Project Alpha')
    view.rerender(<ProjectDirectoryPanel request={request} actor={actor} onOpen={onOpen} refreshKey={1} />)
    await screen.findByText(/正在显示上次读取的目录/)
    const open = screen.getByRole('button', { name: '打开项目 Project Alpha' }) as HTMLButtonElement
    expect(open.disabled).toBe(true)
    fireEvent.click(open); expect(onOpen).not.toHaveBeenCalled()
    fireEvent(window, new Event('online'))
    await screen.findByText('你还没有加入项目。创建一个项目，或请项目负责人添加你。')
    expect(screen.queryByText(/正在显示上次读取/)).toBeNull()
  })

  it('does not substitute a different query page and supports explicitly forgetting the snapshot', async () => {
    const request = vi.fn().mockResolvedValueOnce(cachedPage()).mockRejectedValue(new ApiError(503, null, 'offline'))
    const view = render(<ProjectDirectoryPanel request={request} actor={actor} onOpen={vi.fn()} />)
    await screen.findByText('Project Alpha')
    fireEvent.change(screen.getByRole('combobox', { name: '我的项目角色' }), { target: { value: 'viewer' } })
    await screen.findByRole('alert')
    expect(screen.queryByText('Project Alpha')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    await screen.findByText(/正在显示上次读取/)
    fireEvent.click(screen.getByRole('button', { name: '清除目录快照' }))
    expect(screen.queryByText('Project Alpha')).toBeNull()
    expect(sessionStorage.getItem(directoryCacheKey(actor)!)).toBeNull()
    view.unmount()
  })

  it.each([401, 403])('clears all cached pages after access is denied with %s', async status => {
    const request = vi.fn().mockResolvedValueOnce(cachedPage()).mockRejectedValueOnce(new ApiError(status, null, 'denied')).mockRejectedValue(new TypeError('offline'))
    const props = { request, actor, onOpen: vi.fn() }
    const view = render(<ProjectDirectoryPanel {...props} />)
    await screen.findByText('Project Alpha')
    view.rerender(<ProjectDirectoryPanel {...props} refreshKey={1} />)
    await screen.findByText(/已清除本次登录的快照/)
    expect(sessionStorage.getItem(directoryCacheKey(actor)!)).toBeNull()
    view.rerender(<ProjectDirectoryPanel {...props} refreshKey={2} />)
    await screen.findByRole('alert')
    expect(screen.queryByText('Project Alpha')).toBeNull()
  })

  it('ignores late old-account reads and clears the old snapshot when the account changes', async () => {
    let finish!: (value: ProjectDirectoryResponse) => void
    const request = vi.fn().mockResolvedValueOnce(cachedPage()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValue(new TypeError('offline'))
    const props = { request, onOpen: vi.fn() }
    const view = render(<ProjectDirectoryPanel {...props} actor={actor} />)
    await screen.findByText('Project Alpha')
    view.rerender(<ProjectDirectoryPanel {...props} actor={actor} refreshKey={1} />)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    view.rerender(<ProjectDirectoryPanel {...props} actor={{ ...actor, userId: 'bob' }} />)
    await screen.findByRole('alert')
    await act(async () => { finish(cachedPage()) })
    expect(screen.queryByText('Project Alpha')).toBeNull()
    expect(sessionStorage.getItem(directoryCacheKey(actor)!)).toBeNull()
  })

  it('rejects a response from another authenticated identity and expires old snapshots', async () => {
    const request = vi.fn().mockResolvedValueOnce(cachedPage()).mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(page({ viewer: { ...actor, userId: 'bob' } }))
    const props = { request, actor, onOpen: vi.fn() }
    const view = render(<ProjectDirectoryPanel {...props} />)
    await screen.findByText('Project Alpha')
    const key = directoryCacheKey(actor)!
    const snapshot = JSON.parse(sessionStorage.getItem(key)!)
    snapshot[0].savedAt -= 24 * 60 * 60 * 1000 + 1
    sessionStorage.setItem(key, JSON.stringify(snapshot))
    view.rerender(<ProjectDirectoryPanel {...props} refreshKey={1} />)
    await screen.findByRole('alert')
    expect(screen.queryByText('Project Alpha')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText(/登录身份已变化/)
    expect(sessionStorage.getItem(key)).toBeNull()
  })

  it('keeps online reads working with corrupt or unavailable session storage and omits unrelated fields', async () => {
    const key = directoryCacheKey(actor)!
    sessionStorage.setItem(key, '{broken')
    const request = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ ...cachedPage(), internalSecret: 'do-not-cache' })
    const view = render(<ProjectDirectoryPanel request={request} actor={actor} onOpen={vi.fn()} />)
    await screen.findByRole('alert')
    expect(sessionStorage.getItem(key)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('Project Alpha')
    expect(sessionStorage.getItem(key)).not.toContain('internalSecret')
    const failedStorage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota') })
    try {
      view.rerender(<ProjectDirectoryPanel request={request} actor={actor} onOpen={vi.fn()} refreshKey={1} />)
      await screen.findByText(/浏览器未允许保存快照/)
      expect((screen.getByRole('button', { name: '打开项目 Project Alpha' }) as HTMLButtonElement).disabled).toBe(false)
    } finally { failedStorage.mockRestore() }
  })

  it('loads current membership, displays role/member count, and opens the project', async () => {
    const f = mount()
    await screen.findByText('Project Alpha')
    expect(f.request).toHaveBeenCalledWith(initialPath, { signal: expect.any(AbortSignal) })
    expect(screen.getAllByText('负责人')).toHaveLength(2)
    expect(screen.getByText('3 位成员')).toBeDefined()
    expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '打开项目 Project Alpha' }))
    expect(f.onOpen).toHaveBeenCalledExactlyOnceWith('p/1')
  })
  it('encodes literal search text and omits unrestricted filters', () => {
    const url = projectDirectoryURL({ query: '  100%_&任务  ', status: 'all', role: 'all', sort: 'name', limit: 20, offset: 40 })
    const params = new URL(url, 'https://example.test').searchParams
    expect(params.get('q')).toBe('100%_&任务')
    expect(params.has('status')).toBe(false)
    expect(params.has('role')).toBe(false)
    expect(params.get('offset')).toBe('40')
  })
  it('resets pagination for search and filters, and ignores late responses', async () => {
    let finishOld!: (result: ProjectDirectoryResponse) => void
    const request = vi.fn().mockResolvedValueOnce(page({ total: 21, hasMore: true })).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockResolvedValue(page({ projects: [{ ...project, name: 'Archived Alpha', status: 'archived' }] }))
    mount(request)
    await screen.findByText('Project Alpha')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(request.mock.calls[1]![0]).toContain('offset=20')
    fireEvent.change(screen.getByRole('combobox', { name: '项目状态' }), { target: { value: 'archived' } })
    await screen.findByText('Archived Alpha')
    expect(request.mock.calls[1]![1].signal.aborted).toBe(true)
    expect(request.mock.calls[2]![0]).toContain('offset=0')
    expect(request.mock.calls[2]![0]).toContain('status=archived')
    await act(async () => { finishOld(page({ projects: [{ ...project, name: 'Stale page' }] })) })
    expect(screen.queryByText('Stale page')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索项目' }), { target: { value: ' Alpha ' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4))
    expect(request.mock.calls[3]![0]).toContain('q=Alpha')
    fireEvent.change(screen.getByRole('combobox', { name: '我的项目角色' }), { target: { value: 'viewer' } })
    await waitFor(() => expect(request.mock.calls.at(-1)![0]).toContain('role=viewer'))
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(request.mock.calls.at(-1)![0]).toBe(initialPath))
  })
  it('recovers from membership removal leaving the current page empty', async () => {
    const request = vi.fn().mockResolvedValueOnce(page({ total: 21, hasMore: true })).mockResolvedValueOnce(page({ projects: [], total: 2, offset: 20 })).mockResolvedValue(page({ projects: [{ ...project, name: 'Remaining project' }], total: 2 }))
    mount(request)
    await screen.findByText('Project Alpha')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findByText('Remaining project')
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2]![0]).toBe(initialPath)
  })
  it('reports service failure, clears previous results, and supports retry', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page())
    mount(request)
    expect((await screen.findByRole('alert')).textContent).toContain('项目目录加载失败：offline')
    expect(screen.queryByText('你还没有加入项目。创建一个项目，或请项目负责人添加你。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('Project Alpha')
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each([{}, { ...page(), summary: undefined }, { ...page(), projects: [null] }])('shows malformed service responses as a recoverable error: %j', async invalid => {
    const request = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue(page())
    mount(request)
    expect((await screen.findByRole('alert')).textContent).toContain('项目目录响应格式不完整')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('Project Alpha')
  })
  it('refreshes after project changes and cancels requests on unmount', async () => {
    const f = mount()
    await screen.findByText('Project Alpha')
    f.request.mockResolvedValue(page({ projects: [] }))
    f.rerender(<ProjectDirectoryPanel request={f.request} onOpen={f.onOpen} refreshKey="changed" />)
    await screen.findByText('你还没有加入项目。创建一个项目，或请项目负责人添加你。')
    expect(f.request).toHaveBeenCalledTimes(2)
    f.unmount()
    expect(f.request.mock.calls[1]![1].signal.aborted).toBe(true)
  })
})
