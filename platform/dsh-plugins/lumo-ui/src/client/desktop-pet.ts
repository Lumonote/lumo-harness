/** Desktop requests use public Workspace, Session and file-upload services. */
import { desktopPetReceiptClient } from './desktop-pet-ledger.ts'
import type { DesktopPetReceipt, DesktopPetReceiptClient, DesktopPetReceiptUpdate, DesktopPetUploadReceipt } from '../desktop-pet-receipt-types.ts'
export interface DesktopPetAttachment { name: string; mimeType: string; base64: string }
export interface DesktopPetRequest { id: string; target: 'chat' | 'tasks' | 'home'; draft: string; workspaceId?: string; attachments?: DesktopPetAttachment[]; expiresAt?: number }
export interface DesktopPetResult { state: 'pending' | 'accepted' | 'rejected'; error?: string; sessionId?: string; retryable?: boolean; phase?: 'preparing' | 'submitting' }
interface EnqueueResult { accepted: boolean; error?: string }
export interface DesktopPetWorkspaceList { workspaces: { id: string; label: string; path?: string }[]; selectedWorkspaceId?: string; error?: string }
interface DesktopPetBridge {
  open(request: unknown): EnqueueResult
  result(id: string): DesktopPetResult
  cancel(id: string): DesktopPetResult
  workspaces(): DesktopPetWorkspaceList
}
interface RemoteResult { ok: boolean; value?: { receiptId?: string; file?: Record<string, unknown>; image?: Record<string, unknown> }; error?: { code?: string; message?: string } }
type SubmissionAttachment = { type: 'file'; value: Record<string, unknown> } | { type: 'image'; value: { previewUrl: string; name: string } }
interface PromptPart { type: 'text' | 'file'; text?: string; receiptId?: string }
interface SessionBinding {
  sessionId: string
  session?: {
    beginSubmission(input: { mode: 'queue'; text: string; attachments: SubmissionAttachment[]; onAccept(): void; onRetire?(): void }): { requestId: string; abandon(): void }
    prompt(content: PromptPart[], mode: 'queue', signal?: AbortSignal, requestId?: string): Promise<RemoteResult>
  }
}
interface RetainedSession { ready: Promise<unknown>; release(): void }
interface Workspace { workspaceId: string; sessionIds: readonly string[]; createdAt: string; title?: string; path?: string }
export interface DesktopSessionSummary {
  updatedAt: number; displayTitle?: string; cwd?: string; running?: boolean; blank?: boolean; origin?: string
  retainedBy?: Readonly<Record<string, number | undefined>>
}
export interface DesktopPetServices {
  /** Tests may inject a receipt transport; production always uses the authenticated Host. */
  receipts?: DesktopPetReceiptClient
  sessions: {
    list: { getSnapshot(): { phase: string; ids?: readonly string[]; byId: Readonly<Record<string, DesktopSessionSummary | undefined>> }; subscribe?(listener: () => void): () => void }
    create(options: { workspaceId: string }): Promise<string>
    retain(id: string, options: { source: 'controllerOperation'; signal: AbortSignal }): RetainedSession
    binding(id: string): SessionBinding | undefined
  }
  workspaces: { list: { getSnapshot(): { phase: string; items: readonly Workspace[]; archivedSessionIds?: readonly string[] }; subscribe?(listener: () => void): () => void } }
  conversation: { input: { requestDraftInitialization(binding: SessionBinding, options: { prompt: string; whenDraftExists: 'keep' }): 'applied' | 'preserved' | 'blocked' } }
  fileUpload?: {
    upload(sessionId: string, bytes: Uint8Array, name?: string, signal?: AbortSignal): Promise<RemoteResult>
    uploadImage(sessionId: string, blob: Blob, mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', name?: string, signal?: AbortSignal): Promise<RemoteResult>
  }
  uiWorkspace: { openSession(id: string): void }
  layout: { beginNavigation(): AbortSignal; selectPanel(id: null): void }
}

const SURFACE = Symbol.for('@lumo/desktop-pet/surface')
const OWNER = Symbol.for('@lumo/desktop-pet/owner')
const SERVICES = Symbol.for('@lumo/desktop-pet/services')
const LEDGER = Symbol.for('@lumo/desktop-pet/requests')
interface SurfaceRegistration { open(target: 'tasks' | 'home'): void }
interface ServiceState { current?: DesktopPetServices; listeners: Set<() => void> }
interface RequestEntry { fingerprint: Promise<string>; owner: string; receipt?: DesktopPetReceipt; reloadReceipt?: boolean; claiming?: Promise<{ record: DesktopPetReceipt; acquired: boolean }>; writing?: Promise<unknown>; result: DesktopPetResult; controller: AbortController; sessionId?: string; creating?: Promise<string>; submitting: boolean; uploads: DesktopPetUploadReceipt[]; verification?: { result: DesktopPetResult; cancelled?: boolean } }
interface RequestLedger { results: Map<string, RequestEntry>; cancelledIds: Set<string> }
type DesktopWindow = Window & { __LUMO_DESKTOP__?: boolean; __lumoDesktopPet?: DesktopPetBridge; [SURFACE]?: SurfaceRegistration; [OWNER]?: () => void; [SERVICES]?: ServiceState; [LEDGER]?: RequestLedger }
const RETAINED_RESULTS = 64
const MAX_DRAFT = 12000
export const DESKTOP_PET_ATTACHMENT_LIMITS = { count: 4, fileBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 } as const
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const definitePromptRejections = new Set(['session/agent-busy', 'session/attachment-invalid', 'session/not-found', 'session/writer-held', 'session/model-unavailable', 'session/provider-credentials-unavailable', 'session/invalid-time-zone'])

function serviceState(view: Window): ServiceState { return (view as DesktopWindow)[SERVICES] ??= { listeners: new Set() } }
export function getDesktopPetServices(view: Window): DesktopPetServices | undefined { return serviceState(view).current }
export function subscribeDesktopPetServices(view: Window, listener: () => void): () => void {
  const state = serviceState(view); state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}
export function registerDesktopPetSurface(view: Window, open: SurfaceRegistration['open']): () => void {
  const desktop = view as DesktopWindow
  if (desktop.__LUMO_DESKTOP__ !== true) return () => {}
  const registration = { open }; desktop[SURFACE] = registration
  return () => { if (desktop[SURFACE] === registration) delete desktop[SURFACE] }
}
function parseRequest(value: unknown): DesktopPetRequest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const request = value as Partial<DesktopPetRequest>
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(request.id)) return undefined
  if (request.target !== 'chat' && request.target !== 'tasks' && request.target !== 'home') return undefined
  if (typeof request.draft !== 'string' || request.draft.length > MAX_DRAFT) return undefined
  if (request.target !== 'chat' && (request.draft !== '' || request.workspaceId !== undefined || (request.attachments?.length ?? 0) > 0)) return undefined
  if (request.workspaceId !== undefined && (typeof request.workspaceId !== 'string' || !request.workspaceId.trim() || request.workspaceId.length > 4096)) return undefined
  if (request.expiresAt !== undefined && (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0)) return undefined
  if (request.attachments !== undefined && (!Array.isArray(request.attachments) || request.attachments.length > DESKTOP_PET_ATTACHMENT_LIMITS.count)) return undefined
  let total = 0
  const attachments: DesktopPetAttachment[] = []
  for (const item of request.attachments ?? []) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\\/\x00-\x1f\x7f]/u.test(item.name)
      || typeof item.mimeType !== 'string' || item.mimeType.length > 127 || (item.mimeType !== '' && !/^[\w.+-]+\/[\w.+-]+$/u.test(item.mimeType))
      || typeof item.base64 !== 'string' || item.base64.length === 0 || item.base64.length > Math.ceil(DESKTOP_PET_ATTACHMENT_LIMITS.fileBytes / 3) * 4
      || item.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(item.base64) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(item.base64)) return undefined
    const size = item.base64.length / 4 * 3 - (item.base64.endsWith('==') ? 2 : item.base64.endsWith('=') ? 1 : 0)
    total += size
    if (size > DESKTOP_PET_ATTACHMENT_LIMITS.fileBytes || total > DESKTOP_PET_ATTACHMENT_LIMITS.totalBytes) return undefined
    attachments.push({ name: item.name, mimeType: item.mimeType.toLowerCase() || 'application/octet-stream', base64: item.base64 })
  }
  return { id: request.id, target: request.target, draft: request.draft, attachments, ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }), ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }) }
}
function targetWorkspace(services: DesktopPetServices, requested?: string): string {
  const workspaces = services.workspaces.list.getSnapshot(); const sessions = services.sessions.list.getSnapshot()
  if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') throw Error('工作区尚未就绪，请稍后重试。')
  if (requested !== undefined) {
    if (!workspaces.items.some(item => item.workspaceId === requested)) throw Error('所选工作区已移除，请重新选择。')
    return requested
  }
  const currentId = Object.keys(sessions.byId).find(id => (sessions.byId[id]?.retainedBy?.['mainView'] ?? 0) > 0)
  const current = workspaces.items.find(item => item.sessionIds.includes(currentId ?? ''))
  if (current !== undefined) return current.workspaceId
  let selected: Workspace | undefined; let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces.items) {
    const activity = workspace.sessionIds.reduce((latest, id) => Math.max(latest, sessions.byId[id]?.updatedAt ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY)
    const updated = Number.isFinite(activity) ? activity : Date.parse(workspace.createdAt)
    if (selected === undefined || updated > selectedTime) { selected = workspace; selectedTime = updated }
  }
  if (selected === undefined) throw Error('请先在工作台添加工作区，再新建对话。')
  return selected.workspaceId
}
async function fingerprint(view: Window, request: DesktopPetRequest): Promise<string> {
  // Native callers resupply attachments when retrying. Retain only a SHA-256
  // identity in the ledger, never multi-megabyte base64 payloads.
  const payload = JSON.stringify([request.target, request.draft, request.workspaceId ?? null, request.attachments ?? []])
  const digest = await view.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Acceptance means Host prompt admission. A native timeout never cancels an in-flight prompt. */
export function installDesktopPetBridge(view: Window, services: DesktopPetServices): () => void {
  const desktop = view as DesktopWindow
  if (desktop.__LUMO_DESKTOP__ !== true) return () => {}
  desktop[OWNER]?.()
  const state = serviceState(view); state.current = services; state.listeners.forEach(listener => listener())
  const ledger = desktop[LEDGER] ??= { results: new Map(), cancelledIds: new Set() }
  const { results, cancelledIds } = ledger
  const receipts = services.receipts ?? desktopPetReceiptClient(view)
  let disposed = false
  const unknown = (): DesktopPetResult => ({ state: 'rejected', error: '桌宠请求已过期，请重新操作。' })
  const snapshot = (entry: RequestEntry): DesktopPetResult => ({ ...(entry.verification?.result ?? entry.result), ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) })
  const uncertain = (entry: RequestEntry): void => {
    const location = entry.sessionId ? `请打开原对话 ${entry.sessionId} 核对。` : '请在工作台核对已创建的对话。'
    entry.result = { state: 'rejected', retryable: false, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), error: `发送回执未确认，${location}为避免重复任务，本次请求不会自动重发。` }
  }
  const persist = (entry: RequestEntry, patch: Pick<DesktopPetReceiptUpdate, 'phase'> & Partial<DesktopPetReceiptUpdate>): Promise<void> => {
    const writing = (entry.writing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const record = entry.receipt
      if (!record) throw Error('桌宠发送记录未就绪。')
      try { entry.receipt = await receipts.update({ id: record.id, digest: record.digest, owner: entry.owner, revision: record.revision, ...patch }) }
      catch (error) {
        // A preparation write may have committed despite its missing reply.
        // Only a new authoritative claim can recover its revision/uploads.
        if (record.phase === 'preparing' && patch.phase === 'preparing') entry.reloadReceipt = true
        throw error
      }
    })
    entry.writing = writing
    return writing
  }
  async function perform(entry: RequestEntry, request: DesktopPetRequest, controller: AbortController): Promise<void> {
    const signal = controller.signal
    const ensureActive = (): void => {
      signal.throwIfAborted()
      if (entry.controller !== controller) throw Error('请求已被后续重试替代。')
      if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) throw Error('桌宠请求已超时，内容已保留，请重试。')
    }
    const digest = await entry.fingerprint
    ensureActive()
    if (request.target !== 'chat') {
      const surface = desktop[SURFACE]
      if (!surface) throw Error('工作台界面尚未就绪，请稍后重试。')
      services.layout.selectPanel(null); surface.open(request.target); return
    }
    const workspaceId = targetWorkspace(services, request.workspaceId)
    const hasContent = request.draft.trim() !== '' || (request.attachments?.length ?? 0) > 0
    if (!hasContent && !desktop[SURFACE]) throw Error('工作台界面尚未就绪，请稍后重试。')
    if ((request.attachments?.length ?? 0) > 0 && !services.fileUpload) throw Error('附件上传服务尚未就绪，请稍后重试。')
    if (entry.reloadReceipt) {
      await entry.writing?.catch(() => {})
      ensureActive()
      delete entry.receipt; delete entry.claiming; delete entry.reloadReceipt
    }
    if (!entry.receipt) {
      entry.claiming ??= receipts.claim({ id: request.id, digest, workspaceId, owner: entry.owner })
      let claim: Awaited<ReturnType<DesktopPetReceiptClient['claim']>>
      const claiming = entry.claiming
      try { claim = await claiming }
      catch (error) { if (entry.claiming === claiming) delete entry.claiming; throw error }
      entry.receipt = claim.record
      if (claim.record.sessionId) entry.sessionId = claim.record.sessionId
      else delete entry.sessionId
      entry.uploads = claim.record.uploads
      if (claim.record.phase === 'accepted') { entry.result = { state: 'accepted', ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) }; return }
      if (!claim.acquired) {
        if (claim.record.phase === 'preparing') entry.result = { state: 'rejected', retryable: true, error: '另一个窗口正在准备此请求，请稍后重试。' }
        else uncertain(entry)
        // A non-owner cannot retain a handle and bypass the next claim.
        delete entry.receipt; delete entry.claiming
        return
      }
    }
    if ((entry.receipt.phase === 'creating' && !entry.creating) || entry.receipt.phase === 'submitting') { uncertain(entry); return }
    ensureActive()
    const navigation = hasContent ? undefined : services.layout.beginNavigation()
    // A pre-submit retry keeps the created Session and any completed upload receipts.
    if (!entry.sessionId) {
      entry.creating ??= (async () => {
        // A restart between create and its response must never create another Session.
        await persist(entry, { phase: 'creating' })
        let id: string
        try { id = await services.sessions.create({ workspaceId: entry.receipt!.workspaceId }) }
        catch (failure) { uncertain(entry); throw failure }
        entry.sessionId = id
        await persist(entry, { phase: 'preparing', sessionId: id })
        return id
      })()
      const creating = entry.creating
      try { entry.sessionId = await creating }
      finally { if (entry.creating === creating) delete entry.creating }
    }
    ensureActive(); navigation?.throwIfAborted()
    const id = entry.sessionId
    const reference = services.sessions.retain(id, { source: 'controllerOperation', signal })
    try {
      await reference.ready
      ensureActive(); navigation?.throwIfAborted()
      const binding = services.sessions.binding(id)
      if (!binding) throw Error('新对话未能就绪，请重试。')
      if (!hasContent) {
        services.uiWorkspace.openSession(id); desktop[SURFACE]!.open('home'); await persist(entry, { phase: 'accepted' }); return
      }
      const session = binding.session
      if (!session || typeof session.prompt !== 'function' || typeof session.beginSubmission !== 'function') throw Error('对话发送服务尚未就绪，请稍后重试。')
      for (let index = entry.uploads.length; index < (request.attachments?.length ?? 0); index++) {
        ensureActive()
        const attachment = request.attachments![index]!
        const binary = view.atob(attachment.base64)
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
        const result = imageTypes.has(attachment.mimeType)
          ? await services.fileUpload!.uploadImage(id, new Blob([bytes], { type: attachment.mimeType }), attachment.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', attachment.name, signal)
          : await services.fileUpload!.upload(id, bytes, attachment.name, signal)
        ensureActive()
        if (!result.ok || typeof result.value?.receiptId !== 'string' || !result.value.receiptId) throw Error(result.error?.message ?? `附件 ${attachment.name} 上传失败。`)
        const file = result.value.file
        const metadata = file && typeof file['attachmentId'] === 'string' && typeof file['name'] === 'string' && Number.isSafeInteger(file['bytes'])
          ? { attachmentId: file['attachmentId'], name: file['name'], bytes: file['bytes'] as number } : undefined
        entry.uploads.push({ receiptId: result.value.receiptId, ...(metadata ? { file: metadata } : {}) })
        await persist(entry, { phase: 'preparing', uploads: entry.uploads })
      }
      ensureActive()
      let accepting: Promise<void> | undefined
      const accepted = (): void => {
        accepting ??= persist(entry, { phase: 'accepted' }).then(() => { entry.result = { state: 'accepted', sessionId: id } }, () => { uncertain(entry) })
      }
      const isAccepted = (): boolean => entry.result.state === 'accepted'
      const previewUrls: string[] = []
      const retirePreviews = (): void => { for (const url of previewUrls.splice(0)) URL.revokeObjectURL(url) }
      let submission: ReturnType<typeof session.beginSubmission>
      try {
        const attachments: SubmissionAttachment[] = entry.uploads.flatMap((upload, index): SubmissionAttachment[] => {
          if (upload.file) return [{ type: 'file', value: upload.file }]
          const attachment = request.attachments![index]!
          if (!imageTypes.has(attachment.mimeType)) return []
          const bytes = Uint8Array.from(view.atob(attachment.base64), character => character.charCodeAt(0))
          const previewUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }))
          previewUrls.push(previewUrl)
          return [{ type: 'image', value: { previewUrl, name: attachment.name } }]
        })
        submission = session.beginSubmission({ mode: 'queue', text: request.draft, attachments, onAccept: accepted, ...(previewUrls.length ? { onRetire: retirePreviews } : {}) })
      } catch (failure) { retirePreviews(); throw failure }
      const parts: PromptPart[] = [...entry.uploads.map(upload => ({ type: 'file' as const, receiptId: upload.receiptId })), ...(request.draft === '' ? [] : [{ type: 'text' as const, text: request.draft }])]
      // Receipt IDs and object URLs now own the submission. The RPC may remain
      // open after Inbox acceptance, so release raw IPC bytes before awaiting it.
      request.attachments = []
      entry.submitting = true; entry.result = { state: 'pending', phase: 'submitting', sessionId: id }
      let dispatched = false
      try {
        // Durably fence the request before the first RPC byte can leave this view.
        await persist(entry, { phase: 'submitting', hostRequestId: submission.requestId })
        // Once dispatched there is no cancellation signal: a timed-out native UI
        // must query this same request, never abandon a potentially accepted send.
        dispatched = true
        const result = await session.prompt(parts, 'queue', undefined, submission.requestId)
        if (accepting) { await accepting; return }
        if (isAccepted()) return
        if (!result.ok) {
          // The official gateway folds transport failures into ok:false with
          // gateway/* codes. Only identified admission rejections are safe to retry.
          if (!definitePromptRejections.has(result.error?.code ?? '')) throw Error('无法确认宿主回执。')
          submission.abandon()
          await persist(entry, { phase: 'preparing', failure: 'admission-rejected' })
          entry.submitting = false
          throw Error(result.error?.message ?? '消息未被接收，请重试。')
        }
        accepted(); await accepting
      } catch (failure) {
        if (accepting) { await accepting; return }
        if (isAccepted()) return
        if (!dispatched) {
          // The durable fence failed before any Host RPC. Remove the optimistic
          // item; an uncertain storage receipt still cannot authorize a resend.
          try { submission.abandon() } catch { /* Preserve the durable no-replay decision even if view cleanup fails. */ }
        }
        retirePreviews()
        if (entry.submitting) {
          uncertain(entry)
          return
        }
        throw failure
      } finally { entry.submitting = false }
    } finally { reference.release() }
  }
  const start = (entry: RequestEntry, request: DesktopPetRequest): void => {
    const controller = new AbortController()
    entry.controller = controller; entry.submitting = false; entry.result = { state: 'pending', phase: 'preparing' }
    delete entry.verification
    void perform(entry, request, controller).then(() => {
      if (entry.controller === controller && entry.result.state === 'pending' && !controller.signal.aborted) entry.result = { state: 'accepted', ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) }
    }, async reason => {
      if (entry.controller === controller && entry.result.state === 'pending' && !controller.signal.aborted) {
        if (entry.receipt?.phase === 'creating' || entry.receipt?.phase === 'submitting') { uncertain(entry); return }
        if (entry.receipt) {
          try { await persist(entry, { phase: 'preparing', failure: 'preparation-failed' }) }
          catch { /* No effect is dispatched without a durable phase. A later CAS still fails closed. */ }
        }
        if (entry.controller === controller && !controller.signal.aborted) entry.result = { state: 'rejected', retryable: true, error: reason instanceof Error ? reason.message : '工作台未能接收请求。' }
      }
    })
  }
  const pending = (): boolean => [...results.values()].some(entry => entry.result.state === 'pending' || entry.verification?.result.state === 'pending')
  const bridge: DesktopPetBridge = {
    workspaces() {
      try {
        const snapshot = services.workspaces.list.getSnapshot()
        if (snapshot.phase !== 'ready') throw Error('工作区尚未就绪，请稍后重试。')
        const workspaces = snapshot.items.map(item => ({ id: item.workspaceId, label: item.title || item.path || item.workspaceId, ...(item.path ? { path: item.path } : {}) }))
        return { workspaces, ...(workspaces.length ? { selectedWorkspaceId: targetWorkspace(services) } : {}) }
      } catch (reason) { return { workspaces: [], error: reason instanceof Error ? reason.message : '工作区尚未就绪。' } }
    },
    open(value) {
      if (disposed) return { accepted: false, error: '工作台已关闭。' }
      const request = parseRequest(value)
      if (!request) return { accepted: false, error: '桌宠请求或附件无效。' }
      const previous = results.get(request.id)
      if (previous) {
        // Validation is asynchronous, but enqueue remains synchronous for the
        // native WebView callback. Polling sees pending until the content hash
        // matches; a conflicting payload can never start another submission.
        if (previous.verification?.result.state === 'pending') return { accepted: false, error: '正在校验上一条桌宠请求，请稍后重试。' }
        const verification = { result: { state: 'pending', phase: 'preparing' } as DesktopPetResult, cancelled: false }
        previous.verification = verification
        void Promise.all([previous.fingerprint, fingerprint(view, request)]).then(([before, after]) => {
          if (previous.verification !== verification || verification.cancelled) return
          if (before !== after) { verification.result = { state: 'rejected', retryable: false, error: '桌宠请求标识冲突。' }; return }
          delete previous.verification
          if (previous.result.state !== 'rejected' || !previous.result.retryable) return
          if (disposed || (request.expiresAt !== undefined && Date.now() >= request.expiresAt)) {
            previous.result = { state: 'rejected', retryable: true, error: '桌宠请求已超时，请重新操作。' }; return
          }
          if (pending()) { previous.result = { state: 'rejected', retryable: true, error: '正在接收上一条桌宠请求，请稍后重试。' }; return }
          start(previous, request)
        }, reason => { if (previous.verification === verification) verification.result = { state: 'rejected', retryable: false, error: reason instanceof Error ? reason.message : '无法校验桌宠请求。' } })
        return { accepted: true }
      }
      if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) return { accepted: false, error: '桌宠请求已超时，请重新操作。' }
      if (cancelledIds.has(request.id)) return { accepted: false, error: '桌宠请求已取消，请重新操作。' }
      if (pending()) return { accepted: false, error: '正在接收上一条桌宠请求，请稍后重试。' }
      for (const [id, entry] of results) { if (results.size < RETAINED_RESULTS) break; if (snapshot(entry).state !== 'pending' && entry.result.state !== 'pending' && !entry.submitting) { results.delete(id); cancelledIds.add(id) } }
      if (cancelledIds.size > RETAINED_RESULTS) cancelledIds.delete(cancelledIds.values().next().value!)
      if (results.size >= RETAINED_RESULTS) return { accepted: false, error: '仍有桌宠请求等待宿主确认，请稍后重试。' }
      const entry: RequestEntry = { fingerprint: fingerprint(view, request), owner: view.crypto.randomUUID(), result: { state: 'pending' }, controller: new AbortController(), submitting: false, uploads: [] }
      results.set(request.id, entry); start(entry, request)
      return { accepted: true }
    },
    result(id) { const entry = results.get(id); return entry ? snapshot(entry) : unknown() },
    cancel(id) {
      const entry = results.get(id)
      if (!entry) {
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id)) { cancelledIds.add(id); if (cancelledIds.size > RETAINED_RESULTS) cancelledIds.delete(cancelledIds.values().next().value!) }
        return unknown()
      }
      if (entry.verification?.result.state === 'pending') {
        entry.verification.cancelled = true
        entry.verification.result = { state: 'rejected', retryable: true, error: '请求校验已取消，桌宠中的内容已保留。' }
      }
      if (entry.result.state === 'pending' && !entry.submitting) {
        entry.controller.abort(); entry.result = { state: 'rejected', retryable: true, error: '请求已取消，桌宠中的内容已保留。' }
      }
      return snapshot(entry)
    },
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const [id] of results) bridge.cancel(id)
    if (state.current === services) { delete state.current; state.listeners.forEach(listener => listener()) }
    if (desktop.__lumoDesktopPet === bridge) delete desktop.__lumoDesktopPet
    if (desktop[OWNER] === dispose) delete desktop[OWNER]
  }
  desktop.__lumoDesktopPet = bridge; desktop[OWNER] = dispose
  return dispose
}
