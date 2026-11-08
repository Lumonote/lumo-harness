/** Desktop-only draft handoff. Every action uses public Controller/UI services. */
export interface DesktopPetRequest { id: string; target: 'chat' | 'tasks' | 'home'; draft: string; expiresAt?: number }
export interface DesktopPetResult { state: 'pending' | 'accepted' | 'rejected'; error?: string }
interface EnqueueResult { accepted: boolean; error?: string }
interface DesktopPetBridge {
  open(request: unknown): EnqueueResult
  result(id: string): DesktopPetResult
  cancel(id: string): DesktopPetResult
}

interface SessionBinding { sessionId: string }
interface RetainedSession { ready: Promise<unknown>; release(): void }
interface Workspace { workspaceId: string; sessionIds: readonly string[]; createdAt: string }
export interface DesktopSessionSummary {
  updatedAt: number
  displayTitle?: string
  cwd?: string
  running?: boolean
  blank?: boolean
  origin?: string
  retainedBy?: Readonly<Record<string, number | undefined>>
}

/** Structural projections of the public client APIs; no upstream source imports. */
export interface DesktopPetServices {
  sessions: {
    list: {
      getSnapshot(): { phase: string; ids?: readonly string[]; byId: Readonly<Record<string, DesktopSessionSummary | undefined>> }
      subscribe?(listener: () => void): () => void
    }
    create(options: { workspaceId: string }): Promise<string>
    retain(id: string, options: { source: 'controllerOperation'; signal: AbortSignal }): RetainedSession
    binding(id: string): SessionBinding | undefined
  }
  workspaces: { list: { getSnapshot(): { phase: string; items: readonly Workspace[]; archivedSessionIds?: readonly string[] }; subscribe?(listener: () => void): () => void } }
  conversation: { input: { requestDraftInitialization(binding: SessionBinding, options: { prompt: string; whenDraftExists: 'keep' }): 'applied' | 'preserved' | 'blocked' } }
  uiWorkspace: { openSession(id: string): void }
  layout: { beginNavigation(): AbortSignal; selectPanel(id: null): void }
}

type DesktopWindow = Window & { __LUMO_DESKTOP__?: boolean; __lumoDesktopPet?: DesktopPetBridge; [SURFACE]?: SurfaceRegistration; [OWNER]?: () => void; [SERVICES]?: ServiceState }
interface SurfaceRegistration { open(target: 'tasks' | 'home'): void }
const SURFACE = Symbol.for('@lumo/desktop-pet/surface')
const OWNER = Symbol.for('@lumo/desktop-pet/owner')
const SERVICES = Symbol.for('@lumo/desktop-pet/services')
interface ServiceState { current?: DesktopPetServices; listeners: Set<() => void> }
const RETAINED_RESULTS = 64
const MAX_DRAFT = 12000

function serviceState(view: Window): ServiceState {
  const desktop = view as DesktopWindow
  return desktop[SERVICES] ??= { listeners: new Set() }
}
export function getDesktopPetServices(view: Window): DesktopPetServices | undefined { return serviceState(view).current }
export function subscribeDesktopPetServices(view: Window, listener: () => void): () => void {
  const state = serviceState(view)
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}

/** The overlay registers after its listeners mount, so an absent UI cannot acknowledge a handoff. */
export function registerDesktopPetSurface(view: Window, open: SurfaceRegistration['open']): () => void {
  const desktop = view as DesktopWindow
  if (desktop.__LUMO_DESKTOP__ !== true) return () => {}
  const registration = { open }
  desktop[SURFACE] = registration
  return () => { if (desktop[SURFACE] === registration) delete desktop[SURFACE] }
}

function parseRequest(value: unknown): DesktopPetRequest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const request = value as Partial<DesktopPetRequest>
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(request.id)) return undefined
  if (request.target !== 'chat' && request.target !== 'tasks' && request.target !== 'home') return undefined
  if (typeof request.draft !== 'string' || request.draft.length > MAX_DRAFT) return undefined
  if (request.target !== 'chat' && request.draft !== '') return undefined
  if (request.expiresAt !== undefined && (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0)) return undefined
  return { id: request.id, target: request.target, draft: request.draft, ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }) }
}

/** Current Workspace first, then the one with most recent Session activity, as in native New Session. */
function targetWorkspace(services: DesktopPetServices): string {
  const workspaces = services.workspaces.list.getSnapshot()
  const sessions = services.sessions.list.getSnapshot()
  if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') throw Error('工作区尚未就绪，请稍后重试。')
  // The Session catalog has no `current` field. Public mainView retention names the selected generation.
  const currentId = Object.keys(sessions.byId).find(id => (sessions.byId[id]?.retainedBy?.['mainView'] ?? 0) > 0)
  const current = workspaces.items.find(workspace => workspace.sessionIds.includes(currentId ?? ''))
  if (current !== undefined) return current.workspaceId
  let selected: Workspace | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces.items) {
    const activity = workspace.sessionIds.reduce((latest, id) => Math.max(latest, sessions.byId[id]?.updatedAt ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY)
    const updated = Number.isFinite(activity) ? activity : Date.parse(workspace.createdAt)
    if (selected === undefined || updated > selectedTime) { selected = workspace; selectedTime = updated }
  }
  if (selected === undefined) throw Error('请先在工作台添加工作区，再新建对话。')
  return selected.workspaceId
}

/**
 * Native eval calls these synchronous methods; only result=accepted permits clearing the pet draft.
 * A timeout/disposal aborts before the next mutation, even when Session creation resolves late.
 */
export function installDesktopPetBridge(view: Window, services: DesktopPetServices): () => void {
  const desktop = view as DesktopWindow
  if (desktop.__LUMO_DESKTOP__ !== true) return () => {}
  desktop[OWNER]?.()
  const state = serviceState(view)
  state.current = services
  state.listeners.forEach(listener => listener())
  let disposed = false
  let active: string | undefined
  const cancelledIds = new Set<string>()
  const results = new Map<string, { request: DesktopPetRequest; result: DesktopPetResult; controller: AbortController }>()
  const unknown = (): DesktopPetResult => ({ state: 'rejected', error: '桌宠请求已过期，请重新操作。' })
  const prune = (): void => {
    for (const [id, item] of results) {
      if (results.size < RETAINED_RESULTS) break
      if (item.result.state !== 'pending') results.delete(id)
    }
  }
  async function perform(request: DesktopPetRequest, signal: AbortSignal): Promise<void> {
    const ensureDeadline = (): void => { if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) throw Error('桌宠请求已超时，草稿已保留，请重试。') }
    const surface = desktop[SURFACE]
    if (surface === undefined) throw Error('工作台界面尚未就绪，请稍后重试。')
    signal.throwIfAborted()
    ensureDeadline()
    if (request.target !== 'chat') {
      services.layout.selectPanel(null)
      surface.open(request.target)
      return
    }
    const workspaceId = targetWorkspace(services)
    const navigation = services.layout.beginNavigation()
    const ensureActive = (): void => { signal.throwIfAborted(); navigation.throwIfAborted(); ensureDeadline(); if (desktop[SURFACE] !== surface) throw Error('工作台界面已刷新，请重试。') }
    // Omitting sessionId creates a fresh Session instead of reusing a blank with an unsent draft.
    const id = await services.sessions.create({ workspaceId })
    ensureActive()
    const reference = services.sessions.retain(id, { source: 'controllerOperation', signal })
    try {
      await reference.ready
      ensureActive()
      const binding = services.sessions.binding(id)
      if (binding === undefined) throw Error('新对话未能就绪，请重试。')
      if (request.draft !== '') {
        const result = services.conversation.input.requestDraftInitialization(binding, { prompt: request.draft, whenDraftExists: 'keep' })
        if (result !== 'applied') throw Error('新对话无法接收草稿，桌宠中的内容已保留。')
      }
      services.uiWorkspace.openSession(id)
      surface.open('home')
    } finally {
      reference.release()
    }
  }
  const bridge: DesktopPetBridge = {
    open(value) {
      if (disposed) return { accepted: false, error: '工作台已关闭。' }
      const request = parseRequest(value)
      if (request === undefined) return { accepted: false, error: '桌宠请求无效。' }
      if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) return { accepted: false, error: '桌宠请求已超时，请重新操作。' }
      if (cancelledIds.has(request.id)) return { accepted: false, error: '桌宠请求已取消，请重新操作。' }
      const previous = results.get(request.id)
      if (previous !== undefined) {
        return previous.request.target === request.target && previous.request.draft === request.draft
          ? { accepted: true }
          : { accepted: false, error: '桌宠请求标识冲突。' }
      }
      if (active !== undefined) return { accepted: false, error: '正在接收上一条桌宠请求，请稍后重试。' }
      prune()
      const entry = { request, result: { state: 'pending' } as DesktopPetResult, controller: new AbortController() }
      results.set(request.id, entry)
      active = request.id
      void perform(request, entry.controller.signal).then(() => {
        if (!entry.controller.signal.aborted) entry.result = { state: 'accepted' }
      }, reason => {
        if (!entry.controller.signal.aborted) entry.result = { state: 'rejected', error: reason instanceof Error ? reason.message : '工作台未能接收请求。' }
      }).finally(() => { if (active === request.id) active = undefined })
      return { accepted: true }
    },
    result(id) { return { ...(results.get(id)?.result ?? unknown()) } },
    cancel(id) {
      const entry = results.get(id)
      if (entry === undefined) {
        if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
          cancelledIds.add(id)
          if (cancelledIds.size > RETAINED_RESULTS) cancelledIds.delete(cancelledIds.values().next().value!)
        }
        return unknown()
      }
      if (entry.result.state === 'pending') {
        entry.controller.abort()
        entry.result = { state: 'rejected', error: '请求已取消，桌宠中的草稿已保留。' }
        if (active === id) active = undefined
      }
      return { ...entry.result }
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
  desktop.__lumoDesktopPet = bridge
  desktop[OWNER] = dispose
  return dispose
}
