// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoleRoomConversation } from '../src/client/role-room-conversation.tsx'
import { AcpSessionPanel } from '../src/client/acp-session-panel.tsx'
import { AgentChatDock, type ChatPanel } from '../src/client/agent-chat-dock.tsx'
import type { PromptContext } from '../../acp-engines/src/prompt-context.ts'
import type { RoomView } from '../../acp-engines/src/role-room-model.ts'

const identity = { realm: 'local', userId: 'test' }
const session = { ...identity, id: 's1', engineId: 'codex', cwd: '/project', state: 'idle' }
const room: RoomView = { ...identity, id: 'room', name: 'Team', cwd: '/project', coordinatorId: 'assistant', createdAt: '2026-11-28T00:00:00Z', busy: false,
  sessionStates: { assistant: 'idle', coder: 'new' }, turns: [], roles: [
    { id: 'assistant', name: '助理', engineId: 'claude-code', instruction: '协调', sessionId: 's1' },
    { id: 'coder', name: '开发', engineId: 'codex', instruction: '实现' },
  ] }
const skills = [{ name: 'review', description: 'Review code' }]
const files = [{ path: 'src', name: 'src', directory: true }, { path: 'README.md', name: 'README.md', directory: false }]
class Source {
  static current: Source
  handlers = new Map<string, (event: { data: string; lastEventId: string }) => void>()
  constructor() { Source.current = this }
  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void) { this.handlers.set(type, listener) }
  close() {}
  emit(data: unknown, seq: string) { this.handlers.get('session')?.({ data: JSON.stringify({ sessionId: 's1', ...data as object }), lastEventId: seq }) }
}
let container: HTMLDivElement, root: Root
const button = (label: string) => [...container.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === label)!
const field = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
const click = (label: string) => act(async () => button(label).click())
const change = (label: string, value: string) => act(async () => {
  const el = field(label)
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
})
const mockApi = () => {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/skills')) return Response.json({ complete: true, skills })
    if (path.includes('/files?')) return Response.json({ files: path.includes('src%2F') ? [{ path: 'src/App.tsx', name: 'App.tsx', directory: false }] : files })
    if (path.endsWith('/engines')) return Response.json({ engines: [{ id: 'codex', label: 'Codex', available: true }] })
    if (path.endsWith('/sessions') && init?.method !== 'POST') return Response.json({ identity, sessions: [session] })
    if (path.endsWith('/attach')) return Response.json({ session })
    if (path.includes('/asks')) return Response.json({ asks: [] })
    return Response.json({ ok: true })
  })
  vi.stubGlobal('fetch', request); return request
}
const renderRoom = (value = room, props: Partial<Parameters<typeof RoleRoomConversation>[0]> = {}) => act(async () => root.render(<RoleRoomConversation room={value} asks={[]} busy={false} send={vi.fn(async () => true)} action={vi.fn()} answer={vi.fn()} {...props} />))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', Source)
  localStorage.clear(); sessionStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('conversation right-side tools', () => {
  it('browses folders, loads skills, mentions a member and sends the selected context in a real room action', async () => {
    const request = mockApi(), send = vi.fn(async () => true)
    await renderRoom(room, { send })
    expect(request).not.toHaveBeenCalled()
    await click('项目文件'); await click('打开目录 src'); await click('引用文件 src/App.tsx')
    expect(field('移除文件引用 src/App.tsx')).not.toBeNull()
    await click('返回上级目录'); expect(button('打开目录 src')).toBeDefined()
    await click('Skill'); await change('搜索 Skill', 'review'); await click('加载 Skill review')
    await act(async () => field('搜索 Skill').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('aside[aria-label="Skill"]')).toBeNull(); expect(document.activeElement).toBe(button('Skill'))
    await click('群组成员'); await click('提及 开发')
    expect(field('发送给角色').value).toBe('coder'); expect(document.activeElement).toBe(field('协作消息输入'))
    await change('协作消息输入', '检查实现'); await click('发送协作消息')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '检查实现', targetRoleId: 'coder', files: ['src/App.tsx'], skills: ['review'] }))
    expect(container.querySelector('.lumo-chat-composer .lumo-chat-context-chip')).toBeNull()
  })
  it('aborts old file listings and clears the selected context when switching rooms', async () => {
    let finish!: (response: Response) => void, signal!: AbortSignal
    const request = vi.fn((path: string, init?: RequestInit) => path.includes('/room/') ? new Promise<Response>(resolve => { finish = resolve; signal = init!.signal as AbortSignal }) : Promise.resolve(Response.json({ files: [] })))
    vi.stubGlobal('fetch', request)
    await renderRoom(); await click('项目文件')
    await renderRoom({ ...room, id: 'second', cwd: '/second' })
    expect(signal.aborted).toBe(true); expect(container.querySelector('aside[aria-label="项目文件"]')).toBeNull()
    await act(async () => finish(Response.json({ files: [{ path: 'secret.md', name: 'secret.md', directory: false }] })))
    await click('项目文件'); expect(container.textContent).not.toContain('secret.md'); expect(container.textContent).toContain('此目录没有可引用的文件')
    expect(request.mock.calls.at(-1)![0]).toContain('/rooms/second/files')
  })
  it('supports recovery after a failed directory request and enforces context limits without losing selections', async () => {
    let fails = true
    vi.stubGlobal('fetch', vi.fn(async () => fails ? Response.json({ error: '目录暂不可用' }, { status: 503 }) : Response.json({ complete: true, skills: Array.from({ length: 5 }, (_, i) => ({ name: `skill-${i}`, description: 'description' })) })))
    function Harness() {
      const [panel, setPanel] = useState<ChatPanel>('skills'), [value, setValue] = useState<PromptContext>({})
      return <AgentChatDock panel={panel} onPanel={setPanel} scopePath="/rooms/r" cwd="/project" context={value} setContext={setValue} disabled={false} activity={null} settings={null} settingsLabel="设置" />
    }
    await act(async () => root.render(<Harness />)); expect(container.textContent).toContain('目录暂不可用')
    fails = false; await click('重试')
    for (let i = 0; i < 5; i++) await click(`加载 Skill skill-${i}`)
    expect(container.textContent).toContain('每条消息最多选择 4 个 Skill')
    expect(button('加载 Skill skill-4').getAttribute('aria-pressed')).toBe('false')
    await click('移除 Skill skill-1'); await click('加载 Skill skill-4')
    expect(button('移除 Skill skill-4').getAttribute('aria-pressed')).toBe('true')
    await change('搜索 Skill', 'missing'); expect(container.textContent).toContain('没有匹配项')
  })
  it('locates actual replies and pending approvals, and keeps model/connection controls in the members panel', async () => {
    mockApi()
    const connectRole = vi.fn(), setModel = vi.fn(), answer = vi.fn()
    const active: RoomView = { ...room, sessionModels: { assistant: { source: 'legacy', currentModelId: 'fast', availableModels: [{ id: 'fast', name: 'Fast' }, { id: 'deep', name: 'Deep' }] } },
      turns: [{ id: 't1', text: '检查代码', mode: 'direct', targetRoleId: 'assistant', state: 'completed', createdAt: room.createdAt, steps: [{ roleId: 'assistant', purpose: 'reply', text: '检查完毕', state: 'completed' }] }] }
    await renderRoom(active, { connectRole, setModel, answer, asks: [{ id: 'a', title: '编辑文件', status: 'pending', source: { session_ref: 's1' }, options: [{ id: 'yes', label: '允许一次' }] }] })
    await click('执行记录'); expect(container.querySelector('aside')!.textContent).toContain('1 项等待确认')
    await click('查看权限请求'); expect(document.activeElement).toBe(field('角色权限请求')); expect(answer).not.toHaveBeenCalled()
    await click('执行记录'); await act(async () => container.querySelector<HTMLButtonElement>('.lumo-dock-timeline button')!.click())
    expect(document.activeElement?.textContent).toContain('检查完毕'); expect(container.querySelector('aside[aria-label="执行记录"]')).toBeNull()
    await click('群组成员'); await change('助理 模型', 'deep'); expect(setModel).toHaveBeenCalledWith('assistant', 'deep')
    await click('连接工具与模型'); expect(connectRole).toHaveBeenCalledWith('coder')
    await click('关闭侧栏'); await click('允许一次'); expect(answer).toHaveBeenCalledWith('a', 'yes')
  })
  it('uses independent session context and follows live tool status without opening another session', async () => {
    const request = mockApi()
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" hideHistory />))
    await click('项目文件'); await click('引用文件 README.md'); await click('关闭侧栏')
    await change('发送给引擎', '检查文件'); await click('发送')
    expect(JSON.parse(request.mock.calls.find(([path]) => path.endsWith('/prompt'))![1]!.body as string)).toMatchObject({ text: '检查文件', files: ['README.md'] })
    await act(async () => Source.current.emit({ type: 'tool.call', toolCallId: 'tool-1', title: '读取 README', status: 'in_progress' }, '1'))
    await click('执行记录'); expect(container.querySelector('aside')!.textContent).toContain('执行中')
    await act(async () => Source.current.emit({ type: 'tool.update', toolCallId: 'tool-1', status: 'completed' }, '2'))
    expect(container.querySelector('aside')!.textContent).toContain('已完成')
    await act(async () => container.querySelector<HTMLButtonElement>('.lumo-dock-timeline button')!.click())
    expect(document.activeElement?.textContent).toContain('读取 README'); expect(container.querySelector('aside[aria-label="执行记录"]')).toBeNull()
    expect(request.mock.calls.filter(([path, init]) => path.endsWith('/sessions') && init?.method === 'POST')).toHaveLength(0)
  })
  it('keeps selection read-only during a running turn and hides mutation tools in member inspection', async () => {
    mockApi(); await renderRoom({ ...room, busy: true })
    await click('项目文件'); expect(button('引用文件 README.md').disabled).toBe(true)
    await click('打开目录 src'); expect(button('引用文件 src/App.tsx').disabled).toBe(true)
    await click('Skill'); expect(button('加载 Skill review').disabled).toBe(true)
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" readOnly />))
    expect(container.querySelector('nav[aria-label="对话工具"]')).toBeNull(); expect(field('发送给引擎')).toBeNull()
  })
})
