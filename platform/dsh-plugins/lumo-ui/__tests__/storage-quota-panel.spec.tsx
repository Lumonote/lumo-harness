// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageQuotaPanel } from '../src/client/storage-quota-panel.tsx'

afterEach(cleanup)
const MIB = 1024 * 1024
const response = (extra = {}) => ({ quota: { scope: 'realm', project_id: '', limit_bytes: 2 * MIB, used_bytes: MIB, revision: 3, by_kind: { 'knowledge-file': MIB }, ...extra }, accounting: 'retained-logical-reference-bytes', coverage: [], excluded: [], physical_gc_authorized: false })
const mount = (request = vi.fn().mockResolvedValue(response())) => ({ request, ...render(<StorageQuotaPanel request={request} />) })
const draft = (value: string) => fireEvent.change(screen.getByRole('spinbutton', { name: '存储上限（MiB）' }), { target: { value } })
const submit = () => fireEvent.submit(screen.getByRole('form', { name: '配置存储配额' }))
const chooseProject = (id: string) => {
  fireEvent.change(screen.getByRole('combobox', { name: '配额范围' }), { target: { value: 'project' } })
  fireEvent.change(screen.getByRole('textbox', { name: '项目 ID' }), { target: { value: id } })
  fireEvent.click(screen.getByRole('button', { name: '读取项目配额' }))
}

describe('storage quota management', () => {
  it('shows logical scope and submits exact MiB bytes with current revision', async () => {
    const f = mount()
    await screen.findByRole('form', { name: '配置存储配额' })
    expect(screen.getByText(/会话日志、Spill、备份及未登记的历史对象/)).toBeDefined()
    expect(screen.getByText('资料库文件')).toBeDefined()
    draft('5'); submit()
    await screen.findByText('配额已保存，已有文件与引用保持保留。')
    expect(f.request).toHaveBeenLastCalledWith('/lumo/api/storage/quota', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expected_revision: 3, limit_bytes: 5 * MIB }) }))
  })

  it('preserves zero and explicitly selected unlimited as different values', async () => {
    const f = mount()
    await screen.findByRole('form', { name: '配置存储配额' })
    draft('0'); submit()
    await screen.findByText('配额已保存，已有文件与引用保持保留。')
    expect(JSON.parse(f.request.mock.calls[1]![1].body).limit_bytes).toBe(0)
    fireEvent.click(screen.getByRole('checkbox', { name: '不限额' })); submit()
    await waitFor(() => expect(f.request).toHaveBeenCalledTimes(3))
    expect(JSON.parse(f.request.mock.calls[2]![1].body).limit_bytes).toBeNull()
  })

  it.each(['', '-1', '1.5', '9007199254740992'])('rejects invalid or inexact MiB %s before writing', async value => {
    const f = mount()
    await screen.findByRole('form', { name: '配置存储配额' }); draft(value); submit()
    expect((await screen.findByRole('alert')).textContent).toContain('非负整数 MiB')
    expect(f.request).toHaveBeenCalledOnce()
  })

  it('preserves draft after conflict, reads a new baseline and requires manual resubmission', async () => {
    const request = vi.fn().mockResolvedValueOnce(response())
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }))
      .mockResolvedValueOnce(response({ revision: 4, limit_bytes: 6 * MIB }))
      .mockResolvedValueOnce(response({ revision: 5, limit_bytes: 5 * MIB }))
    mount(request)
    await screen.findByRole('form', { name: '配置存储配额' }); draft('5'); submit()
    expect((await screen.findByRole('alert')).textContent).toContain('保存冲突')
    expect((screen.getByRole('button', { name: '保存存储配额' }) as HTMLButtonElement).disabled).toBe(true)
    submit(); expect(request).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '读取最新配额（保留草稿）' }))
    await screen.findByText('已读取最新配额，草稿仍保留。请核对后再次保存，或采用已保存的配额。')
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('5')
    expect(request).toHaveBeenCalledTimes(3)
    submit(); await screen.findByText('配额已保存，已有文件与引用保持保留。')
    expect(JSON.parse(request.mock.calls[3]![1].body)).toEqual({ expected_revision: 4, limit_bytes: 5 * MIB })
  })

  it('keeps drafts on reread and can explicitly adopt the current value', async () => {
    const request = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ revision: 4, limit_bytes: null }))
    mount(request)
    await screen.findByRole('form', { name: '配置存储配额' }); draft('7')
    fireEvent.click(screen.getByRole('button', { name: '读取最新配额（保留草稿）' }))
    await screen.findByText('已读取最新配额，草稿仍保留。请核对后再次保存，或采用已保存的配额。')
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('7')
    fireEvent.click(screen.getByRole('button', { name: '采用已保存的配额' }))
    expect((screen.getByRole('checkbox', { name: '不限额' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('aborts and ignores old scope reads, and encodes project identity', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ scope: 'project', project_id: 'p/中文', limit_bytes: null, by_kind: {} }))
    mount(request)
    chooseProject(' p/中文 ')
    expect(request.mock.calls[0]![1].signal.aborted).toBe(true)
    await screen.findByText('项目 p/中文的配额')
    await screen.findByRole('form', { name: '配置存储配额' })
    expect(request.mock.calls[1]![0]).toBe('/lumo/api/storage/quota?project_id=p%2F%E4%B8%AD%E6%96%87')
    finish(response({ limit_bytes: 9 * MIB }))
    await waitFor(() => expect(screen.queryByRole('spinbutton')).toBeNull())
    expect(screen.getByText('当前范围暂无已登记的活动引用。')).toBeDefined()
  })

  it('rejects response for a different scope and permits a retry', async () => {
    const request = vi.fn().mockResolvedValueOnce(response({ scope: 'project', project_id: 'foreign' })).mockResolvedValueOnce(response())
    mount(request)
    expect((await screen.findByRole('alert')).textContent).toContain('当前范围不符')
    expect(screen.queryByRole('form', { name: '配置存储配额' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '读取最新配额（保留草稿）' }))
    await screen.findByRole('form', { name: '配置存储配额' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('never rounds a non-MiB current limit into a new saved limit', async () => {
    const f = mount(vi.fn().mockResolvedValue(response({ limit_bytes: 7 })))
    await screen.findByRole('form', { name: '配置存储配额' })
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('当前上限不是整数 MiB。保存新上限前，请输入整数 MiB，或选择不限额。')).toBeDefined()
    submit(); await screen.findByRole('alert')
    expect(f.request).toHaveBeenCalledOnce()
  })

  it('deduplicates writes and ignores a late save after switching scope', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mount(request)
    await screen.findByRole('form', { name: '配置存储配额' }); draft('4'); submit(); submit()
    expect(request).toHaveBeenCalledTimes(2)
    fireEvent.change(screen.getByRole('combobox', { name: '配额范围' }), { target: { value: 'project' } })
    expect(request.mock.calls[1]![1].signal.aborted).toBe(true)
    finish(response({ revision: 4, limit_bytes: 4 * MIB }))
    await waitFor(() => expect(screen.queryByText('配额已保存，已有文件与引用保持保留。')).toBeNull())
    expect(screen.queryByRole('form', { name: '配置存储配额' })).toBeNull()
  })
})
