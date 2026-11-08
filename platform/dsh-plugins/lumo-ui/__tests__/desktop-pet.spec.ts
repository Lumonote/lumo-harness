// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopPetBridge, registerDesktopPetSurface, type DesktopPetServices } from '../src/client/desktop-pet.ts'

interface Bridge {
  open(value: unknown): { accepted: boolean; error?: string }
  result(id: string): { state: string; error?: string }
  cancel(id: string): { state: string; error?: string }
}
const desktop = window as Window & { __LUMO_DESKTOP__?: boolean; __lumoDesktopPet?: Bridge }
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  delete desktop.__LUMO_DESKTOP__
  delete desktop.__lumoDesktopPet
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function mount(options: { surface?: boolean; create?: Promise<string>; ready?: Promise<unknown>; initialization?: 'applied' | 'preserved' | 'blocked' } = {}) {
  desktop.__LUMO_DESKTOP__ = true
  const navigation = new AbortController()
  const surface = vi.fn()
  const binding = { sessionId: 'new-session' }
  const release = vi.fn()
  const services: DesktopPetServices = {
    sessions: {
      list: { getSnapshot: () => ({ phase: 'ready', byId: { 'old-session': { updatedAt: 10, retainedBy: { mainView: 1 } }, 'other-session': { updatedAt: 20 } } }) },
      create: vi.fn(() => options.create ?? Promise.resolve('new-session')),
      retain: vi.fn(() => ({ ready: options.ready ?? Promise.resolve(), release })),
      binding: vi.fn(() => binding),
    },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [
      { workspaceId: 'current-workspace', sessionIds: ['old-session'], createdAt: '2026-01-01T00:00:00Z' },
      { workspaceId: 'other-workspace', sessionIds: ['other-session'], createdAt: '2026-02-01T00:00:00Z' },
    ] }) } },
    conversation: { input: { requestDraftInitialization: vi.fn(() => options.initialization ?? 'applied') } },
    uiWorkspace: { openSession: vi.fn() },
    layout: { beginNavigation: vi.fn(() => navigation.signal), selectPanel: vi.fn() },
  }
  if (options.surface !== false) disposers.push(registerDesktopPetSurface(window, surface))
  const dispose = installDesktopPetBridge(window, services)
  disposers.push(dispose)
  return { services, bridge: desktop.__lumoDesktopPet!, navigation, surface, binding, release, dispose }
}

describe('桌宠工作台握手', () => {
  it('过期的原生排队请求不会创建对话', () => {
    const { bridge, services } = mount()
    expect(bridge.open({ id: 'expired', target: 'chat', draft: 'keep', expiresAt: Date.now() - 1 }).accepted).toBe(false)
    expect(services.sessions.create).not.toHaveBeenCalled()
  })

  it('原生回执与取消均迟到时，过期的异步创建不会带入草稿', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const create = deferred<string>()
    const { bridge, services } = mount({ create: create.promise })
    expect(bridge.open({ id: 'deadline', target: 'chat', draft: 'keep', expiresAt: now + 8000 }).accepted).toBe(true)
    clock.mockReturnValue(now + 8000)
    create.resolve('new-session')
    await settle()
    expect(bridge.result('deadline').state).toBe('rejected')
    expect(services.sessions.retain).not.toHaveBeenCalled()
    expect(services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled()
  })
  it('普通浏览器不安装桌面桥', () => {
    const stop = installDesktopPetBridge(window, {} as DesktopPetServices)
    expect(desktop.__lumoDesktopPet).toBeUndefined()
    stop()
  })

  it('创建独立对话并实际接收草稿后才确认，保留当前会话的草稿', async () => {
    const ready = deferred<void>()
    const { services, bridge, binding, surface, release } = mount({ ready: ready.promise })
    expect(bridge.open({ id: 'request-1', target: 'chat', draft: '  <idea>\n不自动发送  ' })).toEqual({ accepted: true })
    await settle()
    expect(bridge.result('request-1').state).toBe('pending')
    expect(services.sessions.create).toHaveBeenCalledWith({ workspaceId: 'current-workspace' })
    expect(services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled()
    ready.resolve()
    await settle()
    expect(services.conversation.input.requestDraftInitialization).toHaveBeenCalledWith(binding, { prompt: '  <idea>\n不自动发送  ', whenDraftExists: 'keep' })
    expect(services.uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(surface).toHaveBeenCalledWith('home')
    expect(bridge.result('request-1')).toEqual({ state: 'accepted' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('新建空对话不更改任何草稿', async () => {
    const { bridge, services } = mount()
    bridge.open({ id: 'empty', target: 'chat', draft: '' })
    await settle()
    expect(bridge.result('empty')).toEqual({ state: 'accepted' })
    expect(services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled()
  })

  it.each(['preserved', 'blocked'] as const)('宿主返回 %s 时拒绝确认，桌宠可继续保留草稿', async initialization => {
    const { bridge, services, release } = mount({ initialization })
    bridge.open({ id: 'refused', target: 'chat', draft: 'idea' })
    await settle()
    expect(bridge.result('refused').state).toBe('rejected')
    expect(services.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('超时取消后，迟到的创建结果不能写入草稿或切换会话', async () => {
    const create = deferred<string>()
    const { bridge, services } = mount({ create: create.promise })
    bridge.open({ id: 'late', target: 'chat', draft: 'keep me' })
    expect(bridge.cancel('late').state).toBe('rejected')
    create.resolve('new-session')
    await settle()
    expect(services.sessions.retain).not.toHaveBeenCalled()
    expect(services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled()
    expect(services.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(bridge.result('late').state).toBe('rejected')
  })

  it('先到达的取消阻止迟到的open复活；已接受请求取消仍返回成功', async () => {
    const { bridge, services } = mount()
    expect(bridge.cancel('cancel-before-open').state).toBe('rejected')
    expect(bridge.open({ id: 'cancel-before-open', target: 'chat', draft: 'late' }).accepted).toBe(false)
    expect(services.sessions.create).not.toHaveBeenCalled()
    bridge.open({ id: 'accepted', target: 'home', draft: '' })
    await settle()
    expect(bridge.cancel('accepted')).toEqual({ state: 'accepted' })
  })

  it('用户后续导航优先，释放保留引用并停止原请求', async () => {
    const ready = deferred<void>()
    const { bridge, services, navigation, release } = mount({ ready: ready.promise })
    bridge.open({ id: 'superseded', target: 'chat', draft: 'idea' })
    await settle()
    navigation.abort()
    ready.resolve()
    await settle()
    expect(bridge.result('superseded').state).toBe('rejected')
    expect(services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('重复请求幂等，冲突请求和并发请求均拒绝入队', async () => {
    const create = deferred<string>()
    const { bridge, services } = mount({ create: create.promise })
    const request = { id: 'same', target: 'chat', draft: 'idea' }
    expect(bridge.open(request)).toEqual({ accepted: true })
    expect(bridge.open(request)).toEqual({ accepted: true })
    expect(bridge.open({ ...request, draft: 'other' }).accepted).toBe(false)
    expect(bridge.open({ ...request, id: 'different' }).accepted).toBe(false)
    expect(services.sessions.create).toHaveBeenCalledOnce()
    create.resolve('new-session')
    await settle()
    expect(bridge.open(request)).toEqual({ accepted: true })
    expect(services.sessions.create).toHaveBeenCalledOnce()
  })

  it('任务和主页只切换视图，界面未挂载时拒绝确认', async () => {
    const { bridge, services, surface } = mount()
    bridge.open({ id: 'tasks', target: 'tasks', draft: '' })
    await settle()
    expect(services.layout.selectPanel).toHaveBeenCalledWith(null)
    expect(surface).toHaveBeenCalledWith('tasks')
    expect(bridge.result('tasks')).toEqual({ state: 'accepted' })
    expect(services.sessions.create).not.toHaveBeenCalled()
    const absent = mount({ surface: false })
    // Simulate a loader replay after the old overlay has unmounted.
    for (const dispose of disposers.splice(0, 1)) dispose()
    absent.bridge.open({ id: 'absent', target: 'home', draft: '' })
    await settle()
    expect(absent.bridge.result('absent').state).toBe('rejected')
  })

  it('无工作区时给出可恢复错误，不创建无归属会话', async () => {
    const { bridge, services } = mount()
    services.workspaces.list.getSnapshot = () => ({ phase: 'ready', items: [] })
    bridge.open({ id: 'no-workspace', target: 'chat', draft: 'idea' })
    await settle()
    expect(bridge.result('no-workspace').error).toContain('添加工作区')
    expect(services.sessions.create).not.toHaveBeenCalled()
  })

  it('无当前会话时继承最近活动的工作区', async () => {
    const { bridge, services } = mount()
    services.sessions.list.getSnapshot = () => ({ phase: 'ready', byId: { 'other-session': { updatedAt: Date.parse('2026-03-01T00:00:00Z') } } })
    bridge.open({ id: 'recent', target: 'chat', draft: '' })
    await settle()
    expect(services.sessions.create).toHaveBeenCalledWith({ workspaceId: 'other-workspace' })
  })

  it('服务卸载取消待处理请求，旧 disposer 不能移除新版桥', async () => {
    const create = deferred<string>()
    const first = mount({ create: create.promise })
    first.bridge.open({ id: 'first', target: 'chat', draft: 'idea' })
    const second = mount()
    first.dispose()
    create.resolve('new-session')
    await settle()
    expect(first.bridge.result('first').state).toBe('rejected')
    expect(first.services.conversation.input.requestDraftInitialization).not.toHaveBeenCalled()
    expect(desktop.__lumoDesktopPet).toBe(second.bridge)
  })

  it.each([null, {}, { id: '../bad', target: 'home', draft: '' }, { id: 'bad', target: 'execute', draft: '' }, { id: 'bad', target: 'tasks', draft: 'private' }, { id: 'bad', target: 'chat', draft: 'a'.repeat(12001) }])('拒绝非法请求 %j', value => {
    const { bridge, services } = mount()
    expect(bridge.open(value).accepted).toBe(false)
    expect(services.sessions.create).not.toHaveBeenCalled()
  })
})
