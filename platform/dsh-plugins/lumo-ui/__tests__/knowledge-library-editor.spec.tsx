// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeLibraryEditor, type LibraryEditorFolder, type LibraryEditorResource } from '../src/client/knowledge-library-editor.tsx'

afterEach(cleanup)
const folders: LibraryEditorFolder[] = [
  { folderId: 'old', parentId: null, name: '原目录', canEdit: true },
  { folderId: 'next', parentId: null, name: '新目录', canEdit: true },
  { folderId: 'viewer', parentId: null, name: '只读目录', canEdit: false },
]
const file: LibraryEditorResource = { type: 'file', file: { docId: 'file-a', filename: '报告.txt', folderId: 'old', revision: 3, canEdit: true } }
function mount(extra = {}) {
  const request = vi.fn().mockResolvedValue({ file: {} })
  const onSaved = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  return { request, onSaved, onClose, ...render(<KnowledgeLibraryEditor request={request} resource={file} folders={folders} onSaved={onSaved} onClose={onClose} {...extra} />) }
}
const save = () => fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

describe('资料库整理编辑器', () => {
  it('文件重命名和移动提交读取时revision，并只展示可编辑目标', async () => {
    const f = mount()
    expect(screen.queryByRole('option', { name: '只读目录' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '资料名称' }), { target: { value: ' 年度报告.txt ' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'next' } })
    save()
    await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce())
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/lumo/api/knowledge/library/files/file-a', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 3, filename: '年度报告.txt', folderId: 'next' }) })
    expect(f.onSaved).toHaveBeenCalledOnce()
  })

  it('目录不能选择自身或可见子树，并可移回根目录', async () => {
    const resource: LibraryEditorResource = { type: 'folder', folder: { folderId: 'old', name: '原目录', parentId: 'next', revision: 1, canEdit: true } }
    const f = mount({ resource, folders: [...folders, { folderId: 'child', name: '子目录', parentId: 'old', canEdit: true }] })
    expect(screen.queryByRole('option', { name: '新目录 / 原目录' })).toBeNull()
    expect(screen.queryByRole('option', { name: /子目录/u })).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    save()
    await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce())
    expect(f.request).toHaveBeenCalledWith('/lumo/api/knowledge/library/folders/old', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, parentId: null }) })
  })

  it('只读权限或缺版本时不给可执行编辑表单', () => {
    const f = mount({ resource: { type: 'file', file: { ...file.file, canEdit: false } } })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(f.request).not.toHaveBeenCalled()
  })

  it('保存冲突保留草稿并阻止基于旧版本再次写入', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('stale'), { status: 409 }))
    const f = mount({ request })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿.txt' } })
    save()
    expect((await screen.findByRole('alert')).textContent).toContain('其他人更新')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('草稿.txt')
    expect((screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement).disabled).toBe(true)
    expect(f.onClose).not.toHaveBeenCalled()
  })

  it('重复提交只写一次；保存后的刷新重试只刷新列表', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const onSaved = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined)
    const f = mount({ request, onSaved })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '更新.txt' } })
    save()
    fireEvent.submit(screen.getByRole('textbox').closest('form')!)
    expect(request).toHaveBeenCalledOnce()
    finish({ file: {} })
    expect((await screen.findByRole('alert')).textContent).toBe('已保存，刷新失败：offline')
    expect(screen.getByRole('status').textContent).toBe('更改已保存。')
    fireEvent.click(screen.getByRole('button', { name: '重新加载列表' }))
    await waitFor(() => expect(f.onClose).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledOnce()
    expect(onSaved).toHaveBeenCalledTimes(2)
  })
})
