// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoleRoomConversation } from '../src/client/role-room-conversation.tsx'
import { RoleRoomCreate } from '../src/client/role-room-create.tsx'
import { AcpSessionPanel } from '../src/client/acp-session-panel.tsx'
import { AgentProjectPicker, installAgentProjectServices } from '../src/client/agent-project-picker.tsx'
import { reduceTranscript } from '../src/client/acp-session-state.ts'
import { AgentComposerInput } from '../src/client/agent-composer-input.tsx'
import type { PromptContext } from '../../acp-engines/src/prompt-context.ts'
import type { RoomView } from '../../acp-engines/src/role-room-model.ts'

const scope = { realm: 'r', userId: 'u' }
const room: RoomView = { ...scope, id: 'room', name: 'Team', cwd: '/first', coordinatorId: 'assistant', createdAt: '2026-11-28T00:00:00Z', busy: false, sessionStates: {}, turns: [], roles: [
  { id: 'assistant', name: '助理', engineId: 'claude-code', instruction: '协调' }, { id: 'coder', name: '开发', engineId: 'codex', instruction: '实现' },
] }
const file = { id: 'a'.repeat(64), name: 'notes.md', mimeType: 'text/markdown', size: 5 }
const engines = [{ id: 'claude-code', label: 'Claude', protocol: 'acp', available: true }, { id: 'codex', label: 'Codex', protocol: 'acp', available: true }]
const session = { ...scope, id: 's1', engineId: 'claude-code', cwd: '/first', state: 'idle' }
let container: HTMLDivElement, root: Root, dispose: (() => void) | undefined
const button = (text: string) => [...container.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === text)!
const field = (label: string) => container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
const change = async (label: string, value: string) => act(async () => {
  const el = field(label), proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
})
const addFile = async (name = 'notes.md', mimeType = 'text/markdown') => act(async () => {
  Object.defineProperty(field('选择附件'), 'files', { configurable: true, value: [new File(['hello'], name, { type: mimeType })] })
  field('选择附件').dispatchEvent(new Event('change', { bubbles: true }))
})
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const mockProjects = (pickDirectory = vi.fn(async () => '/picked')) => {
  dispose = installAgentProjectServices({ workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w', title: 'Example project', path: '/second' }] }) } }, uiWorkspace: { pickDirectory } })
  return pickDirectory
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); dispose?.(); dispose = undefined; container.remove(); vi.unstubAllGlobals() })

describe('attachments and project context in AI conversations', () => {
  it('selects skills, members and project files with native menu keyboard interaction and never submits a menu pick', async () => {
    const send = vi.fn(), mention = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.endsWith('/skills')
      ? { complete: true, skills: [{ name: 'code-review', description: 'Review code' }] }
      : { files: path.includes('src%2F') ? [{ name: 'App.tsx', path: 'src/App.tsx', directory: false }] : [{ name: 'src', path: 'src', directory: true }] })))
    function Harness() {
      const [text, setText] = useState(''), [context, setContext] = useState<PromptContext>({})
      return <AgentComposerInput value={text} onChange={setText} label="input" disabled={false} scopePath="/lumo/api/acp/rooms/room" context={context} setContext={setContext} members={room.roles} mention={mention} commands={[]} send={() => send(text, context)} />
    }
    await act(async () => root.render(<Harness />))
    const key = (key: string, extra: KeyboardEventInit = {}) => act(async () => field('input').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })))
    const option = async (text: string) => { for (let i = 0; i < 10; i++) { await flush(); if (container.querySelector('[role="option"]')?.textContent?.includes(text)) return } expect(container.querySelector('[role="option"]')?.textContent).toContain(text) }
    await change('input', '/code'); await option('/code-review')
    await key('Enter', { isComposing: true }); expect(field('移除 Skill code-review')).toBeNull()
    await key('Enter'); expect(send).not.toHaveBeenCalled(); expect(field('input').value).toBe(''); expect(field('移除 Skill code-review')).not.toBeNull()
    await change('input', '@助'); await key('Tab'); expect(mention).toHaveBeenCalledWith('assistant'); expect(send).not.toHaveBeenCalled()
    await change('input', '@src'); await option('src/'); await key('Enter'); expect(field('input').value).toBe('@src/')
    await option('src/App.tsx')
    await key('Enter'); expect(field('移除文件引用 src/App.tsx')).not.toBeNull()
    await change('input', 'review this'); await key('Enter'); expect(send).toHaveBeenCalledWith('review this', { skills: ['code-review'], files: ['src/App.tsx'] })
    await change('input', '/code'); await key('Escape'); expect(container.querySelector('[role="listbox"]')).toBeNull()
    await change('input', 'https://example.com/path'); expect(container.querySelector('[role="listbox"]')).toBeNull()
    await change('input', 'person@example.com'); expect(container.querySelector('[role="listbox"]')).toBeNull()
  })
  it('drops stale skill lists when the conversation changes and keeps loading failures visible', async () => {
    let resolve!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn((path: string) => path.includes('/first/') ? new Promise<Response>(r => { resolve = r }) : Promise.resolve(Response.json({ error: 'Skill service unavailable' }, { status: 503 }))))
    function Harness({ scopePath }: { scopePath: string }) {
      const [text, setText] = useState('')
      return <AgentComposerInput value={text} onChange={setText} label="input" disabled={false} scopePath={scopePath} context={{}} setContext={vi.fn()} commands={[]} send={vi.fn()} />
    }
    await act(async () => root.render(<Harness scopePath="/lumo/api/acp/rooms/first" />)); await change('input', '/')
    await act(async () => root.render(<Harness scopePath="/lumo/api/acp/rooms/second" />))
    await act(async () => resolve(Response.json({ complete: true, skills: [{ name: 'stale-skill', description: 'old' }] })))
    expect(container.textContent).not.toContain('stale-skill'); expect(container.textContent).toContain('Skill service unavailable')
  })
  it('uploads real bytes once, retries the same turn receipt after failure and clears accepted files', async () => {
    const request = vi.fn(async () => Response.json({ attachment: file })), send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<RoleRoomConversation room={room} asks={[]} busy={false} send={send} action={vi.fn()} answer={vi.fn()} />))
    await addFile(); expect(button('发送协作消息').disabled).toBe(false)
    await act(async () => button('发送协作消息').click()); await flush()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '', attachments: [file] }))
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({ name: 'notes.md', mimeType: 'text/markdown', data: 'aGVsbG8=' })
    expect(field('移除附件 notes.md')).not.toBeNull()
    await act(async () => button('发送协作消息').click()); await flush()
    expect(request.mock.calls.filter(([path]) => path === '/lumo/api/acp/attachments')).toHaveLength(1); expect(send.mock.calls[0]).toEqual(send.mock.calls[1])
    expect(field('移除附件 notes.md')).toBeNull(); expect(button('发送协作消息').disabled).toBe(true)
  })
  it('supports drop, paste, removal and an actionable upload failure without dispatching a prompt', async () => {
    const send = vi.fn(), request = vi.fn(async () => Response.json({ error: 'upload unavailable' }, { status: 503 }))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<RoleRoomConversation room={room} asks={[]} busy={false} send={send} action={vi.fn()} answer={vi.fn()} />))
    await act(async () => {
      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [new File(['hello'], 'dropped.txt', { type: 'text/plain' })] } })
      container.querySelector('form')!.dispatchEvent(drop)
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['png'], 'pasted.png', { type: 'image/png' })] } })
      field('协作消息输入').dispatchEvent(paste)
    })
    expect(field('移除附件 pasted.png')).not.toBeNull(); expect(field('移除附件 dropped.txt')).not.toBeNull()
    await act(async () => field('移除附件 pasted.png').click())
    await act(async () => button('发送协作消息').click()); await flush()
    expect(container.textContent).toContain('upload unavailable'); expect(send).not.toHaveBeenCalled(); expect(field('移除附件 dropped.txt')).not.toBeNull()
  })
  it('abandons late uploads after the user changes conversation', async () => {
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve })))
    const send = vi.fn()
    const render = (value: RoomView) => root.render(<RoleRoomConversation room={value} asks={[]} busy={false} send={send} action={vi.fn()} answer={vi.fn()} />)
    await act(async () => render(room)); await addFile(); await act(async () => button('发送协作消息').click()); await flush()
    await act(async () => render({ ...room, id: 'other' })); await act(async () => complete(Response.json({ attachment: file })))
    expect(send).not.toHaveBeenCalled(); expect(field('移除附件 notes.md')).toBeNull()
  })
  it('chooses a registered project or a native folder when creating a group', async () => {
    const pick = mockProjects(), create = vi.fn(async () => true)
    await act(async () => root.render(<RoleRoomCreate engines={engines} busy={false} create={create} />))
    await change('选择项目', '/second'); await act(async () => button('创建协作房间').click())
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/second' }))
    await act(async () => button('选择文件夹').click()); expect(pick).toHaveBeenCalledOnce(); expect(field('选择项目').value).toBe('/picked'); expect(field('协作工作区目录')).toBeNull()
  })
  it('edits the project path in place, cancels with Escape, and keeps one project control', async () => {
    mockProjects()
    function Picker() { const [value, setValue] = useState('/second'); return <AgentProjectPicker value={value} onChange={setValue} /> }
    await act(async () => root.render(<Picker />))
    expect(field('选择项目').value).toBe('/second'); expect(field('工作区目录')).toBeNull()
    await act(async () => button('编辑项目路径').click()); expect(field('选择项目')).toBeNull()
    await change('工作区目录', '/manual')
    await act(async () => field('工作区目录').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(field('选择项目').value).toBe('/second')
    await act(async () => button('编辑项目路径').click()); await change('工作区目录', '/manual')
    await act(async () => field('工作区目录').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(field('选择项目').value).toBe('/manual'); expect(field('工作区目录')).toBeNull()
  })
  it('switches a group through a new-conversation action and keeps the current room unchanged', async () => {
    mockProjects(); const switchProject = vi.fn(async () => true)
    await act(async () => root.render(<RoleRoomConversation room={room} asks={[]} busy={false} send={vi.fn()} action={vi.fn()} answer={vi.fn()} switchProject={switchProject} />))
    await act(async () => button('群组设置').click()); await change('选择项目', '/second')
    await act(async () => button('切换项目并新建群组对话').click())
    expect(switchProject).toHaveBeenCalledWith('/second'); expect(room.cwd).toBe('/first')
  })
  it('sends attachments independently, preserves text typed during send, and starts the chosen project separately', async () => {
    mockProjects()
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
    let complete!: (response: Response) => void
    const request = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
      if (path.endsWith('/engines')) return Response.json({ engines })
      if (path.endsWith('/attachments')) return Response.json({ attachment: file })
      if (path.endsWith('/prompt')) return new Promise(resolve => { complete = resolve })
      if (path.includes('/asks')) return Response.json({ asks: [] })
      if (path.endsWith('/attach')) return Response.json({ session })
      if (init?.method === 'POST') return Response.json({ session: { ...session, id: 's2', ...JSON.parse(init.body as string) } })
      return Response.json({ identity: scope, sessions: [session] })
    })
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<AcpSessionPanel />)); await act(async () => button('连接会话').click())
    await addFile(); await act(async () => button('发送').click()); await flush()
    expect(JSON.parse(request.mock.calls.find(([p]) => p.endsWith('/prompt'))![1]!.body as string)).toEqual({ text: '', attachments: [file], clientMessageId: expect.any(String) })
    await change('发送给引擎', 'next message'); await act(async () => complete(Response.json({ ok: true })))
    expect(field('发送给引擎').value).toBe('next message'); expect(field('移除附件 notes.md')).toBeNull()
    await act(async () => button('断开查看').click()); await act(async () => button('连接会话').click())
    await act(async () => button('会话设置').click()); await change('选择项目', '/second'); await act(async () => button('切换项目并新建会话').click())
    expect(request.mock.calls.filter(([p, init]) => p.endsWith('/sessions') && init?.method === 'POST')).toHaveLength(1)
    expect(JSON.parse(request.mock.calls.find(([p, init]) => p.endsWith('/sessions') && init?.method === 'POST')![1]!.body as string)).toMatchObject({ cwd: '/second', engineId: 'claude-code' })
    expect(request.mock.calls.some(([p]) => p.endsWith('/close'))).toBe(false)
  })
  it('keeps attachment metadata in replayed user messages', () => {
    expect(reduceTranscript([], { type: 'message.chunk', role: 'user', text: '', attachments: [file] })).toEqual([{ kind: 'text', role: 'user', text: '', attachments: [file] }])
  })
})
