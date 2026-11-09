// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ownedChatHtml, ownedChatScript } from '../src/owned-chat.ts'
const ids = [`session-${'a'.repeat(32)}`, `session-${'b'.repeat(32)}`]
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const receipt = { receipt_id: `att_${'a'.repeat(48)}`, name: 'ready.txt', bytes: 5 }
const models = { choices: [{ id: 'fast', label: '快速' }, { id: 'deep', label: '深入' }], selected_choice_id: 'fast', can_select: true, selection_revision: 1, policy_digest: 'digest', attachment_policy: { max_upload_bytes: 10000, max_per_message: 4 } }
type Intercept = (url: string, init: RequestInit, action: string, body: Record<string, unknown>) => Promise<Response> | undefined
function mount(intercept?: Intercept, owners = ids) {
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const action = url.split('/').at(-1)!, body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const overridden = intercept?.(url, init, action, body)
    if (overridden) return overridden
    if (action === 'wait') return new Promise<Response>(() => {})
    if (action === 'list') return Promise.resolve(new Response(JSON.stringify({ owners: owners.map(session_ref => ({ session_ref, created_at: '2026-11-07' })), next_cursor: '' })))
    if (action === 'models') return Promise.resolve(new Response(JSON.stringify(models)))
    if (action === 'events') return Promise.resolve(new Response('{"events":[]}'))
    if (action === 'interactionList') return Promise.resolve(new Response('{"questions":[]}'))
    return Promise.resolve(new Response('{"accepted":true}'))
  })
  vi.stubGlobal('fetch', fetcher)
  document.body.innerHTML = ownedChatHtml; Function(ownedChatScript)()
  const open = async (index = 0) => {
    await waitFor(() => expect(document.querySelectorAll('#sessions button').length).toBe(owners.length))
    fireEvent.click(document.querySelectorAll('#sessions button')[index]!)
    await waitFor(() => expect(byId<HTMLSelectElement>('model-choice').disabled).toBe(false))
  }
  return { fetcher, open }
}
afterEach(() => { window.dispatchEvent(new Event('pagehide')); document.body.replaceChildren(); vi.unstubAllGlobals() })
it.each([[507,'storage_quota_exceeded','项目存储配额已用尽'],[429,'session_attachment_busy','建议等待 7 秒'],[415,'session_attachment_unsupported','文件类型或编码不受支持']] as const)('shows useful safe upload feedback for %s', async (httpStatus,code,message) => {
  const f=mount(url=>url.startsWith('/lumo/session-attachments/')?Promise.resolve(new Response(JSON.stringify({error:code,message:'service-secret private storage'}),{status:httpStatus,headers:{'retry-after':'7'}})):undefined)
  await f.open();fireEvent.change(byId('attachment-files'),{target:{files:[new File(['safe'],'notes.txt')]}})
  await waitFor(()=>expect(byId('status').textContent).toContain(message));expect(byId('status').textContent).not.toMatch(/service-secret|private/u)
  expect(byId<HTMLInputElement>('attachment-files').disabled).toBe(false)
})
it('provides clear empty states and a list retry after a failed read', async () => {
  let failed = true
  mount((_url, _init, action) => action === 'list' && failed ? Promise.reject(Error('network offline')) : undefined, [])
  await screen.findByText('network offline')
  expect(byId<HTMLButtonElement>('send').disabled).toBe(true)
  failed = false; fireEvent.click(byId('refresh-list'))
  await waitFor(() => expect(byId('sessions-empty').hidden).toBe(false))
  expect(byId('history').textContent).toContain('选择左侧会话')
})
it('cancels an upload and keeps already completed attachments available', async () => {
  let uploads = 0, activeSignal: AbortSignal | undefined
  const f = mount((url, init) => {
    if (!url.startsWith('/lumo/session-attachments/')) return
    if (++uploads === 1) return Promise.resolve(new Response(JSON.stringify(receipt)))
    activeSignal = init.signal as AbortSignal
    return new Promise<Response>((_resolve, reject) => activeSignal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
  })
  await f.open()
  expect(byId('history').textContent).toContain('还没有消息')
  fireEvent.change(byId('attachment-files'), { target: { files: [new File(['ready'], 'ready.txt'), new File(['pending'], 'pending.txt')] } })
  await waitFor(() => expect(uploads).toBe(2))
  fireEvent.click(byId('cancel-upload'))
  await screen.findByText('已取消上传，已就绪的附件仍保留。')
  expect(activeSignal!.aborted).toBe(true)
  expect(byId('attachments').textContent).toContain('ready.txt')
  expect(byId<HTMLButtonElement>('send').disabled).toBe(false)
  fireEvent.submit(byId('prompt'))
  await waitFor(() => expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/prompt'))).toBe(true))
  const body = JSON.parse(String(f.fetcher.mock.calls.find(([url]) => url.endsWith('/prompt'))![1].body))
  expect(body.content).toEqual([{ type: 'text', text: '' }, { type: 'attachment', receipt_id: receipt.receipt_id }])
})
it('aborts old uploads and polling on session switch and ignores a late upload response', async () => {
  let finish!: (value: Response) => void, uploadSignal: AbortSignal | undefined, waitSignal: AbortSignal | undefined
  const f = mount((url, init, action, body) => {
    if (url.startsWith('/lumo/session-attachments/')) { uploadSignal = init.signal as AbortSignal; return new Promise(resolve => { finish = resolve }) }
    if (action === 'wait' && body.sessionId === ids[0]) { expect(body.timeoutMs).toBe(2000); waitSignal = init.signal as AbortSignal }
  })
  await f.open()
  await waitFor(() => expect(waitSignal).toBeDefined())
  fireEvent.change(byId('attachment-files'), { target: { files: [new File(['pending'], 'pending.txt')] } })
  await waitFor(() => expect(uploadSignal).toBeDefined())
  await f.open(1)
  expect(waitSignal!.aborted).toBe(true); expect(uploadSignal!.aborted).toBe(true)
  finish(new Response(JSON.stringify(receipt)))
  await Promise.resolve(); await Promise.resolve()
  expect(byId('attachments').childElementCount).toBe(0)
  expect(byId('status').textContent).not.toContain('附件已就绪')
  expect(byId<HTMLInputElement>('attachment-files').disabled).toBe(false)
})
it('does not clear a new session draft when an old prompt completes late', async () => {
  let finish!: (value: Response) => void
  const f = mount((_url, _init, action) => action === 'prompt' ? new Promise(resolve => { finish = resolve }) : undefined)
  await f.open(); fireEvent.change(byId('text'), { target: { value: 'first request' } }); fireEvent.submit(byId('prompt'))
  await waitFor(() => expect(finish).toBeDefined())
  await f.open(1); fireEvent.change(byId('text'), { target: { value: 'new private draft' } })
  finish(new Response('{"accepted":true}')); await Promise.resolve(); await Promise.resolve()
  expect(byId<HTMLTextAreaElement>('text').value).toBe('new private draft')
  expect(byId('status').textContent).not.toBe('已发送')
})
it('keeps model drafts on background refresh and explains a selection conflict', async () => {
  let conflict = false
  const f = mount((_url, _init, action) => {
    if (action === 'selectModel') { conflict = true; return Promise.resolve(new Response('{"error":"session_model_changed"}', { status: 409 })) }
    if (action === 'models' && conflict) return Promise.resolve(new Response(JSON.stringify({ ...models, selection_revision: 2 })))
  })
  await f.open(); fireEvent.change(byId('model-choice'), { target: { value: 'deep' } }); fireEvent.click(byId('apply-model'))
  await waitFor(() => expect(byId('status').textContent).toContain('模型选择已变化'))
  await waitFor(() => expect(byId<HTMLSelectElement>('model-choice').disabled).toBe(false))
  expect(byId<HTMLSelectElement>('model-choice').value).toBe('deep')
})
it('explains expired approval without submitting a decision', async () => {
  const f = mount((_url, _init, action) => action === 'interactionList' ? Promise.resolve(new Response(JSON.stringify({ questions: [{ questionId: 'q', receiptId: 'r', digest: 'd', revision: 1, expiresAt: '2000-01-01', questions: [{ question: 'Create one?', detail: 'exact payload' }] }] }))) : undefined)
  await f.open()
  await screen.findByText('审批已过期，无法执行；请重新读取操作状态。')
  const approve = screen.getByRole('button', { name: '确认并执行一次' }) as HTMLButtonElement
  expect(approve.disabled).toBe(true); fireEvent.click(approve)
  expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/interactionAnswer'))).toBe(false)
})
it('preserves the composer across a failed reread and a successful retry', async () => {
  let offline = false
  const f = mount((_url, _init, action) => action === 'events' && offline ? Promise.reject(Error('events offline')) : undefined)
  await f.open(); fireEvent.change(byId('text'), { target: { value: 'keep this unsent text' } })
  offline = true; fireEvent.click(byId('reload'))
  await screen.findByText('events offline')
  expect(byId('history').textContent).toContain('会话读取未完成')
  expect(byId<HTMLTextAreaElement>('text').value).toBe('keep this unsent text')
  offline = false; fireEvent.click(byId('reload'))
  await waitFor(() => expect(byId('history').textContent).toContain('还没有消息'))
  expect(byId<HTMLTextAreaElement>('text').value).toBe('keep this unsent text')
})
it('deduplicates long list pagination requests and repeated session entries', async () => {
  let complete!: (value: Response) => void
  const f = mount((_url, _init, action, body) => {
    if (action !== 'list') return
    if (!body.after) return Promise.resolve(new Response(JSON.stringify({ owners: [{ session_ref: ids[0], created_at: '2026-11-07' }], next_cursor: 'next' })))
    return new Promise(resolve => { complete = resolve })
  })
  await waitFor(() => expect(byId('more').hidden).toBe(false))
  fireEvent.click(byId('more')); fireEvent.click(byId('more'))
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/list'))).toHaveLength(2)
  complete(new Response(JSON.stringify({ owners: ids.map(session_ref => ({ session_ref, created_at: '2026-11-07' })), next_cursor: '' })))
  await waitFor(() => expect(document.querySelectorAll('#sessions button')).toHaveLength(2))
  expect(byId('more').hidden).toBe(true)
})
it('reports an interrupted approval answer as uncertain rather than completed', async () => {
  let pending = true
  const f = mount((_url, _init, action) => {
    if (action === 'interactionList') return Promise.resolve(new Response(JSON.stringify({ questions: pending ? [{ questionId: 'q', receiptId: 'r', digest: 'd', revision: 1, expiresAt: '2099-01-01', questions: [{ question: 'Create one?', detail: 'exact payload' }] }] : [] })))
    if (action === 'interactionAnswer') { pending = false; return Promise.reject(new TypeError('Failed to fetch')) }
  })
  await f.open(); fireEvent.click(screen.getByRole('button', { name: '确认并执行一次' }))
  await waitFor(() => expect(byId('status').textContent).toContain('审批提交结果尚未确认'))
  expect(byId('status').className).toBe('error')
  expect(byId('status').textContent).not.toContain('已完成')
})
it('opens a newly created session even when the list refresh fails', async () => {
  let created = false
  const f = mount((_url, _init, action) => {
    if (action === 'create') { created = true; return Promise.resolve(new Response(JSON.stringify({ sessionId: ids[0] }))) }
    if (action === 'list' && created) return Promise.reject(Error('list offline'))
  })
  await waitFor(() => expect(document.querySelectorAll('#sessions button')).toHaveLength(2))
  fireEvent.click(byId('create'))
  await waitFor(() => expect(byId<HTMLButtonElement>('send').disabled).toBe(false))
  await waitFor(() => expect(byId('status').textContent).toContain('会话已创建，列表刷新失败'))
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/create'))).toHaveLength(1)
})

it('persists staged attachment retirement before removing its chip and fences sending until the response', async () => {
  let finish!: (value: Response) => void
  const f=mount((url,_init,action)=>url.startsWith('/lumo/session-attachments/')?Promise.resolve(new Response(JSON.stringify(receipt))):action==='retireAttachment'?new Promise(resolve=>{finish=resolve}):undefined)
  await f.open();fireEvent.change(byId('attachment-files'),{target:{files:[new File(['ready'],'ready.txt')]}})
  await waitFor(()=>expect(byId('attachments').childElementCount).toBe(1))
  fireEvent.click(byId('attachments').querySelector('button')!)
  await waitFor(()=>expect(finish).toBeDefined())
  expect(byId<HTMLButtonElement>('send').disabled).toBe(true)
  expect(byId('attachments').childElementCount).toBe(1)
  fireEvent.submit(byId('prompt'))
  expect(f.fetcher.mock.calls.some(([url])=>url.endsWith('/prompt'))).toBe(false)
  finish(new Response(JSON.stringify({receipt:{...receipt,retired_at:'2026-11-09'}})))
  await waitFor(()=>expect(byId('attachments').childElementCount).toBe(0))
  expect(byId('status').textContent).toContain('已发送的历史附件仍可读取')
})

it('recovers uploaded receipts after switching views and reconciles an uncertain retirement using the active list', async () => {
  let retired=false
  const f=mount((url,_init,action)=>{
    if (url.startsWith('/lumo/session-attachments/')) return Promise.resolve(new Response(JSON.stringify(receipt)))
    if (action==='attachmentList') return Promise.resolve(new Response(JSON.stringify({receipts:retired?[]:[receipt]})))
    if (action==='retireAttachment') { retired=true;return Promise.reject(Error('response lost')) }
  })
  await f.open();fireEvent.click(byId('attachment-refresh'))
  await screen.findByText('加入待发送')
  fireEvent.click(screen.getByText('加入待发送'))
  expect(byId('attachments').textContent).toContain(receipt.name)
  fireEvent.click(byId('attachments').querySelector('button')!)
  await screen.findByText('response lost')
  expect(byId('attachments').childElementCount).toBe(1)
  fireEvent.click(byId('attachment-refresh'))
  await screen.findByText('没有可再次发送的附件。')
  expect(byId('attachments').childElementCount).toBe(0)
  expect(byId('status').textContent).toContain('已退役的待发送项已移除')
})
