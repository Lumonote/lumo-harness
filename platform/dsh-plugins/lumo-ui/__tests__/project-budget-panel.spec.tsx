// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectBudgetPanel } from '../src/client/project-budget-panel.tsx'
import { DashboardSheet } from '../src/client/index.tsx'

afterEach(cleanup)
const initial = { projectId: 'p/1', unit: 'tokens', total: 1000, remaining: 800, softLimit: 900, overdraft: 100, revision: 3, state: 'within' }
function mount(options: { editable?: boolean; request?: ReturnType<typeof vi.fn> } = {}) {
  const request = options.request ?? vi.fn().mockResolvedValue(initial)
  return { request, ...render(<ProjectBudgetPanel request={request} projectID="p/1" editable={options.editable ?? true} />) }
}
const change = (name: string, value: string) => fireEvent.change(screen.getByRole('spinbutton', { name }), { target: { value } })
const submit = () => fireEvent.submit(screen.getByRole('form', { name: '预算配置' }))

describe('project budget management', () => {
  it('adjusts budget with current revision while keeping usage', async () => {
    const f = mount()
    await screen.findByRole('form', { name: '预算配置' })
    change('预算总额', '600'); change('预算软限额', '500')
    submit()
    await screen.findByText('预算已调整，已用额度保持不变。')
    expect(f.request).toHaveBeenLastCalledWith('/lumo/api/projects/p%2F1/budget', { method: 'POST', body: JSON.stringify({ mode: 'adjust', total: 600, softLimit: 500, overdraft: 100, expectedRevision: 3 }) })
  })

  it('requires explicit reset confirmation when initializing a new budget', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ...initial, total: null, remaining: null, softLimit: null, overdraft: 0, revision: 0, state: 'unconfigured' }).mockResolvedValue(initial)
    mount({ request })
    await screen.findByRole('form', { name: '预算配置' })
    expect((screen.getByRole('combobox', { name: '预算操作' }) as HTMLSelectElement).value).toBe('reset')
    change('预算总额', '1000'); change('预算软限额', '900')
    submit()
    expect((await screen.findByRole('alert')).textContent).toContain('请先确认')
    expect(request).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('checkbox', { name: '确认重置本期剩余额度' }))
    submit()
    await screen.findByText('本期预算已重置，历史台账保留。')
    expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ mode: 'reset', total: 1000, softLimit: 900, overdraft: 0, expectedRevision: 0, confirmReset: true })
  })

  it.each([['预算总额', '10'], ['预算软限额', '-1'], ['预算透支额度', '1.5'], ['预算总额', '9007199254740992']])('rejects inconsistent or unsafe %s value %s', async (name, value) => {
    const f = mount()
    await screen.findByRole('form', { name: '预算配置' })
    change(name, value); submit()
    await screen.findByRole('alert')
    expect(f.request).toHaveBeenCalledOnce()
  })

  it('requires reread after a conflict and uses the new revision', async () => {
    const request = vi.fn().mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }))
      .mockResolvedValueOnce({ ...initial, revision: 4, total: 1200 })
      .mockResolvedValueOnce({ ...initial, revision: 5 })
    mount({ request })
    await screen.findByRole('form', { name: '预算配置' }); submit()
    expect((await screen.findByRole('alert')).textContent).toContain('请重新读取')
    expect((screen.getByRole('button', { name: '保存预算' }) as HTMLButtonElement).disabled).toBe(true)
    submit(); expect(request).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '重新读取预算' }))
    await waitFor(() => expect((screen.getByRole('spinbutton', { name: '预算总额' }) as HTMLInputElement).value).toBe('1200'))
    submit()
    await screen.findByText('预算已调整，已用额度保持不变。')
    expect(JSON.parse(request.mock.calls[3]![1].body).expectedRevision).toBe(4)
  })

  it('deduplicates writes while a save is pending', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockResolvedValueOnce(initial).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    mount({ request })
    await screen.findByRole('form', { name: '预算配置' }); submit(); submit()
    expect(request).toHaveBeenCalledTimes(2)
    finish({ ...initial, revision: 4 })
    await screen.findByText('预算已调整，已用额度保持不变。')
  })

  it('shows current budget without controls for read-only members', async () => {
    mount({ editable: false })
    await screen.findByText('预算内')
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存预算' })).toBeNull()
  })

  it('can retry a failed initial read', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(initial)
    mount({ request })
    expect((await screen.findByRole('alert')).textContent).toBe('offline')
    fireEvent.click(screen.getByRole('button', { name: '重新读取预算' }))
    await screen.findByRole('form', { name: '预算配置' })
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('never applies the previous project save to the newly selected project', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ ...initial, projectId: 'second', total: 5000 })
    const f = mount({ request })
    await screen.findByRole('form', { name: '预算配置' }); submit()
    f.rerender(<ProjectBudgetPanel request={request} projectID="second" editable />)
    await waitFor(() => expect((screen.getByRole('spinbutton', { name: '预算总额' }) as HTMLInputElement).value).toBe('5000'))
    await act(async () => finish({ ...initial, total: 1200, revision: 4 }))
    expect((screen.getByRole('spinbutton', { name: '预算总额' }) as HTMLInputElement).value).toBe('5000')
    expect(screen.queryByText('预算已调整，已用额度保持不变。')).toBeNull()
  })
  it.each([{}, { ...initial, projectId: 'other' }, { ...initial, revision: -1 }])('rejects an invalid budget response %j', async response => {
    mount({ request: vi.fn().mockResolvedValue(response) })
    expect((await screen.findByRole('alert')).textContent).toContain('预算响应无效')
    expect(screen.queryByRole('form', { name: '预算配置' })).toBeNull()
  })
  it('requires reread after an invalid save receipt instead of claiming success', async () => {
    mount({ request: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue({}) })
    await screen.findByRole('form', { name: '预算配置' }); submit()
    expect((await screen.findByRole('alert')).textContent).toContain('保存回执无效')
    expect((screen.getByRole('button', { name: '保存预算' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('预算已调整，已用额度保持不变。')).toBeNull()
  })

  it.each([{ role: 'owner', status: 'active', write: true }, { role: 'editor', status: 'active', write: false }, { role: 'owner', status: 'archived', write: false }])('loads budget on expansion and respects $role/$status write scope', async state => {
    const request = vi.fn().mockResolvedValue(initial)
    render(<DashboardSheet data={{ project: { id: 'p/1', name: 'Project', status: state.status }, yourRole: state.role }} clusterReady request={request} close={vi.fn()} refresh={vi.fn()} lifecycle={vi.fn()} />)
    expect(request).not.toHaveBeenCalled()
    const details = screen.getByText('项目预算', { selector: 'summary' }).closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await screen.findByText('预算内')
    expect(request).toHaveBeenCalledExactlyOnceWith('/lumo/api/projects/p%2F1/budget')
    expect(Boolean(screen.queryByRole('form', { name: '预算配置' }))).toBe(state.write)
  })
})
