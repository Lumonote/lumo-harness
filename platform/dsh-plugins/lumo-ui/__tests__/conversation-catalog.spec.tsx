// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationCatalog } from '../src/client/conversation-catalog.tsx'
import { installConversationHost, manageNativeConversation, useNativeHistory, type ConversationHost } from '../src/client/conversation-host.ts'
import { registerNativeSurface } from '../src/client/surface-navigation.ts'
import { takeAgentRoom, takeAgentSession } from '../src/client/agent-navigation.ts'
import { scopeKey } from '../src/client/acp-session-state.ts'

const disposers: Array<() => void> = []
const identity = { realm: 'local', userId: 'owner' }
const nativeRow = { id: 'same-id', displayTitle: '原生任务', cwd: '/work/app', updatedAt: 10, running: false, retainedBy: { mainView: 1 } }
function host(name = nativeRow.displayTitle) {
  const listeners = new Set<() => void>()
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  const rename = vi.fn(async () => ({ ok: true })), released = vi.fn()
  const source: ConversationHost = {
    sessions: { list: { getSnapshot: () => ({ ids: ['same-id'], byId: { 'same-id': { ...nativeRow, displayTitle: name } }, phase: 'ready' }), subscribe }, refresh: vi.fn(async () => {}),
      search: vi.fn(async () => ({ ok: true, value: { items: [], hasMore: false } })),
      using: async (_id, _options, run) => { try { return await run({ ready: Promise.resolve({ session: { rename } }) }) } finally { released() } },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'empty', path: '/work/empty', title: '空项目' }], archivedSessionIds: [], pinnedSessionIds: [] }), subscribe }, create: vi.fn(async () => ({ workspaceId: 'created' })) },
    uiWorkspace: { openSession: vi.fn(), startSession: vi.fn(), archiveSession: vi.fn(async () => {}), unarchiveSession: vi.fn(async () => {}), pinSession: vi.fn(async () => {}), unpinSession: vi.fn(async () => {}), pickDirectory: vi.fn(async () => '/chosen') },
    layout: { selectPanel: vi.fn() },
  }
  return { source, listeners, rename, released }
}
function install(source: ConversationHost) { const off = installConversationHost(source); disposers.push(off); return off }
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/rooms') ? { identity, rooms: [{ id: 'same-id', name: '团队任务', cwd: '/work/app', busy: false }] } : { identity, sessions: [{ ...identity, id: 'same-id', title: '外部任务', cwd: '/work/app/', state: 'idle', engineId: 'claude-code' }] }))) })
afterEach(() => { cleanup(); disposers.splice(0).reverse().forEach(off => off()); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('unified source-owned conversation directory', () => {
  it('groups by full path, retains empty native projects and routes colliding IDs to the right source', async () => {
    const { source } = host(); install(source)
    const open = vi.fn(); disposers.push(registerNativeSurface('agents', open))
    render(<ConversationCatalog wide expandSidebar={vi.fn()} />)
    const recent = within(screen.getByRole('navigation', { name: '最近对话记录' }))
    fireEvent.click(await recent.findByRole('button', { name: '打开对话 外部任务' }))
    expect(open).toHaveBeenCalled(); expect(takeAgentSession(scopeKey(identity))).toBe('same-id')
    fireEvent.click(recent.getByRole('button', { name: '打开群组 团队任务' })); expect(takeAgentRoom(scopeKey(identity))).toBe('same-id')
    fireEvent.click(recent.getByRole('button', { name: '打开对话 原生任务' })); expect(source.uiWorkspace.openSession).toHaveBeenCalledWith('same-id')
    expect(screen.getAllByRole('button', { name: '项目 /work/app' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '项目 /work/empty' }).textContent).toContain('空项目')
    fireEvent.click(screen.getByRole('button', { name: '开始对话' })); expect(source.uiWorkspace.startSession).toHaveBeenCalledWith('empty')
  })
  it('routes metadata changes to native services and releases the temporary session reference', async () => {
    const fixture = host(); install(fixture.source)
    await manageNativeConversation(fixture.source, 'same-id', { title: ' 新名字 ', pinned: true, archived: false })
    expect(fixture.rename).toHaveBeenCalledWith('新名字'); expect(fixture.released).toHaveBeenCalledOnce()
    expect(fixture.source.uiWorkspace.pinSession).toHaveBeenCalledWith('same-id'); expect(fixture.source.uiWorkspace.unarchiveSession).toHaveBeenCalledWith('same-id')
    install(host('另一个宿主').source)
    await expect(manageNativeConversation(fixture.source, 'same-id', { archived: true })).rejects.toThrow('连接已切换')
    expect(fixture.source.uiWorkspace.archiveSession).not.toHaveBeenCalled()
  })
  it('uses source-specific metadata payloads and does not modify native records', async () => {
    const fixture = host(); install(fixture.source); render(<ConversationCatalog wide expandSidebar={vi.fn()} />)
    const recent = within(screen.getByRole('navigation', { name: '最近对话记录' }))
    fireEvent.click(await recent.findByRole('button', { name: '管理 团队任务' })); fireEvent.click(recent.getByRole('button', { name: '重命名' }))
    fireEvent.change(recent.getByRole('textbox', { name: '对话名称' }), { target: { value: '团队新名' } }); fireEvent.click(recent.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/lumo/api/acp/rooms/same-id/metadata', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '团队新名' }) })))
    expect(fixture.rename).not.toHaveBeenCalled()
  })
  it('drops external rows immediately when the host changes and ignores a late directory response', async () => {
    install(host().source); render(<ConversationCatalog wide expandSidebar={vi.fn()} />)
    await screen.findAllByRole('button', { name: '打开对话 外部任务' })
    let resolve!: (value: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(done => { resolve = done }))
    act(() => { install(host('新的宿主').source) })
    expect(screen.queryByRole('button', { name: '打开对话 外部任务' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '打开对话 新的宿主' })).toHaveLength(2)
    cleanup(); resolve(Response.json({ identity, rooms: [] }))
  })
  it('does not create a project after the host changes during the native picker', async () => {
    const fixture = host(); install(fixture.source)
    let choose!: (value: string) => void
    vi.mocked(fixture.source.uiWorkspace.pickDirectory).mockReturnValue(new Promise(resolve => { choose = resolve }))
    render(<ConversationCatalog wide expandSidebar={vi.fn()} />); fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
    act(() => { install(host('second').source) }); await act(async () => choose('/chosen'))
    expect(fixture.source.workspaces.create).not.toHaveBeenCalled()
  })
  it('keeps native navigation usable when ACP is unavailable', async () => {
    install(host().source); vi.mocked(fetch).mockResolvedValue(Response.json({ error: 'unavailable' }, { status: 501 }))
    render(<ConversationCatalog wide expandSidebar={vi.fn()} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: '多工具对话与群组' })).toBeNull())
    expect(screen.getAllByRole('button', { name: '打开对话 原生任务' })).toHaveLength(2)
  })
  it('rejects late native full-text search results from the previous host and unsubscribes', async () => {
    vi.useFakeTimers(); const first = host('old'), second = host('new'); install(first.source)
    let resolve!: (value: unknown) => void
    vi.mocked(first.source.sessions.search).mockImplementation(() => new Promise(done => { resolve = done as never }))
    function History() { const state = useNativeHistory('body-only'); return <div>{state.entries.map(entry => entry.displayTitle).join(',')}</div> }
    const view = render(<History />); await act(async () => vi.advanceTimersByTime(210))
    act(() => { install(second.source) }); await act(async () => { resolve({ ok: true, value: { items: [{ sessionId: 'same-id' }], hasMore: false } }); vi.advanceTimersByTime(210) })
    expect(view.container.textContent).toBe(''); expect(first.listeners.size).toBe(0)
    cleanup(); expect(second.listeners.size).toBe(0)
  })
})
