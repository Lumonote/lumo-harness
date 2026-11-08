// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectDirectoryPanel, projectDirectoryURL, type ProjectDirectoryResponse } from '../src/client/project-directory-panel.tsx'

afterEach(cleanup)
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
