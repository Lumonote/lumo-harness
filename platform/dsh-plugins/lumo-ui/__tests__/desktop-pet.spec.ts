// @vitest-environment jsdom
import { randomUUID, webcrypto } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_PET_ATTACHMENT_LIMITS, installDesktopPetBridge, registerDesktopPetSurface, type DesktopPetResult, type DesktopPetServices, type DesktopPetWorkspaceList } from '../src/client/desktop-pet.ts'
import { DesktopPetReceiptStore } from '../src/desktop-pet-receipts.ts'
import type { DesktopPetReceiptClient } from '../src/desktop-pet-receipt-types.ts'
interface Bridge {
  open(value: unknown): { accepted: boolean; error?: string }
  result(id: string): DesktopPetResult
  cancel(id: string): DesktopPetResult
  workspaces(): DesktopPetWorkspaceList
}
const desktop = window as Window & { __LUMO_DESKTOP__?: boolean; __lumoDesktopPet?: Bridge }
const disposers: Array<() => void> = []
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  URL.createObjectURL = vi.fn().mockReturnValue('blob:desktop-pet-preview')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  delete desktop.__LUMO_DESKTOP__; delete desktop.__lumoDesktopPet
  Reflect.deleteProperty(window, Symbol.for('@lumo/desktop-pet/requests'))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
async function finished(bridge: Bridge, id: string, state: DesktopPetResult['state'] = 'accepted') {
  await vi.waitFor(() => expect(bridge.result(id).state).toBe(state)); return bridge.result(id)
}
function memoryReceipts() {
  const stored = new Map<string, unknown>()
  const unit = { loadAll: async () => ({ tables: { requests: Object.fromEntries(stored) }, global: null }), putRecord: vi.fn(async (_table: string, key: string, value: unknown) => { stored.set(key, structuredClone(value)) }), close: async () => {} }
  const store = new DesktopPetReceiptStore(unit, randomUUID(), Date.now, join(tmpdir(), `lumo-pet-${randomUUID()}`))
  const receipts: DesktopPetReceiptClient = { claim: input => store.claim('a'.repeat(64), input), update: input => store.update('a'.repeat(64), input) }
  return { receipts, stored, unit }
}
function mount(options: { surface?: boolean; create?: Promise<string>; ready?: Promise<unknown>; receipts?: DesktopPetReceiptClient } = {}) {
  desktop.__LUMO_DESKTOP__ = true
  const navigation = new AbortController(); const surface = vi.fn(); const release = vi.fn(); const abandon = vi.fn()
  type Session = NonNullable<NonNullable<ReturnType<DesktopPetServices['sessions']['binding']>>['session']>
  const prompt = vi.fn<Session['prompt']>().mockResolvedValue({ ok: true })
  const beginSubmission = vi.fn<Session['beginSubmission']>().mockReturnValue({ requestId: 'host-request-id', abandon })
  const binding = { sessionId: 'new-session', session: { prompt, beginSubmission } }
  const services: DesktopPetServices = {
    receipts: options.receipts ?? memoryReceipts().receipts,
    sessions: {
      list: { getSnapshot: () => ({ phase: 'ready', byId: { 'old-session': { updatedAt: 10, retainedBy: { mainView: 1 } }, 'other-session': { updatedAt: 20 } } }) },
      create: vi.fn(() => options.create ?? Promise.resolve('new-session')),
      retain: vi.fn(() => ({ ready: options.ready ?? Promise.resolve(), release })), binding: vi.fn(() => binding),
    },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [
      { workspaceId: 'current-workspace', title: '当前项目', path: '/current', sessionIds: ['old-session'], createdAt: '2026-01-01T00:00:00Z' },
      { workspaceId: 'other-workspace', path: '/other', sessionIds: ['other-session'], createdAt: '2026-02-01T00:00:00Z' },
    ] }) } },
    conversation: { input: { requestDraftInitialization: vi.fn(() => 'applied') } },
    fileUpload: {
      upload: vi.fn().mockResolvedValue({ ok: true, value: { receiptId: 'file-receipt', file: { name: 'report.pdf', bytes: 3, attachmentId: 'sha256:file' } } }),
      uploadImage: vi.fn().mockResolvedValue({ ok: true, value: { receiptId: 'image-receipt', image: { name: 'picture.png' } } }),
    },
    uiWorkspace: { openSession: vi.fn() }, layout: { beginNavigation: vi.fn(() => navigation.signal), selectPanel: vi.fn() },
  }
  if (options.surface !== false) disposers.push(registerDesktopPetSurface(window, surface))
  const dispose = installDesktopPetBridge(window, services); disposers.push(dispose)
  return { services, bridge: desktop.__lumoDesktopPet!, navigation, surface, release, dispose, prompt, beginSubmission, abandon }
}
const file = { name: 'report.pdf', mimeType: 'application/pdf', base64: 'YWJj' }
const picture = { name: 'picture.png', mimeType: 'image/png', base64: 'aW1n' }
describe('桌宠宿主消息提交', () => {
  it('普通浏览器不安装桌面桥', () => {
    const stop = installDesktopPetBridge(window, {} as DesktopPetServices); expect(desktop.__lumoDesktopPet).toBeUndefined(); stop()
  })
  it('宿主确认提交后才成功，保留准确文本，不切换主窗或写入草稿', async () => {
    const ready = deferred<void>(); const receipt = deferred<{ ok: boolean }>()
    const { services, bridge, prompt, beginSubmission, surface, release } = mount({ ready: ready.promise }); prompt.mockReturnValue(receipt.promise)
    const draft = '  <idea>\n请直接发送  '
    expect(bridge.open({ id: 'send', target: 'chat', draft })).toEqual({ accepted: true })
    await vi.waitFor(() => expect(services.sessions.retain).toHaveBeenCalledOnce()); expect(prompt).not.toHaveBeenCalled(); ready.resolve()
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(bridge.result('send')).toMatchObject({ state: 'pending', phase: 'submitting', sessionId: 'new-session' })
    expect(beginSubmission).toHaveBeenCalledWith({ mode: 'queue', text: draft, attachments: [], onAccept: expect.any(Function) })
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: draft }], 'queue', undefined, 'host-request-id')
    receipt.resolve({ ok: true }); expect(await finished(bridge, 'send')).toEqual({ state: 'accepted', sessionId: 'new-session' })
    expect(services.sessions.create).toHaveBeenCalledWith({ workspaceId: 'current-workspace' })
    expect(services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled(); expect(services.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(services.layout.beginNavigation).not.toHaveBeenCalled(); expect(surface).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce()
  })
  it('宿主已经接受后引用清理失败不能改成可重发状态', async () => {
    const { bridge, release, prompt } = mount(); release.mockImplementationOnce(() => { throw Error('cleanup failed') })
    const request = { id: 'cleanup', target: 'chat', draft: 'run' }; bridge.open(request); await finished(bridge, request.id)
    bridge.open(request); await finished(bridge, request.id); expect(prompt).toHaveBeenCalledOnce()
  })
  it('取消内容校验不能把未校验请求错误确认成历史成功', async () => {
    const { bridge, prompt } = mount(); const request = { id: 'cancel-check', target: 'chat', draft: 'run' }
    bridge.open(request); await finished(bridge, request.id)
    const hash = deferred<ArrayBuffer>(); vi.spyOn(webcrypto.subtle, 'digest').mockReturnValueOnce(hash.promise)
    bridge.open({ ...request, draft: 'different' }); expect(bridge.cancel(request.id).state).toBe('rejected')
    hash.resolve(new ArrayBuffer(32)); await Promise.resolve(); await Promise.resolve()
    expect(bridge.result(request.id).state).toBe('rejected')
    bridge.open(request); await finished(bridge, request.id); expect(prompt).toHaveBeenCalledOnce()
  })
  it('空对话按钮仍导航，但不提交消息', async () => {
    const { bridge, services, prompt, surface } = mount(); bridge.open({ id: 'empty', target: 'chat', draft: '' }); await finished(bridge, 'empty')
    expect(services.uiWorkspace.openSession).toHaveBeenCalledWith('new-session'); expect(surface).toHaveBeenCalledWith('home'); expect(prompt).not.toHaveBeenCalled()
  })
  it('列出真实工作区并允许明确选择，删除的工作区拒绝发送', async () => {
    const { bridge, services, prompt } = mount()
    expect(bridge.workspaces()).toEqual({ workspaces: [{ id: 'current-workspace', label: '当前项目', path: '/current' }, { id: 'other-workspace', label: '/other', path: '/other' }], selectedWorkspaceId: 'current-workspace' })
    bridge.open({ id: 'selected', target: 'chat', draft: 'run', workspaceId: 'other-workspace' }); await finished(bridge, 'selected')
    expect(services.sessions.create).toHaveBeenCalledWith({ workspaceId: 'other-workspace' })
    bridge.open({ id: 'removed', target: 'chat', draft: 'run', workspaceId: 'missing' })
    expect((await finished(bridge, 'removed', 'rejected')).error).toContain('已移除'); expect(prompt).toHaveBeenCalledOnce()
  })
  it('无当前会话选择最近工作区，无工作区不创建孤立会话', async () => {
    const { bridge, services } = mount(); services.sessions.list.getSnapshot = () => ({ phase: 'ready', byId: { 'other-session': { updatedAt: Date.parse('2026-03-01T00:00:00Z') } } })
    expect(bridge.workspaces().selectedWorkspaceId).toBe('other-workspace'); services.workspaces.list.getSnapshot = () => ({ phase: 'ready', items: [] })
    bridge.open({ id: 'none', target: 'chat', draft: 'idea' })
    expect((await finished(bridge, 'none', 'rejected')).error).toContain('添加工作区'); expect(services.sessions.create).not.toHaveBeenCalled()
  })
  it('附件经公开服务上传并按原顺序携带回执，支持纯附件', async () => {
    const { bridge, services, prompt, beginSubmission } = mount()
    bridge.open({ id: 'files', target: 'chat', draft: '', attachments: [file, picture] }); await finished(bridge, 'files')
    expect(services.fileUpload!.upload).toHaveBeenCalledWith('new-session', new Uint8Array([97, 98, 99]), 'report.pdf', expect.any(AbortSignal))
    expect(services.fileUpload!.uploadImage).toHaveBeenCalledWith('new-session', expect.any(Blob), 'image/png', 'picture.png', expect.any(AbortSignal))
    expect(prompt).toHaveBeenCalledWith([{ type: 'file', receiptId: 'file-receipt' }, { type: 'file', receiptId: 'image-receipt' }], 'queue', undefined, 'host-request-id')
    expect(beginSubmission.mock.calls[0]![0].attachments).toEqual([{ type: 'file', value: { name: 'report.pdf', bytes: 3, attachmentId: 'sha256:file' } }, { type: 'image', value: { previewUrl: 'blob:desktop-pet-preview', name: 'picture.png' } }])
    beginSubmission.mock.calls[0]![0].onRetire!(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:desktop-pet-preview')
  })
  it('附件失败重试复用会话与已上传回执', async () => {
    const { bridge, services, prompt } = mount()
    vi.mocked(services.fileUpload!.uploadImage).mockResolvedValueOnce({ ok: false, error: { message: '上传暂不可用' } }).mockResolvedValue({ ok: true, value: { receiptId: 'image-receipt' } })
    const request = { id: 'retry-files', target: 'chat', draft: 'inspect', attachments: [file, picture] }; bridge.open(request)
    expect((await finished(bridge, request.id, 'rejected')).retryable).toBe(true); expect(prompt).not.toHaveBeenCalled()
    bridge.open(request); await finished(bridge, request.id)
    expect(services.sessions.create).toHaveBeenCalledOnce(); expect(services.fileUpload!.upload).toHaveBeenCalledOnce()
    expect(services.fileUpload!.uploadImage).toHaveBeenCalledTimes(2); expect(prompt).toHaveBeenCalledOnce()
  })
  it('无附件服务仍可发送纯文本，附件返回明确错误', async () => {
    const { bridge, services, prompt } = mount(); delete services.fileUpload
    bridge.open({ id: 'text', target: 'chat', draft: 'hello' }); await finished(bridge, 'text')
    bridge.open({ id: 'unavailable', target: 'chat', draft: '', attachments: [file] })
    expect((await finished(bridge, 'unavailable', 'rejected')).error).toContain('附件上传服务'); expect(prompt).toHaveBeenCalledOnce()
  })
  it('明确拒绝可重试同一会话；网络不确定时禁止重发', async () => {
    const { bridge, services, prompt, abandon } = mount(); const request = { id: 'rejected', target: 'chat', draft: 'run' }
    prompt.mockResolvedValueOnce({ ok: false, error: { code: 'session/agent-busy', message: '暂不可用' } }); bridge.open(request)
    expect((await finished(bridge, request.id, 'rejected')).retryable).toBe(true); expect(abandon).toHaveBeenCalledOnce()
    bridge.open(request); await finished(bridge, request.id); expect(services.sessions.create).toHaveBeenCalledOnce(); expect(prompt).toHaveBeenCalledTimes(2)
    prompt.mockRejectedValueOnce(Error('connection lost')); const uncertain = { ...request, id: 'uncertain' }; bridge.open(uncertain)
    expect(await finished(bridge, uncertain.id, 'rejected')).toMatchObject({ retryable: false, sessionId: 'new-session', error: expect.stringContaining('不会自动重发') })
    bridge.open(uncertain); await finished(bridge, uncertain.id, 'rejected'); expect(prompt).toHaveBeenCalledTimes(3)
  })
  it.each(['gateway/internal', 'gateway/cancelled', 'gateway/result-invalid'])('官方网关 %s 失败回包也不可盲目重发', async code => {
    const { bridge, prompt } = mount(); prompt.mockResolvedValueOnce({ ok: false, error: { code, message: 'transport failure' } })
    const request = { id: 'gateway-failure', target: 'chat', draft: 'run' }; bridge.open(request)
    expect((await finished(bridge, request.id, 'rejected')).retryable).toBe(false)
    bridge.open(request); await finished(bridge, request.id, 'rejected'); expect(prompt).toHaveBeenCalledOnce()
  })
  it('提交后取消不打断任务，Inbox先确认即成功，迟到错误不覆盖成功', async () => {
    const receipt = deferred<{ ok: boolean }>(); const { bridge, prompt, beginSubmission } = mount(); prompt.mockReturnValue(receipt.promise)
    bridge.open({ id: 'admission', target: 'chat', draft: 'run', expiresAt: Date.now() + 3000 }); await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(bridge.cancel('admission')).toMatchObject({ state: 'pending', phase: 'submitting' }); beginSubmission.mock.calls[0]![0].onAccept()
    // Inbox acceptance is exposed after its durable receipt write, independently of the open prompt RPC.
    await finished(bridge, 'admission'); receipt.reject(Error('late network error'))
    expect(await finished(bridge, 'admission')).toMatchObject({ sessionId: 'new-session' })
  })
  it('取消后立即重试与迟到创建共用会话，旧任务不会覆盖新状态', async () => {
    const create = deferred<string>(); const { bridge, services, prompt } = mount({ create: create.promise }); const request = { id: 'cancel-retry', target: 'chat', draft: 'run' }
    bridge.open(request); await vi.waitFor(() => expect(services.sessions.create).toHaveBeenCalledOnce()); expect(bridge.cancel(request.id).state).toBe('rejected')
    bridge.open(request); create.resolve('new-session'); await finished(bridge, request.id)
    expect(services.sessions.create).toHaveBeenCalledOnce(); expect(prompt).toHaveBeenCalledOnce()
  })
  it('取消后迟到上传不会发送消息或复用该回执', async () => {
    const upload = deferred<{ ok: boolean; value: { receiptId: string } }>(); const { bridge, services, prompt } = mount()
    vi.mocked(services.fileUpload!.upload).mockReturnValueOnce(upload.promise); const request = { id: 'cancel-upload', target: 'chat', draft: 'run', attachments: [file] }
    bridge.open(request); await vi.waitFor(() => expect(services.fileUpload!.upload).toHaveBeenCalledOnce()); bridge.cancel(request.id)
    upload.resolve({ ok: true, value: { receiptId: 'late' } }); await Promise.resolve(); await Promise.resolve()
    expect(bridge.result(request.id).state).toBe('rejected'); expect(prompt).not.toHaveBeenCalled()
    bridge.open(request); await finished(bridge, request.id); expect(services.fileUpload!.upload).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls[0]![0][0]).toEqual({ type: 'file', receiptId: 'file-receipt' })
  })
  it('重复请求只查状态，指纹冲突拒绝，缓存不保留原始附件', async () => {
    const { bridge, services, prompt } = mount(); const request = { id: 'same', target: 'chat', draft: 'idea', attachments: [file] }
    bridge.open(request); await finished(bridge, request.id); bridge.open({ ...request, expiresAt: Date.now() + 5000 }); await finished(bridge, request.id)
    bridge.open({ ...request, attachments: [{ ...file, base64: 'ZGVm' }] }); expect((await finished(bridge, request.id, 'rejected')).error).toContain('冲突')
    bridge.open(request); await finished(bridge, request.id); expect(prompt).toHaveBeenCalledOnce(); expect(services.sessions.create).toHaveBeenCalledOnce()
    const ledger = Reflect.get(window, Symbol.for('@lumo/desktop-pet/requests')); expect(JSON.stringify([...ledger.results.values()])).not.toContain(file.base64)
  })
  it('并发不同请求拒绝，预先取消阻止迟到请求复活', async () => {
    const create = deferred<string>(); const { bridge, services } = mount({ create: create.promise })
    bridge.cancel('cancel-before-open'); expect(bridge.open({ id: 'cancel-before-open', target: 'chat', draft: 'late' }).accepted).toBe(false)
    bridge.open({ id: 'pending', target: 'chat', draft: 'run' }); expect(bridge.open({ id: 'different', target: 'chat', draft: 'run' }).accepted).toBe(false)
    await vi.waitFor(() => expect(services.sessions.create).toHaveBeenCalledOnce()); create.resolve('new-session'); await finished(bridge, 'pending')
  })
  it('初始过期不创建会话，异步创建期间过期也不发送', async () => {
    const create = deferred<string>(); const { bridge, services, prompt } = mount({ create: create.promise })
    expect(bridge.open({ id: 'expired', target: 'chat', draft: 'keep', expiresAt: Date.now() - 1 }).accepted).toBe(false)
    const now = Date.now(); bridge.open({ id: 'deadline', target: 'chat', draft: 'keep', expiresAt: now + 5000 })
    await vi.waitFor(() => expect(services.sessions.create).toHaveBeenCalledOnce()); vi.spyOn(Date, 'now').mockReturnValue(now + 5001)
    create.resolve('new-session'); await finished(bridge, 'deadline', 'rejected'); expect(services.sessions.retain).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled()
  })
  it('实际发送不受主窗导航影响，空对话导航则尊重后续导航', async () => {
    const ready = deferred<void>(); const { bridge, navigation, prompt, release } = mount({ ready: ready.promise })
    bridge.open({ id: 'independent', target: 'chat', draft: 'run' }); navigation.abort(); ready.resolve(); await finished(bridge, 'independent')
    expect(prompt).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce()
    bridge.open({ id: 'superseded', target: 'chat', draft: '' }); await finished(bridge, 'superseded', 'rejected'); expect(prompt).toHaveBeenCalledOnce()
  })
  it('桥热重装保留提交结果，同一请求不会重复发送', async () => {
    const first = mount(); const request = { id: 'hot-reload', target: 'chat', draft: 'run' }; first.bridge.open(request); await finished(first.bridge, request.id)
    const second = mount(); first.dispose(); second.bridge.open(request); await finished(second.bridge, request.id)
    expect(first.prompt).toHaveBeenCalledOnce(); expect(second.prompt).not.toHaveBeenCalled(); expect(desktop.__lumoDesktopPet).toBe(second.bridge)
  })
  it('完整 WebView 重启仍复用 Host 已确认结果，不再创建或发送', async () => {
    const persistence = memoryReceipts()
    const first = mount({ receipts: persistence.receipts }); const request = { id: 'restart-accepted', target: 'chat', draft: 'run', attachments: [file] }
    first.bridge.open(request); await finished(first.bridge, request.id); first.dispose()
    Reflect.deleteProperty(window, Symbol.for('@lumo/desktop-pet/requests'))
    const second = mount({ receipts: persistence.receipts }); second.bridge.open(request)
    expect(await finished(second.bridge, request.id)).toMatchObject({ sessionId: 'new-session' })
    expect(second.prompt).not.toHaveBeenCalled(); expect(second.services.sessions.create).not.toHaveBeenCalled()
    expect(JSON.stringify([...persistence.stored.values()])).not.toContain(file.base64)
    expect(JSON.stringify([...persistence.stored.values()])).not.toContain('"draft"')
  })
  it('重启后未知提交不重发，保留原会话入口；旧调用迟到确认仍能保存成功', async () => {
    const persistence = memoryReceipts(); const response = deferred<{ ok: boolean }>()
    const first = mount({ receipts: persistence.receipts }); first.prompt.mockReturnValue(response.promise)
    const request = { id: 'restart-unknown', target: 'chat', draft: 'run' }; first.bridge.open(request)
    await vi.waitFor(() => expect(first.prompt).toHaveBeenCalledOnce()); first.dispose()
    Reflect.deleteProperty(window, Symbol.for('@lumo/desktop-pet/requests'))
    const second = mount({ receipts: persistence.receipts }); second.bridge.open(request)
    expect(await finished(second.bridge, request.id, 'rejected')).toMatchObject({ retryable: false, sessionId: 'new-session', error: expect.stringContaining('new-session') })
    expect(second.prompt).not.toHaveBeenCalled(); expect(second.services.sessions.create).not.toHaveBeenCalled()
    response.resolve({ ok: true }); await finished(first.bridge, request.id)
    Reflect.deleteProperty(window, Symbol.for('@lumo/desktop-pet/requests'))
    const third = mount({ receipts: persistence.receipts }); third.bridge.open(request); await finished(third.bridge, request.id)
    expect(third.prompt).not.toHaveBeenCalled()
  })
  it('持久提交围栏失败时不调用 prompt，重试也不能越过失败', async () => {
    const persistence = memoryReceipts()
    const update = persistence.receipts.update
    persistence.receipts.update = vi.fn(input => input.phase === 'submitting' ? Promise.reject(Error('disk unavailable')) : update(input))
    const test = mount({ receipts: persistence.receipts }); const request = { id: 'write-failed', target: 'chat', draft: 'run' }
    test.bridge.open(request); await finished(test.bridge, request.id, 'rejected')
    test.bridge.open(request); await finished(test.bridge, request.id, 'rejected')
    expect(test.prompt).not.toHaveBeenCalled(); expect(test.services.sessions.create).toHaveBeenCalledOnce()
    expect(test.abandon).toHaveBeenCalledOnce()
  })
  it('最初回执读取暂时失败后可重新向 Host claim，不复用已拒绝的 Promise', async () => {
    const persistence = memoryReceipts(), claim = persistence.receipts.claim
    persistence.receipts.claim = vi.fn().mockRejectedValueOnce(Error('temporary storage outage')).mockImplementation(claim)
    const test = mount({ receipts: persistence.receipts }), request = { id: 'claim-recovery', target: 'chat', draft: 'run' }
    test.bridge.open(request); expect(await finished(test.bridge, request.id, 'rejected')).toMatchObject({ retryable: true })
    expect(test.services.sessions.create).not.toHaveBeenCalled()
    test.bridge.open(request); await finished(test.bridge, request.id)
    expect(persistence.receipts.claim).toHaveBeenCalledTimes(2)
    expect(test.services.sessions.create).toHaveBeenCalledOnce(); expect(test.prompt).toHaveBeenCalledOnce()
  })
  it.each([false, true])('准备元数据写入失败后重新读取真实 revision 和附件回执，提交结果未知=%s', async committed => {
    const persistence = memoryReceipts(), update = persistence.receipts.update
    let fail = true
    persistence.receipts.update = vi.fn(async input => {
      if (fail && input.phase === 'preparing' && input.uploads?.length) {
        fail = false
        if (committed) await update(input)
        throw Error('preparation write response lost')
      }
      return update(input)
    })
    const test = mount({ receipts: persistence.receipts }), request = { id: 'preparation-recovery', target: 'chat', draft: 'run', attachments: [file] }
    test.bridge.open(request); expect(await finished(test.bridge, request.id, 'rejected')).toMatchObject({ retryable: true })
    expect(test.prompt).not.toHaveBeenCalled()
    test.bridge.open(request); await finished(test.bridge, request.id)
    expect(test.services.sessions.create).toHaveBeenCalledOnce()
    expect(test.services.fileUpload!.upload).toHaveBeenCalledTimes(committed ? 1 : 2)
    expect(test.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'file', receiptId: 'file-receipt' }, { type: 'text', text: 'run' }], 'queue', undefined, 'host-request-id')
  })
  it('生产默认 Host 记录接口不可用时不退回内存发送', async () => {
    const test = mount(); delete test.services.receipts; test.dispose()
    Reflect.deleteProperty(window, Symbol.for('@lumo/desktop-pet/requests'))
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'receipt_storage_unavailable' }) })
    vi.stubGlobal('fetch', fetch)
    installDesktopPetBridge(window, test.services); const bridge = desktop.__lumoDesktopPet!
    bridge.open({ id: 'no-durable-store', target: 'chat', draft: 'run' }); await finished(bridge, 'no-durable-store', 'rejected')
    expect(fetch).toHaveBeenCalledWith('/lumo/api/desktop-pet/receipts/claim', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(test.services.sessions.create).not.toHaveBeenCalled(); expect(test.prompt).not.toHaveBeenCalled()
  })
  it('导航需界面挂载，实际发送允许隐藏界面', async () => {
    const { bridge, services, surface } = mount(); bridge.open({ id: 'tasks', target: 'tasks', draft: '' }); await finished(bridge, 'tasks')
    expect(services.layout.selectPanel).toHaveBeenCalledWith(null); expect(surface).toHaveBeenCalledWith('tasks'); expect(services.sessions.create).not.toHaveBeenCalled()
    for (const dispose of disposers.splice(0).reverse()) dispose()
    const absent = mount({ surface: false }); absent.bridge.open({ id: 'absent', target: 'home', draft: '' }); await finished(absent.bridge, 'absent', 'rejected')
    absent.bridge.open({ id: 'hidden-send', target: 'chat', draft: 'run' }); await finished(absent.bridge, 'hidden-send'); expect(absent.prompt).toHaveBeenCalledOnce()
  })
  it('最大单文件base64校验不溢出正则栈', () => {
    const { bridge } = mount(); const base64 = Buffer.alloc(DESKTOP_PET_ATTACHMENT_LIMITS.fileBytes).toString('base64')
    expect(() => bridge.open({ id: 'large', target: 'chat', draft: '', attachments: [{ ...file, base64 }] })).not.toThrow(); bridge.cancel('large')
  })
  it.each([
    null, {}, { id: '../bad', target: 'home', draft: '' }, { id: 'bad', target: 'execute', draft: '' },
    { id: 'bad', target: 'tasks', draft: 'private' }, { id: 'bad', target: 'chat', draft: 'a'.repeat(12001) },
    { id: 'bad', target: 'chat', draft: '', workspaceId: '' },
    ...['data:text/plain;base64,YWJj', 'A===', '====', 'aa a', 'a'].map(base64 => ({ id: 'bad', target: 'chat', draft: '', attachments: [{ ...file, base64 }] })),
    { id: 'bad', target: 'chat', draft: '', attachments: [{ ...file, name: '../private' }] },
    { id: 'bad', target: 'chat', draft: '', attachments: Array.from({ length: 5 }, () => file) },
  ])('拒绝非法请求 %j', value => {
    const { bridge, services } = mount(); expect(bridge.open(value).accepted).toBe(false); expect(services.sessions.create).not.toHaveBeenCalled()
  })
})
