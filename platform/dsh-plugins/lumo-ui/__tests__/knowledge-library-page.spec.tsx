// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeSurface } from '../src/client/index.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const file = {
  docId: 'file-1', realm: 'dev', folderId: null, filename: '业务报告.txt', mimeType: 'text/plain',
  byteSize: 50, sha256: 'a'.repeat(64), ownerUserId: 'owner', extractionState: 'ready',
  ocrState: 'not_needed', createdAt: '2026-11-07T00:00:00Z', canEdit: true,
}
const folder = { folderId: 'shared', realm: 'dev', parentId: 'hidden', name: '共享业务', ownerUserId: 'another', canEdit: false }
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function mount(options: { files?: object[]; folders?: object[]; remove?: () => Promise<Response>; preview?: () => Promise<Response>; shares?: () => Promise<Response>; update?: () => Promise<Response> } = {}) {
  let files = options.files ?? [file]
  let folders = options.folders ?? []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      const result = options.update ? await options.update() : response({ state: 'saved' })
      if (result.ok) {
        if (path.includes('/files/')) files = [{ ...file, ...body, revision: 4 }]
        else folders = [{ ...folder, ...body, revision: 5 }]
      }
      return result
    }
    if (init?.method === 'DELETE') {
      const result = options.remove ? await options.remove() : response({ state: 'removed' })
      if (result.ok) {
        if (path.includes('/files/')) files = []
        else folders = []
      }
      return result
    }
    if (path.endsWith('/library/files')) return response({ files })
    if (path.endsWith('/library/folders')) return response({ folders })
    if (path.endsWith('/shares')) return options.shares ? options.shares() : response({ grants: [] })
    if (path.endsWith('/preview')) return options.preview ? options.preview() : new Response('报告正文')
    if (path.endsWith('/vault/status')) return response({ error: 'not configured' }, 501)
    if (path.endsWith('/sources')) return response({ sources: [] })
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  render(<KnowledgeSurface onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /文件资料/ }))
  return fetch
}

describe('knowledge library page lifecycle', () => {
  it('requires confirmation, sends the displayed SHA, and removes preview after deletion', async () => {
    const pending = deferred<Response>()
    const fetch = mount({ remove: () => pending.promise })
    await screen.findByText(file.filename)
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    await screen.findByText('报告正文')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    const confirmation = within(screen.getByRole('alertdialog', { name: '确认删除资料' }))
    const confirm = confirmation.getByRole('button', { name: '确认删除' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
    const deletion = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')!
    expect(deletion[0]).toBe('/lumo/api/knowledge/library/files/file-1')
    expect(JSON.parse(String(deletion[1]?.body))).toEqual({ expectedSha256: file.sha256 })
    pending.resolve(response({ state: 'removed' }))
    await screen.findByText(/文件已从资料库和检索中移除/)
    expect(screen.queryByText(file.filename)).toBeNull()
    expect(screen.queryByText('报告正文')).toBeNull()
  })

  it('keeps the file on a conflict and offers a refresh instead of claiming success', async () => {
    mount({ remove: async () => response({ error: 'stale version' }, 409) })
    await screen.findByText(file.filename)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await screen.findByText('内容已变化或目录非空，未执行删除。请刷新后重试。')
    expect(screen.getByText(file.filename)).toBeTruthy()
    expect(screen.queryByText(/文件已从资料库和检索中移除/)).toBeNull()
  })

  it('shows directly shared children of hidden folders and hides viewer management actions', async () => {
    mount({ folders: [folder], files: [{ ...file, folderId: 'hidden', canEdit: false }] })
    await screen.findByText(file.filename)
    expect(screen.getByText(/共享业务/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.queryByRole('button', { name: '分享' })).toBeNull()
    expect(screen.queryByRole('button', { name: '整理' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /共享业务/ }))
    expect(screen.queryByRole('button', { name: '创建文件夹' })).toBeNull()
    expect(screen.getByText('当前目录为只读分享，可预览和下载文件。')).toBeTruthy()
    expect(screen.queryByText('返回父文件夹')).toBeNull()
  })

  it('deletes an editable empty folder through the existing folder endpoint', async () => {
    const fetch = mount({ folders: [{ ...folder, parentId: null, canEdit: true }], files: [] })
    await screen.findByText(/共享业务/)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByText('仅允许删除空文件夹，请先移走或删除其中内容。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await screen.findByText('已删除空文件夹「共享业务」。')
    expect(fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe('/lumo/api/knowledge/library/folders/shared')
  })

  it('does not revive a closed preview when its request finishes late', async () => {
    const preview = deferred<Response>()
    mount({ preview: () => preview.promise })
    await screen.findByText(file.filename)
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭', exact: true }))
    await act(async () => { preview.resolve(new Response('不再可见的正文')) })
    expect(screen.queryByText('不再可见的正文')).toBeNull()
    await waitFor(() => expect(screen.getByText('资料预览')).toBeTruthy())
  })

  it('cannot save an empty grant list while existing shares are still loading', async () => {
    const shares = deferred<Response>()
    const fetch = mount({ shares: () => shares.promise })
    await screen.findByText(file.filename)
    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await screen.findByText('正在读取现有分享权限。')
    fireEvent.click(screen.getByRole('button', { name: '保存分享' }))
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    await act(async () => { shares.resolve(response({ grants: [{ type: 'user', id: 'reader', access: 'viewer' }] })) })
    expect(screen.getByText(/reader/)).toBeTruthy()
    expect(screen.queryByText('正在读取现有分享权限。')).toBeNull()
  })

  it('connects the file editor to rename and move, then refreshes the visible list', async () => {
    const next = { ...folder, folderId: 'destination', parentId: null, name: '目标目录', canEdit: true, revision: 1 }
    const fetch = mount({ files: [{ ...file, revision: 3 }], folders: [next] })
    await screen.findByText(file.filename)
    const row = screen.getByText(file.filename).closest('article')!
    fireEvent.click(within(row).getByRole('button', { name: '整理' }))
    const editor = within(screen.getByRole('region', { name: '整理文件' }))
    fireEvent.change(editor.getByRole('textbox', { name: '资料名称' }), { target: { value: '年度报告.txt' } })
    fireEvent.change(editor.getByRole('combobox', { name: '目标资料目录' }), { target: { value: 'destination' } })
    fireEvent.click(editor.getByRole('button', { name: '保存更改' }))
    await screen.findByText('资料名称和位置已更新。')
    expect(screen.queryByRole('region', { name: '整理文件' })).toBeNull()
    const update = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(update[0]).toBe('/lumo/api/knowledge/library/files/file-1')
    expect(JSON.parse(String(update[1]?.body))).toEqual({ expectedRevision: 3, filename: '年度报告.txt', folderId: 'destination' })
    expect(screen.queryByText('年度报告.txt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /目标目录.*文件夹/u }))
    expect(await screen.findByText('年度报告.txt')).toBeTruthy()
  })

  it('connects the folder editor and retains drafts when the server detects a conflict', async () => {
    const fetch = mount({ files: [], folders: [{ ...folder, parentId: null, canEdit: true, revision: 4 }], update: async () => response({ error: 'changed' }, 409) })
    await screen.findByText(/共享业务/u)
    fireEvent.click(screen.getByRole('button', { name: '整理' }))
    const editor = within(screen.getByRole('region', { name: '整理目录' }))
    fireEvent.change(editor.getByRole('textbox'), { target: { value: '目录草稿' } })
    fireEvent.click(editor.getByRole('button', { name: '保存更改' }))
    expect((await editor.findByRole('alert')).textContent).toContain('其他人更新')
    expect((editor.getByRole('textbox') as HTMLInputElement).value).toBe('目录草稿')
    expect((editor.getByRole('button', { name: '保存更改' }) as HTMLButtonElement).disabled).toBe(true)
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ expectedRevision: 4, name: '目录草稿' })
  })

  it('sends the displayed metadata version for file and folder deletion', async () => {
    const fetch = mount({ files: [{ ...file, revision: 3 }], folders: [{ ...folder, parentId: null, canEdit: true, revision: 4 }] })
    await screen.findByText(file.filename)
    fireEvent.click(within(screen.getByText(file.filename).closest('article')!).getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await screen.findByText(/文件已从资料库和检索中移除/u)
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[1]?.body))).toEqual({ expectedSha256: file.sha256, expectedRevision: 3 })
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await screen.findByText('已删除空文件夹「共享业务」。')
    expect(JSON.parse(String(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')[1]?.[1]?.body))).toEqual({ expectedRevision: 4 })
  })

  it('does not expose organization controls when an old provider omits revisions', async () => {
    mount()
    await screen.findByText(file.filename)
    expect(screen.queryByRole('button', { name: '整理' })).toBeNull()
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
  })
})
