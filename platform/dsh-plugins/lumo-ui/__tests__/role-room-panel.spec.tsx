// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoleRoomCreate } from '../src/client/role-room-create.tsx'
import { RoleRoomConversation } from '../src/client/role-room-conversation.tsx'
import { RoleRoomSurface } from '../src/client/role-room-surface.tsx'
import { availableSurfaces, navigationSurfaces, querySurface } from '../src/client/surface-navigation.ts'
import type { RoomView } from '../../acp-engines/src/role-room-model.ts'

const engines = [{ id: 'claude-code', label: 'Claude Code', protocol: 'acp', available: true }, { id: 'codex', label: 'Codex', protocol: 'codex-app-server', available: true }]
const room: RoomView = { id: 'room', name: '个人团队', cwd: '/workspace', realm: 'local', userId: 'me', createdAt: '2026-11-26T00:00:00Z', coordinatorId: 'assistant', busy: false,
  sessionStates: { assistant: 'idle', engineer: 'idle' }, roles: [{ id: 'assistant', name: '助理', engineId: 'claude-code', instruction: '汇总', sessionId: 's1' }, { id: 'engineer', name: '工程师', engineId: 'codex', instruction: '实现', sessionId: 's2' }], turns: [] }
let container: HTMLDivElement, root: Root
const button = (text: string) => [...container.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === text)!
const field = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
const change = async (label: string, value: string) => act(async () => {
  const input = field(label)
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); history.replaceState({}, '', '/') })

describe('role creation and multi-engine conversation', () => {
  it('creates configurable roles with independent engine choices and a chosen coordinator', async () => {
    const create = vi.fn(async () => true)
    await act(async () => root.render(<RoleRoomCreate engines={engines} busy={false} create={create} />))
    await change('协作工作区目录', '/workspace'); await change('角色 1 名称', '我的助理'); await change('角色 3 引擎', 'codex')
    await change('协调助理', 'reviewer')
    await act(async () => button('创建协作房间').click())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace', coordinatorId: 'reviewer', roles: [expect.objectContaining({ name: '我的助理', engineId: 'claude-code' }), expect.objectContaining({ engineId: 'codex' }), expect.objectContaining({ engineId: 'codex' })] }))
  })
  it('preserves the request id and draft after a lost response; a later distinct message gets a new id', async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    await act(async () => root.render(<RoleRoomConversation room={room} asks={[]} busy={false} send={send} action={vi.fn()} answer={vi.fn()} />))
    await change('协作消息输入', '请一起检查'); await change('对话方式', 'direct'); await change('发送给角色', 'engineer')
    await act(async () => button('发送协作消息').click()); expect(field('协作消息输入').value).toBe('请一起检查')
    await act(async () => button('发送协作消息').click()); expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]); expect(send.mock.calls[0]![0]).toMatchObject({ mode: 'direct', targetRoleId: 'engineer' })
    await change('协作消息输入', '继续'); await act(async () => button('发送协作消息').click())
    expect(send.mock.calls[2]![0].id).not.toBe(send.mock.calls[0]![0].id)
  })
  it('switches tools through mentions, respects IME and Shift+Enter, and renders native markdown', async () => {
    const send = vi.fn(async () => true)
    const previous = { ...room, turns: [{ id: 'first', text: '你好', mode: 'direct' as const, targetRoleId: 'assistant', state: 'completed' as const, createdAt: room.createdAt, steps: [{ roleId: 'assistant', purpose: 'reply' as const, state: 'completed' as const, text: '**分析**\n\n- 检查实现\n- 验证结果' }] }] }
    await act(async () => root.render(<RoleRoomConversation room={previous} asks={[]} busy={false} send={send} action={vi.fn()} answer={vi.fn()} />))
    expect(container.querySelector('.lumo-role-reply strong')?.textContent).toBe('助理')
    expect(container.querySelectorAll('.lumo-role-reply li')).toHaveLength(2)
    await change('协作消息输入', '@工程师 继续实现')
    expect(field('发送给角色').value).toBe('engineer'); expect(field('协作消息输入').value).toBe('继续实现')
    const enter = async (options: KeyboardEventInit) => act(async () => field('协作消息输入').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options })))
    await enter({ isComposing: true }); await enter({ shiftKey: true }); expect(send).not.toHaveBeenCalled()
    await enter({}); expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '继续实现', targetRoleId: 'engineer', mode: 'direct' }))
  })
  it('keeps member controls secondary and saves the chosen group logo and color', async () => {
    const setAppearance = vi.fn(async () => true)
    await act(async () => root.render(<RoleRoomConversation room={room} asks={[]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} setAppearance={setAppearance} />))
    expect(container.querySelector('aside[aria-label="群组设置"]')).toBeNull()
    await act(async () => button('群组设置').click())
    await change('群组 Logo', 'bolt'); await change('群组颜色', '#ab1234')
    await act(async () => button('保存群组外观').click())
    expect(setAppearance).toHaveBeenCalledWith({ logo: 'bolt', color: '#ab1234' })
  })
  it('attributes actual replies and approvals to their role, and exposes cancellation while executing', async () => {
    const action = vi.fn(async () => true), answer = vi.fn(async () => true)
    const active = { ...room, busy: true, turns: [{ id: 't', text: '修复', mode: 'direct' as const, state: 'running' as const, createdAt: room.createdAt, targetRoleId: 'engineer', steps: [{ roleId: 'engineer', purpose: 'reply' as const, state: 'running' as const, text: '定位到缺陷' }] }] }
    await act(async () => root.render(<RoleRoomConversation room={active} asks={[{ id: 'ask', title: '编辑文件', status: 'pending', source: { session_ref: 's2' }, options: [{ id: 'allow', label: '允许一次' }] }]} busy={false} send={vi.fn()} action={action} answer={answer} />))
    expect(container.querySelector('[role="log"]')!.textContent).toContain('工程师codex')
    expect(container.querySelector('[aria-label="发送协作消息"]')).toBeNull(); expect(answer).not.toHaveBeenCalled()
    await act(async () => button('允许一次').click()); expect(answer).toHaveBeenCalledWith('ask', 'allow')
    await act(async () => button('停止协作').click()); expect(action).toHaveBeenCalledWith('stop')
  })
  it('loads persisted rooms without creating sessions or resending prompts', async () => {
    const request = vi.fn(async (url: string) => response(url.endsWith('/engines') ? { engines } : url.endsWith('/sessions') ? { sessions: [], identity: room } : url.split('?')[0]!.endsWith('/rooms') ? { rooms: [room], identity: room } : url.includes('/asks') ? { asks: [] } : { room, identity: room }))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<RoleRoomSurface onClose={vi.fn()} />))
    expect(container.textContent).toContain('个人团队'); expect(container.querySelector('[data-engine-logo="claude-code"]')).not.toBeNull()
    expect(request.mock.calls.every(([url]) => !/\/(attach|resume|prompt)$/u.test(url))).toBe(true)
  })
  it('applies persisted appearance to both the history and conversation after saving and refreshing', async () => {
    let saved = structuredClone(room)
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/appearance')) { saved = { ...saved, appearance: JSON.parse(init!.body as string) }; return response({ room: saved, identity: saved }) }
      return response(url.endsWith('/engines') ? { engines } : url.endsWith('/sessions') ? { sessions: [], identity: room } : url.split('?')[0]!.endsWith('/rooms') ? { rooms: [saved], identity: saved } : url.includes('/asks') ? { asks: [] } : { room: saved, identity: saved })
    })
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<RoleRoomSurface onClose={vi.fn()} />))
    await act(async () => button('群组设置').click()); await change('群组 Logo', 'bolt')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="橙色"]')!.click())
    await act(async () => button('保存群组外观').click())
    expect(saved.appearance).toEqual({ logo: 'bolt', color: '#dd7b28' })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(container.querySelector('.lumo-chat-header [data-room-logo]')?.getAttribute('data-room-logo')).toBe('bolt')
    expect(container.querySelector('.lumo-chat-history [data-room-logo]')?.getAttribute('data-room-logo')).toBe('bolt')
    expect(container.textContent).toContain('群组外观已保存')
  })
  it('clears the room and pending drafts when the trusted account changes on focus', async () => {
    let changed = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/engines') ? { engines } : url.endsWith('/sessions') ? { sessions: [], identity: room } : url.split('?')[0]!.endsWith('/rooms') ? { rooms: changed ? [] : [room], identity: { ...room, userId: changed ? 'other' : room.userId } } : url.includes('/asks') ? { asks: [] } : { room, identity: room })))
    await act(async () => root.render(<RoleRoomSurface onClose={vi.fn()} />))
    await change('协作消息输入', 'private draft')
    changed = true; await act(async () => window.dispatchEvent(new Event('focus')))
    expect(container.textContent).not.toContain('个人团队'); expect(container.querySelector('[aria-label="协作消息输入"]')).toBeNull()
  })
  it('exposes the role room entry only in local deployment', () => {
    expect(availableSurfaces(true)).toContain('agents'); expect(availableSurfaces(false)).not.toContain('agents')
    history.replaceState({}, '', '/?lumo=agents'); expect(querySurface()).toBe('agents')
  })
  it.each([true, false])('keeps creative surfaces reachable by slash commands but out of both sidebar menus (local=%s)', local => {
    expect(navigationSurfaces(local)).not.toContain('design'); expect(navigationSurfaces(local)).not.toContain('presentation')
    expect(availableSurfaces(local)).toContain('design'); expect(availableSurfaces(local)).toContain('presentation')
    history.replaceState({}, '', '/?lumo=design'); expect(querySurface()).toBe('design')
    history.replaceState({}, '', '/?lumo=presentation'); expect(querySurface()).toBe('presentation')
  })
})
