// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeSurface } from '../src/client/index.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const first = { docId: 'policy-a', realm: 'dev', space: 'operations', title: '运维制度', sourceVersion: 3, embeddingModel: 'embed-local', chunkCount: 1, updatedAt: '2026-11-08T00:00:00Z' }
const second = { ...first, docId: 'policy-b', space: 'finance', title: '财务制度', sourceVersion: 5 }
function source(summary = first) {
  return { doc: summary, chunks: [{ text: `${summary.title}原文`, metadata: { heading: '正文' } }] }
}
function result(text = '命中运维制度', docId = first.docId) {
  return { query: '审批规则', scope: 'published', hits: [{ docId, sourceVersion: 3, score: 0.8, text }] }
}
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function settled() { await act(async () => {}) }
function mount(override: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined, vault = false) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const custom = override(path, init)
    if (custom !== undefined) return custom
    if (path.endsWith('/library/files')) return response({ files: [] })
    if (path.endsWith('/library/folders')) return response({ folders: [] })
    if (path.endsWith('/vault/status')) return vault ? response({ vaultPath: '/example-vault', mode: 'keyword', docCount: 2, chunkCount: 2, lastSyncAt: null, error: null }) : response({ error: 'not configured' }, 501)
    if (path.endsWith('/sources') && !init?.method) return response({ realm: 'dev', state: 'synchronized', sources: [first, second] })
    if (path.endsWith(`/sources/${first.docId}`) && !init?.method) return response({ source: source(first) })
    if (path.endsWith(`/sources/${second.docId}`) && !init?.method) return response({ source: source(second) })
    if (path.endsWith('/query')) return response(result())
    throw Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  const view = render(<KnowledgeSurface onClose={vi.fn()} />)
  return { fetch, view }
}
function area(name: string) { fireEvent.click(screen.getByRole('button', { name: new RegExp(name) })) }
function editButton(title = first.title) { return within(screen.getByText(title).closest('div')!).getByRole('button', { name: '查看 / 编辑' }) }
async function openEditor(title = first.title) {
  area('来源内容')
  await screen.findByText(title)
  fireEvent.click(editButton(title))
  await waitFor(() => expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(title))
}
function submitQuery() {
  fireEvent.change(screen.getByRole('textbox', { name: '向知识空间提问' }), { target: { value: '审批规则' } })
  fireEvent.click(screen.getByRole('button', { name: '检索知识' }))
}
function writes(fetch: ReturnType<typeof mount>['fetch']) { return fetch.mock.calls.filter(([, init]) => ['PUT', 'DELETE'].includes(init?.method ?? '')) }

describe('knowledge coordination and versioned source edits', () => {
  it('sends the selected space to search and omits narrowing for all spaces', async () => {
    const { fetch } = mount()
    await screen.findByRole('button', { name: 'operations', exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'operations', exact: true }))
    submitQuery()
    await screen.findByText('命中运维制度')
    expect(JSON.parse(String(fetch.mock.calls.find(([path]) => String(path).endsWith('/query'))?.[1]?.body))).toEqual({ text: '审批规则', topK: 8, spaces: ['operations'] })
    fireEvent.click(screen.getByRole('button', { name: '全部空间' }))
    expect(screen.queryByText('命中运维制度')).toBeNull()
    submitQuery()
    await screen.findByText('命中运维制度')
    expect(JSON.parse(String(fetch.mock.calls.filter(([path]) => String(path).endsWith('/query')).at(-1)?.[1]?.body))).toEqual({ text: '审批规则', topK: 8 })
  })

  it('discards a late query after the user changes spaces', async () => {
    const old = deferred<Response>()
    let reads = 0
    mount(path => path.endsWith('/query') ? ++reads === 1 ? old.promise : response(result('财务查询结果', second.docId)) : undefined)
    await screen.findByRole('button', { name: 'operations', exact: true })
    fireEvent.click(screen.getByRole('button', { name: 'operations', exact: true }))
    submitQuery()
    fireEvent.click(screen.getByRole('button', { name: 'finance', exact: true }))
    expect((screen.getByRole('button', { name: '检索知识' }) as HTMLButtonElement).disabled).toBe(false)
    submitQuery()
    await screen.findByText('财务查询结果')
    await act(async () => { old.resolve(response(result('过期的运维结果'))) })
    expect(screen.queryByText('过期的运维结果')).toBeNull()
    expect(screen.getByText('财务查询结果')).toBeTruthy()
  })

  it('allows searching again after deleting a file while an earlier query is pending', async () => {
    const old = deferred<Response>()
    let queries = 0
    let deleted = false
    const file = { docId: 'uploaded-file', realm: 'dev', folderId: null, filename: '待删除资料.txt', mimeType: 'text/plain', byteSize: 12, sha256: 'a'.repeat(64), ownerUserId: 'owner', extractionState: 'ready', ocrState: 'not_needed', createdAt: '2026-11-08T00:00:00Z', canEdit: true }
    const { fetch } = mount((path, init) => {
      if (path.endsWith('/query')) return ++queries === 1 ? old.promise : response(result('删除后重新检索成功'))
      if (path.endsWith('/library/files') && !init?.method) return response({ files: deleted ? [] : [file] })
      if (path.endsWith('/library/files/uploaded-file') && init?.method === 'DELETE') { deleted = true; return response({ state: 'removed' }) }
      return undefined
    })
    await screen.findByRole('button', { name: 'operations', exact: true })
    submitQuery()
    area('文件资料')
    await screen.findByText(file.filename)
    fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除', exact: true }))
    await screen.findByText(/文件已从资料库和检索中移除/)
    area('查找资料')
    submitQuery()
    await screen.findByText('删除后重新检索成功')
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith('/query'))).toHaveLength(2)
    await act(async () => { old.resolve(response(result('已失效的文件查询', file.docId))) })
    expect(screen.queryByText('已失效的文件查询')).toBeNull()
    expect(screen.getByText('删除后重新检索成功')).toBeTruthy()
  })

  it('clears source details on space change and discards their late response', async () => {
    const detail = deferred<Response>()
    mount(path => path.endsWith(`/sources/${first.docId}`) ? detail.promise : path.endsWith('/query') ? response(result()) : undefined)
    await screen.findByRole('button', { name: 'operations', exact: true })
    submitQuery()
    await screen.findByText('命中运维制度')
    fireEvent.click(screen.getByRole('button', { name: /查看来源详情/ }))
    fireEvent.click(screen.getByRole('button', { name: 'finance', exact: true }))
    expect(screen.queryByText('命中运维制度')).toBeNull()
    await act(async () => { detail.resolve(response({ source: source() })) })
    submitQuery()
    await screen.findByText('命中运维制度')
    expect(screen.queryByText('运维制度原文')).toBeNull()
    expect(screen.queryByText('正在读取来源全文。')).toBeNull()
  })

  it('clears the previous source detail when another hit is selected and ignores a late detail read', async () => {
    const late = deferred<Response>()
    let details = 0
    mount(path => path.endsWith('/query') ? response({ ...result(), hits: [...result().hits, ...result('财务制度片段', second.docId).hits] })
      : path.endsWith(`/sources/${first.docId}`) ? ++details === 1 ? response({ source: source() }) : late.promise : undefined)
    await screen.findByRole('button', { name: 'operations', exact: true })
    submitQuery()
    await screen.findByText('财务制度片段')
    const detailsButton = within(screen.getByText('命中运维制度').closest('.lumo-hit')!).getByRole('button', { name: /查看来源详情/ })
    fireEvent.click(detailsButton)
    await screen.findByText('运维制度原文')
    fireEvent.click(screen.getByText('财务制度片段'))
    expect(screen.queryByText('运维制度原文')).toBeNull()
    expect(screen.getByRole('heading', { name: second.docId })).toBeTruthy()
    fireEvent.click(detailsButton)
    expect(screen.getByText('正在读取来源全文。')).toBeTruthy()
    fireEvent.click(screen.getByText('财务制度片段'))
    await act(async () => { late.resolve(response({ source: source() })) })
    expect(screen.queryByText('运维制度原文')).toBeNull()
    expect(screen.queryByText('正在读取来源全文。')).toBeNull()
    expect(screen.getByRole('heading', { name: second.docId })).toBeTruthy()
  })

  it('keeps the latest selected source when an earlier edit read completes late', async () => {
    const old = deferred<Response>()
    mount((path, init) => !init?.method && path.endsWith(`/sources/${first.docId}`) ? old.promise : undefined)
    area('来源内容')
    await screen.findByText(first.title)
    fireEvent.click(editButton(first.title))
    fireEvent.click(editButton(second.title))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(second.title))
    await act(async () => { old.resolve(response({ source: source() })) })
    expect((screen.getByRole('textbox', { name: '知识来源 ID' }) as HTMLInputElement).value).toBe(second.docId)
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(second.title)
  })

  it('does not replace a new source draft with a late edit read', async () => {
    const old = deferred<Response>()
    mount((path, init) => !init?.method && path.endsWith(`/sources/${first.docId}`) ? old.promise : undefined)
    area('来源内容')
    await screen.findByText(first.title)
    fireEvent.click(editButton())
    fireEvent.click(screen.getByRole('button', { name: '新建来源' }))
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '待登记草稿' } })
    await act(async () => { old.resolve(response({ source: source() })) })
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe('待登记草稿')
    expect((screen.getByRole('textbox', { name: '知识来源 ID' }) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: '登记来源' })).toBeTruthy()
  })

  it('freezes edits and serializes saves with source selection and index rebuild', async () => {
    const saved = deferred<Response>()
    const { fetch } = mount((_path, init) => init?.method === 'PUT' ? saved.promise : undefined)
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '运维制度新标题' } })
    const form = screen.getByRole('textbox', { name: '知识来源标题' }).closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    expect(writes(fetch)).toHaveLength(1)
    for (const name of ['知识空间', '知识来源标题', '来源分片 JSON']) expect(screen.getByRole('textbox', { name }).matches(':disabled')).toBe(true)
    expect((screen.getByRole('button', { name: '新建来源' }) as HTMLButtonElement).disabled).toBe(true)
    expect((editButton(second.title) as HTMLButtonElement).disabled).toBe(true)
    area('索引运营')
    expect((screen.getByRole('button', { name: '重建当前 Realm' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重建当前 Realm' }))
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/rebuild'))).toBe(false)
    await act(async () => { saved.resolve(response({ source: { ...first, title: '运维制度新标题', sourceVersion: 4 } })) })
    area('来源内容')
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe('运维制度新标题')
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(false)
  })

  it('blocks source writes while a rebuild is pending', async () => {
    const pending = deferred<Response>()
    const { fetch } = mount(path => path.endsWith('/rebuild') ? pending.promise : undefined)
    await openEditor()
    area('索引运营')
    const rebuild = screen.getByRole('button', { name: '重建当前 Realm' })
    fireEvent.click(rebuild); fireEvent.click(rebuild)
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith('/rebuild'))).toHaveLength(1)
    area('来源内容')
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(true)
    expect((editButton(second.title) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('textbox', { name: '知识来源标题' }).closest('form')!)
    expect(writes(fetch)).toHaveLength(0)
    await act(async () => { pending.resolve(response({ state: 'rebuilt' })) })
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(false)
  })

  it('serializes vault synchronization and blocks source selection until it finishes', async () => {
    const pending = deferred<Response>()
    const { fetch } = mount(path => path.endsWith('/vault/sync') ? pending.promise : undefined, true)
    await screen.findByRole('button', { name: 'operations', exact: true })
    area('索引运营')
    const sync = screen.getByRole('button', { name: '同步 vault' })
    fireEvent.click(sync); fireEvent.click(sync)
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith('/vault/sync'))).toHaveLength(1)
    area('来源内容')
    for (const button of screen.getAllByRole('button', { name: '查看详情' })) expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { pending.resolve(response({ docs: 2 })) })
    for (const button of screen.getAllByRole('button', { name: '查看详情' })) expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the requested vault source text in the sources area', async () => {
    mount(() => undefined, true)
    area('来源内容')
    await screen.findByText(first.title)
    fireEvent.click(within(screen.getByText(first.title).closest('div')!).getByRole('button', { name: '查看详情' }))
    const preview = within(await screen.findByRole('region', { name: '来源全文预览' }))
    expect(await preview.findByText('运维制度原文')).toBeTruthy()
    expect(preview.getByRole('heading', { name: first.title })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '向知识空间提问' })).toBeNull()
  })

  it('shows denied source detail reads in the current vault sources area', async () => {
    mount(path => path.endsWith(`/sources/${first.docId}`) ? response({ error: 'source access revoked' }, 403) : undefined, true)
    area('来源内容')
    await screen.findByText(first.title)
    fireEvent.click(within(screen.getByText(first.title).closest('div')!).getByRole('button', { name: '查看详情' }))
    expect(await screen.findByText('source access revoked')).toBeTruthy()
    expect(screen.queryByText('运维制度原文')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '向知识空间提问' })).toBeNull()
  })

  it('preserves a conflicted draft and requires rereading before a new version can be saved', async () => {
    let current = first
    let attempts = 0
    const { fetch } = mount((path, init) => {
      if (init?.method === 'PUT') return ++attempts === 1 ? response({ error: 'changed' }, 409) : response({ source: { ...current, sourceVersion: current.sourceVersion + 1 } })
      if (!init?.method && path.endsWith(`/sources/${first.docId}`)) return response({ source: source(current) })
      return undefined
    })
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '冲突时保留的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/来源已被其他人更新/)
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe('冲突时保留的草稿')
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(true)
    fireEvent.submit(screen.getByRole('textbox', { name: '知识来源标题' }).closest('form')!)
    expect(writes(fetch)).toHaveLength(1)
    current = { ...first, title: '服务端新版本', sourceVersion: 7 }
    fireEvent.click(editButton())
    await waitFor(() => expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(current.title))
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await settled()
    expect(JSON.parse(String(writes(fetch).at(-1)?.[1]?.body)).expectedSourceVersion).toBe(7)
    expect(screen.getByText(/已保存 policy-a 的 v8/)).toBeTruthy()
  })

  it('requires explicit deletion confirmation and submits the confirmed version only once', async () => {
    const pending = deferred<Response>()
    const { fetch } = mount((_path, init) => init?.method === 'DELETE' ? pending.promise : undefined)
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: '删除来源' }))
    expect(writes(fetch)).toHaveLength(0)
    const confirmation = screen.getByRole('button', { name: /确认删除/ })
    fireEvent.click(confirmation); fireEvent.click(confirmation)
    expect(writes(fetch)).toHaveLength(1)
    expect(writes(fetch)[0]?.[0]).toBe('/lumo/api/knowledge/sources/policy-a')
    expect(JSON.parse(String(writes(fetch)[0]?.[1]?.body))).toEqual({ expectedSourceVersion: 3 })
    expect((editButton(second.title) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { pending.resolve(response({ docId: first.docId, state: 'removed' })) })
    expect(screen.getByText(/已删除 policy-a/)).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '知识来源 ID' }) as HTMLInputElement).value).toBe('')
  })

  it.each([
    { ...first, docId: 'unrelated-source', sourceVersion: 4 },
    { ...first, sourceVersion: 3 },
    { ...first, sourceVersion: 4.5 },
    { ...first, sourceVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])('locks further writes after a malformed successful save receipt: %j', async receipt => {
    const { fetch } = mount((_path, init) => init?.method === 'PUT' ? response({ source: receipt }) : undefined)
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '未确认的保存草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/保存回执无效/)
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe('未确认的保存草稿')
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(true)
    expect((screen.getByRole('button', { name: '删除来源' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('textbox', { name: '知识来源标题' }).closest('form')!)
    expect(writes(fetch)).toHaveLength(1)
    fireEvent.click(editButton())
    await waitFor(() => expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(first.title))
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(false)
  })

  it.each([
    ['a null success body', () => response(null)],
    ['an empty 204 success body', () => new Response(null, { status: 204 })],
    ['a network failure', () => { throw Error('connection lost') }],
    ['a server failure', () => response({ error: 'temporarily unavailable' }, 503)],
  ] as const)('preserves the draft and requires rereading after an uncertain save with %s', async (_label, outcome) => {
    const { fetch } = mount((_path, init) => init?.method === 'PUT' ? outcome() : undefined)
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '结果未知时保留的草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(true))
    await settled()
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe('结果未知时保留的草稿')
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '删除来源' }).matches(':disabled')).toBe(true)
    expect(screen.queryByText(/已保存 policy-a/)).toBeNull()
    fireEvent.submit(screen.getByRole('textbox', { name: '知识来源标题' }).closest('form')!)
    expect(writes(fetch)).toHaveLength(1)
    fireEvent.click(editButton())
    await waitFor(() => expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(first.title))
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(false)
  })

  it('allows correcting invalid local source chunks before retrying without rereading', async () => {
    const { fetch } = mount((_path, init) => init?.method === 'PUT' ? response({ source: { ...first, sourceVersion: 4 } }) : undefined)
    await openEditor()
    const chunks = screen.getByRole('textbox', { name: '来源分片 JSON' })
    fireEvent.change(chunks, { target: { value: '{invalid' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await settled()
    expect(writes(fetch)).toHaveLength(0)
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(false)
    fireEvent.change(chunks, { target: { value: JSON.stringify(source().chunks) } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/已保存 policy-a 的 v4/)
    expect(writes(fetch)).toHaveLength(1)
  })

  it('allows correcting a source rejected with a definite 400 without rereading', async () => {
    let attempts = 0
    const { fetch } = mount((_path, init) => init?.method === 'PUT' ? ++attempts === 1 ? response({ error: 'invalid source title' }, 400) : response({ source: { ...first, sourceVersion: 4 } }) : undefined)
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText('invalid source title')
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '修正后的标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新版本' }))
    await screen.findByText(/已保存 policy-a 的 v4/)
    expect(writes(fetch)).toHaveLength(2)
  })

  it.each([
    { docId: 'unrelated-source', state: 'removed' },
    null,
    { docId: first.docId, state: 'pending' },
  ])('preserves the source and locks writes until reread after invalid deletion receipt %j', async receipt => {
    const { fetch } = mount((_path, init) => init?.method === 'DELETE' ? response(receipt) : undefined)
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: '知识来源标题' }), { target: { value: '删除未确认时保留草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '删除来源' }))
    fireEvent.click(screen.getByRole('button', { name: /确认删除/ }))
    await settled()
    expect((screen.getByRole('textbox', { name: '知识来源 ID' }) as HTMLInputElement).value).toBe(first.docId)
    expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe('删除未确认时保留草稿')
    expect(screen.queryByText(/已删除 policy-a/)).toBeNull()
    expect(screen.getByRole('button', { name: '保存新版本' }).matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '删除来源' }).matches(':disabled')).toBe(true)
    fireEvent.submit(screen.getByRole('textbox', { name: '知识来源标题' }).closest('form')!)
    expect(writes(fetch)).toHaveLength(1)
    fireEvent.click(editButton())
    await waitFor(() => expect((screen.getByRole('textbox', { name: '知识来源标题' }) as HTMLInputElement).value).toBe(first.title))
    expect(screen.getByRole('button', { name: '删除来源' }).matches(':disabled')).toBe(false)
  })
})
