// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomEvents } from '../../acp-engines/src/role-room-events.ts'
import type { RoomView } from '../../acp-engines/src/role-room-model.ts'
import { AcpSessionPanel } from '../src/client/acp-session-panel.tsx'
import { RoleRoomConversation } from '../src/client/role-room-conversation.tsx'
import { useRoleRooms } from '../src/client/use-role-rooms.ts'

const identity = { realm: 'test', userId: 'owner' }
const session = { ...identity, id: 'session-one', cwd: '/fixture', engineId: 'claude-code', state: 'idle' }
const initial: RoomView = { ...identity, id: 'team', name: 'Mixed team', cwd: '/fixture', revision: 1, coordinatorId: 'writer', createdAt: '2026-11-28T00:00:00Z', busy: false, turns: [], sessionStates: {}, roles: [
  { id: 'writer', name: 'Claude 作者', engineId: 'claude-code', instruction: 'Write' },
  { id: 'reviewer', name: 'Codex 评审', engineId: 'codex', instruction: 'Review' },
] }
const connected: RoomView = { ...initial, revision: 2, busy: true, roles: initial.roles.map((role, index) => ({ ...role, sessionId: `session-${index}` })), sessionStates: { writer: 'running', reviewer: 'idle' } }
class Source {
  static instances: Source[] = []
  handlers = new Map<string, (e: { data: string; lastEventId: string }) => void>()
  constructor(readonly url: string) { Source.instances.push(this) }
  addEventListener(type: string, listener: (e: { data: string; lastEventId: string }) => void) { this.handlers.set(type, listener) }
  emit(type: string, value: unknown) { this.handlers.get(type)?.({ data: JSON.stringify(value), lastEventId: '' }) }
  close() {}
}
let container: HTMLDivElement, root: Root
const buttons = (name: string) => [...container.querySelectorAll('button')].filter(button => (button.getAttribute('aria-label') ?? button.textContent) === name)
const directory = () => container.querySelector<HTMLInputElement | HTMLSelectElement>('[aria-label="工作区目录"], [aria-label="选择项目"]')!
function GroupHarness() {
  const state = useRoleRooms()
  return state.room ? <RoleRoomConversation room={state.room} asks={state.asks} busy={state.busy} connectRole={vi.fn()} send={vi.fn()} action={vi.fn()} answer={vi.fn()} /> : null
}
beforeEach(() => { localStorage.clear(); Source.instances = []; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', Source); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('live conversation identity and project state', () => {
  it('updates mixed-group member links from real server deltas and removes released session references', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/rooms?') ? { identity, rooms: [initial] } : path.includes('/rooms/team') ? { identity, room: initial } : path.includes('/asks') ? { asks: [] } : { engines: [] })))
    await act(async () => root.render(<GroupHarness />)); await act(async () => buttons('群组成员')[0]!.click())
    expect(buttons('连接工具与模型')).toHaveLength(2)
    const events = new RoomEvents()
    const detach = events.subscribe(initial, 1, event => Source.instances[0]!.emit(event.type, event.type === 'room.changed' ? { identity, change: event.change } : { identity, room: event.room }))
    await act(async () => events.publish(connected))
    expect(buttons('查看成员会话')).toHaveLength(2); expect(buttons('连接工具与模型')).toHaveLength(0)
    await act(async () => events.publish({ ...connected, revision: 3, roles: initial.roles, sessionStates: { writer: 'missing', reviewer: 'missing' } }))
    expect(buttons('查看成员会话')).toHaveLength(0); expect(buttons('连接工具与模型')).toHaveLength(2)
    detach()
  })

  it('accepts an authoritative snapshot at the current delta revision and associates pending permission with its member', async () => {
    let latest = initial
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/rooms?') ? { identity, rooms: [latest] } : path.includes('/rooms/team') ? { identity, room: latest } : path.includes('/asks') ? { asks: latest === initial ? [] : [{ id: 'permission', title: 'Write fixture', source: { session_ref: 'session-0' }, options: [{ id: 'allow', label: '允许一次' }] }] } : { engines: [] })))
    await act(async () => root.render(<GroupHarness />)); await act(async () => buttons('群组成员')[0]!.click())
    latest = connected
    // Legacy servers send a compact delta without role session IDs, followed by refresh.
    await act(async () => Source.instances[0]!.emit('room.changed', { identity, change: { id: 'team', revision: 2, busy: true, sessionStates: connected.sessionStates, refresh: true } }))
    expect(buttons('查看成员会话')).toHaveLength(2)
    expect(container.querySelector('[aria-label="角色权限请求"]')?.textContent).toContain('Write fixture'); expect(container.querySelector('.lumo-permission-source')?.textContent).toBe('Claude 作者')
    expect(buttons('允许一次')).toHaveLength(1)
    latest = initial
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(buttons('查看成员会话')).toHaveLength(2)
  })

  it('restores the attached project into a persisted settings panel without replacing an edited directory on streamed updates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.endsWith('/engines') ? { engines: [{ id: 'claude-code', label: 'Claude', available: true }] } : path === '/lumo/api/acp/sessions' ? { identity, sessions: [session] } : path.includes('/asks') ? { asks: [] } : path.includes('/history') ? { events: [], seq: 0, hasMore: false } : { session })))
    await act(async () => root.render(<AcpSessionPanel initialSessionId={session.id} />)); await act(async () => buttons('会话设置')[0]!.click())
    expect(directory().value).toBe('/fixture')
    await act(async () => root.render(<div />)); await act(async () => root.render(<AcpSessionPanel initialSessionId={session.id} />))
    expect(container.querySelector('aside[aria-label="会话设置"]')).not.toBeNull(); expect(directory().value).toBe('/fixture')
    await act(async () => buttons('编辑项目路径')[0]!.click())
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(directory(), '/next-project'); directory().dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => Source.instances.at(-1)!.emit('hello', { session: { ...session, title: 'Updated title' } }))
    expect(directory().value).toBe('/next-project')
  })
})
