// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatHistory, useAgentSessionHistory } from '../src/client/agent-chat-history.tsx'
import { scopeKey, type SessionView } from '../src/client/acp-session-state.ts'
import { AcpSessionPanel } from '../src/client/acp-session-panel.tsx'

const identity = { realm: 'local', userId: 'owner' }
const rooms = [{ id: 'team', name: '代码团队', cwd: '/work/app', busy: false, updatedAt: '2026-11-28T10:00:00Z', engineIds: ['codex'] }]
const sessions: SessionView[] = [
  { ...identity, id: 'older', engineId: 'codex', title: '旧记录', cwd: '/work/app/', state: 'idle', createdAt: '2026-11-27T00:00:00Z' },
  { ...identity, id: 'latest', engineId: 'claude-code', title: '当前任务', cwd: '/other/app', state: 'detached', createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-28T11:00:00Z' },
  { ...identity, id: 'member', engineId: 'codex', title: '隐藏的内部成员', cwd: '/work/app', state: 'idle', room: { id: 'team', name: '代码团队', roleId: 'coder', roleName: '开发' } },
  { ...identity, id: 'provisional', engineId: 'codex', title: '正在初始化的内部成员', cwd: '/work/app', state: 'starting' },
]
let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('project and recent conversation navigation', () => {
  it('shows activity time instead of projects in recent chats and refreshes time without a reload', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-28T11:00:30Z'))
    await act(async () => root.render(<AgentChatHistory rooms={rooms} sessions={[...sessions, { ...sessions[0]!, id: 'undated', title: '无时间记录', createdAt: undefined }]} query="" selected="" disabled={false} openRoom={vi.fn()} openSession={vi.fn()} />))
    const recent = container.querySelector('[aria-label="最近对话记录"]')!
    expect([...recent.querySelectorAll('small')].map(el => el.textContent)).toEqual(['刚刚', '1 小时前', '1 天前', '时间未知'])
    expect(recent.textContent).not.toContain('app')
    expect([...recent.querySelectorAll('button')].some(el => el.title.includes('/work/'))).toBe(false)
    expect(recent.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-28T11:00:00Z')
    expect(container.querySelector('[aria-label="项目 /work/app"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(recent.querySelector('time')?.textContent).toBe('1 分钟前')
  })
  it('groups mixed chats by full project path, sorts recent activity, and supports collapse, search and direct selection', async () => {
    const openRoom = vi.fn(), openSession = vi.fn()
    const render = (query = '') => root.render(<AgentChatHistory rooms={rooms} sessions={sessions} query={query} selected="session:latest" disabled={false} openRoom={openRoom} openSession={openSession} />)
    await act(async () => render())
    const project = (path: string) => container.querySelector<HTMLButtonElement>(`[aria-label="项目 ${path}"]`)!
    expect(project('/work/app').textContent).toContain('2'); expect(project('/other/app').textContent).toContain('1')
    const recent = container.querySelector('[aria-label="最近对话记录"]')!
    expect([...recent.querySelectorAll('b')].map(el => el.textContent)).toEqual(['当前任务', '代码团队', '旧记录'])
    expect(container.textContent).not.toContain('隐藏的内部成员')
    expect(container.textContent).not.toContain('正在初始化的内部成员')
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="打开对话 当前任务"]')!.click()); expect(openSession).toHaveBeenCalledWith('latest')
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="打开群组 代码团队"]')!.click()); expect(openRoom).toHaveBeenCalledWith('team')
    await act(async () => project('/work/app').click()); expect(container.querySelector('[aria-label="/work/app 的对话"]')).toBeNull()
    await act(async () => render('/work/app'))
    expect(container.querySelector('[aria-label="/work/app 的对话"]')).not.toBeNull(); expect(container.textContent).not.toContain('当前任务')
  })
  it('ignores a late session list after switching identity', async () => {
    let done!: (value: Response) => void
    const other = { ...identity, userId: 'other' }
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { done = resolve })).mockResolvedValue(Response.json({ identity: other, sessions: [] })))
    function Harness({ user }: { user: string }) { const state = useAgentSessionHistory(scopeKey({ ...identity, userId: user })); return <div>{state.sessions.map(s => s.title).join(',')}</div> }
    await act(async () => root.render(<Harness user="owner" />)); await act(async () => root.render(<Harness user="other" />))
    await act(async () => done(Response.json({ identity, sessions })))
    expect(container.textContent).toBe('')
  })
  it('opens detached history without starting an engine or sending a prompt', async () => {
    const entry = sessions[1]!
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
    const request = vi.fn(async (url: string) => Response.json(url.endsWith('/engines') ? { engines: [{ id: 'claude-code', label: 'Claude', available: true }] }
      : url.endsWith('/sessions') ? { identity, sessions: [entry] } : url.includes('/asks') ? { asks: [] } : { session: { ...entry, historyOnly: true } }))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<AcpSessionPanel initialSessionId="latest" hideHistory />))
    expect(request.mock.calls.some(([url]) => url.endsWith('/latest/attach'))).toBe(true)
    expect(request.mock.calls.some(([url]) => url.endsWith('/prompt'))).toBe(false)
    expect(request.mock.calls.some(([url]) => url.endsWith('/resume'))).toBe(false)
    expect(container.querySelector('[aria-label="发送给引擎"]')).toBeNull()
  })
})
