// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectSettingsPanel } from '../src/client/project-settings-panel.tsx'

afterEach(cleanup)
const project = { id: 'p/1', name: 'Original', status: 'active' }
function mount(extra = {}) {
  const request = vi.fn().mockResolvedValue({ ...project, name: 'Updated' })
  const refresh = vi.fn().mockResolvedValue(undefined)
  return { request, refresh, ...render(<ProjectSettingsPanel request={request} refresh={refresh} project={project} role="owner" {...extra} />) }
}
function rename() {
  fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), { target: { value: ' Updated ' } })
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
}
describe('project settings', () => {
  it('submits an expected name and trims the replacement', async () => {
    const f = mount()
    rename()
    await screen.findByText('项目名称已保存。')
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/lumo/api/projects/p%2F1', { method: 'PATCH', body: '{"name":"Updated","expectedName":"Original"}' })
    expect(f.refresh).toHaveBeenCalledOnce()
  })
  it.each([{ role: 'viewer' }, { project: { ...project, status: 'archived' } }])('shows read-only state for %j', extra => {
    const f = mount(extra)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(f.request).not.toHaveBeenCalled()
  })
  it('preserves an unsaved draft and precondition when the project changes remotely', async () => {
    const f = mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Updated' } })
    f.rerender(<ProjectSettingsPanel request={f.request} refresh={f.refresh} project={{ ...project, name: 'Remote' }} role="owner" />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Updated')
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
    await waitFor(() => expect(f.request).toHaveBeenCalledOnce())
    expect(JSON.parse(f.request.mock.calls[0]![1].body)).toEqual({ name: 'Updated', expectedName: 'Original' })
  })
  it('requires rereading on conflict before permitting another write', async () => {
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error('name changed'), { status: 409 })).mockResolvedValueOnce({ project: { ...project, name: 'Remote' } })
    mount({ request })
    rename()
    expect((await screen.findByRole('alert')).textContent).toContain('保存冲突')
    expect((screen.getByRole('button', { name: '保存名称' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新读取名称' }))
    await screen.findByText('已读取当前项目名称。')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Remote')
    expect(request).toHaveBeenLastCalledWith('/lumo/api/projects/p%2F1')
  })
  it('deduplicates submissions and reports a failed refresh as saved', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    mount({ request, refresh })
    rename()
    fireEvent.submit(screen.getByRole('textbox').closest('form')!)
    expect(request).toHaveBeenCalledOnce()
    finish({ ...project, name: 'Updated' })
    expect((await screen.findByRole('alert')).textContent).toBe('已保存，刷新失败：offline')
    expect(screen.getByRole('status').textContent).toBe('项目名称已保存。')
  })
})
