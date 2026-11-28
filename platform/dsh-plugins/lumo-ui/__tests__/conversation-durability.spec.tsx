// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationSearch } from '../src/client/use-conversation-search.ts'
import { useRoleRooms } from '../src/client/use-role-rooms.ts'
import { AcpSessionPanel } from '../src/client/acp-session-panel.tsx'
import { RoleRoomConversation } from '../src/client/role-room-conversation.tsx'
import { AgentComposerInput } from '../src/client/agent-composer-input.tsx'
import { AgentContextBrowser } from '../src/client/agent-context-browser.tsx'
import { reduceTranscript, type TranscriptItem } from '../src/client/acp-session-state.ts'
import { AgentToolResult, AgentPlan } from '../src/client/agent-execution-content.tsx'
import { AgentChatHistory } from '../src/client/agent-chat-history.tsx'
import type { RoomView } from '../../acp-engines/src/role-room-model.ts'

const identity = {realm: 'r', userId: 'u', projectId: 'p'}
const session = {...identity, id: 's1', engineId: 'claude-code', cwd: '/work', state: 'idle'}
const room: RoomView = {...identity, id: 'r1', name: 'Team', cwd: '/work', coordinatorId: 'one', createdAt: '2026-11-28T00:00:00Z', busy: false, sessionStates: {}, turns: [], roles: [
  {id: 'one', name: '助理', engineId: 'claude-code', instruction: 'Coordinate'}, {id: 'two', name: '开发', engineId: 'codex', instruction: 'Code'},
]}
class Source {
  static instances: Source[] = []
  handlers = new Map<string, (e: {data: string; lastEventId: string}) => void>()
  constructor(readonly url: string) { Source.instances.push(this) }
  addEventListener(type: string, listener: (e: {data: string; lastEventId: string}) => void) { this.handlers.set(type, listener) }
  emit(type: string, body: unknown, seq = '') { this.handlers.get(type)?.({data: JSON.stringify(body), lastEventId: seq}) }
  closed = false
  close() { this.closed = true }
}
let container: HTMLDivElement, root: Root
const button = (name: string) => [...container.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === name)!
const field = (name: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${name}"]`)!
const change = (name: string, value: string) => act(async () => { const element = field(name), proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true})) })
const baseFetch = (path: string) => path.endsWith('/engines') ? {engines: [{id: 'claude-code', label: 'Claude', available: true}]} : path === '/lumo/api/acp/sessions' ? {identity, sessions: [session]} : path.includes('/asks') ? {asks: []} : path.includes('/history') ? {events: [], seq: 0, hasMore: false} : path.endsWith('/skills') ? {skills: []} : {session}
beforeEach(() => { localStorage.clear(); Source.instances = []; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', Source); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('durable conversation interactions', () => {
  it('restores text, target, mode, context, attachment and panel after remount, without crossing users', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({files: [], skills: []})))
    const render = (value: RoomView) => root.render(<RoleRoomConversation key={`${value.userId}:${value.id}`} room={value} busy={false} asks={[]} send={vi.fn()} action={vi.fn()} answer={vi.fn()} />)
    await act(async () => render(room)); await change('协作消息输入', 'keep my draft'); await change('发送给角色', 'two'); await change('对话方式', 'relay')
    await act(async () => { const input = field('选择附件'); Object.defineProperty(input, 'files', {value: [new File(['notes'], 'draft.txt', {type: 'text/plain'})]}); input.dispatchEvent(new Event('change', {bubbles: true})) })
    await act(async () => button('项目文件').click())
    await act(async () => render({...room, id: 'r2'})); expect(field('协作消息输入').value).toBe('')
    await act(async () => render(room)); expect(field('协作消息输入').value).toBe('keep my draft'); expect(field('对话方式').value).toBe('relay'); expect(button('移除附件 draft.txt')).toBeDefined(); expect(container.querySelector('aside[aria-label="项目文件"]')).not.toBeNull()
    await change('对话方式', 'direct'); expect(field('发送给角色').value).toBe('two')
    await act(async () => render({...room, userId: 'another'})); expect(field('协作消息输入').value).toBe(''); expect(button('移除附件 draft.txt')).toBeUndefined()
  })
  it('retains the same prompt request ID across failure and component remount', async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => { if (path.endsWith('/prompt')) { requests.push(JSON.parse(init!.body as string)); return Response.json({error: 'connection lost'}, {status: 503}) }; return Response.json(baseFetch(path)) }))
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />)); await change('发送给引擎', 'once only'); await act(async () => button('发送').click())
    await act(async () => root.render(<div />)); await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />)); expect(field('发送给引擎').value).toBe('once only'); await act(async () => button('发送').click())
    expect(requests).toHaveLength(2); expect(requests[0]!.clientMessageId).toBe(requests[1]!.clientMessageId)
  })
  it('loads older history and resumes SSE at the durable sequence without duplicating output', async () => {
    const event = (seq: number, text: string) => ({seq, event: {type: 'message.chunk', sessionId: 's1', role: 'user', text}})
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/history?before=') ? {events: [event(1, 'older')], seq: 3, hasMore: false} : path.includes('/history?') ? {events: [event(2, 'recent')], seq: 2, before: 2, hasMore: true} : baseFetch(path))))
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />))
    expect(Source.instances).toHaveLength(1); expect(Source.instances[0]!.url).toContain('after=2')
    await act(async () => Source.instances[0]!.emit('session', event(2, 'duplicate').event, '2'))
    await act(async () => button('加载更早消息').click())
    expect(container.querySelector('[role="log"]')!.textContent).toContain('olderrecent'); expect(container.textContent).not.toContain('duplicate')
  })
  it('inserts native engine commands with arguments and sends unlisted slash commands', async () => {
    const send = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({skills: []})))
    function Harness() { const [text, setText] = useState(''); return <AgentComposerInput value={text} onChange={setText} label="message" disabled={false} scopePath="/session" context={{}} setContext={() => undefined} commands={[]} engineCommands={[{name: 'compact', description: 'Compact context', input: {hint: 'Instructions'}}]} send={() => send(text)} /> }
    await act(async () => root.render(<Harness />)); await change('message', '/comp'); await act(async () => field('message').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})))
    expect(field('message').value).toBe('/compact '); expect(send).not.toHaveBeenCalled()
    await change('message', '/unknown'); await act(async () => field('message').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})))
    expect(send).toHaveBeenCalledWith('/unknown')
  })
  it('projects tools, diffs and plans into native expandable controls', async () => {
    let items: TranscriptItem[] = reduceTranscript([], {type: 'tool.call', toolCallId: 'tool', title: 'Update file', status: 'pending', input: 'write file'})
    items = reduceTranscript(items, {type: 'tool.update', toolCallId: 'tool', status: 'completed', output: 'done', exitCode: 0, diffs: [{path: 'a.ts', oldText: 'old', newText: 'new'}]})
    items = reduceTranscript(items, {type: 'plan', entries: [{content: 'Verify output', status: 'in_progress'}]})
    await act(async () => root.render(<><AgentToolResult item={items[0] as Extract<TranscriptItem, {kind: 'tool'}>} /><AgentPlan entries={(items[1] as Extract<TranscriptItem, {kind: 'plan'}>).entries} /></>))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click())
    expect(container.textContent).toContain('write file'); expect(container.textContent).toContain('done'); expect(container.textContent).toContain('a.ts'); expect(container.querySelector('[aria-label="执行计划"]')!.textContent).toContain('Verify output')
  })
  it('previews a project file without changing its prompt selection', async () => {
    const onChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/preview?') ? {path: 'main.ts', name: 'main.ts', mimeType: 'text/plain', size: 10, text: 'const x = 1'} : {files: [{name: 'main.ts', path: 'main.ts', directory: false}]})))
    await act(async () => root.render(<AgentContextBrowser kind="files" scopePath="/session" cwd="/work" value={{}} onChange={onChange} disabled={false} />)); await act(async () => button('预览文件 main.ts').click())
    expect(container.querySelector('[aria-label="文件预览"]')!.textContent).toContain('const x = 1'); expect(onChange).not.toHaveBeenCalled()
  })
  it('filters archived chats and puts pinned chats first without project labels in recents', async () => {
    await act(async () => root.render(<AgentChatHistory rooms={[]} sessions={[{...session, id: 'a', title: 'Archived', archived: true}, {...session, id: 'b', title: 'Pinned', pinned: true, updatedAt: '2026-11-01'}, {...session, id: 'c', title: 'New', updatedAt: '2026-11-28'}]} query="" selected="" disabled={false} openRoom={vi.fn()} openSession={vi.fn()} />))
    expect(container.querySelector('[aria-label="最近对话记录"]')!.textContent).not.toContain('Archived'); expect(container.querySelector('[aria-label="最近对话记录"] b')!.textContent).toBe('Pinned')
    await act(async () => button('已归档对话').click()); expect(container.querySelector('[aria-label="最近对话记录"]')!.textContent).toContain('Archived'); expect(container.querySelector('[aria-label="最近对话记录"]')!.textContent).not.toContain('/work')
  })

  it('closes history-only SSE after hello and keeps the closed transcript visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/history?') ? {events: [{seq: 1, event: {type: 'message.chunk', sessionId: 's1', role: 'agent', text: 'stored answer'}}], seq: 1, hasMore: false} : path.endsWith('/attach') ? {session: {...session, state: 'closed', historyOnly: true}} : baseFetch(path))))
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />))
    await act(async () => Source.instances[0]!.emit('hello', {session: {...session, state: 'closed', historyOnly: true}}))
    expect(Source.instances[0]!.closed).toBe(true); expect(container.textContent).toContain('stored answer'); expect(field('发送给引擎')).toBeNull()
  })
  it('merges durable recovery with new events received while the missing history loads', async () => {
    let complete!: (response: Response) => void, reads = 0
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.includes('/history?') && ++reads > 1 ? new Promise<Response>(resolve => {complete = resolve}) : Response.json(baseFetch(path))))
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />))
    await act(async () => {Source.instances[0]!.emit('reset', {session, resetAfter: 4}); Source.instances[0]!.emit('session', {type: 'message.chunk', sessionId: 's1', role: 'user', text: 'new'}, '5')})
    await act(async () => complete(Response.json({events: [{seq: 4, event: {type: 'message.chunk', sessionId: 's1', role: 'user', text: 'saved'}}], seq: 4, hasMore: false})))
    expect(container.querySelector('[role="log"]')!.textContent).toContain('savednew')
    expect(container.textContent).not.toContain('补齐断线期间')
  })
  it('keeps the selected group mounted and applies streamed changes without replacing its draft', async () => {
    const stored = {...room, revision: 1}
    const request = vi.fn(async (path: string) => Response.json(path.includes('/rooms?') ? {identity, rooms: [stored]} : path.includes('/rooms/r1') ? {identity, room: stored} : path.includes('/asks') ? {asks: []} : {engines: []}))
    vi.stubGlobal('fetch', request)
    function Harness() { const state = useRoleRooms(); return <><button aria-label="select same" onClick={() => state.select('r1')}>Select</button>{state.room ? <RoleRoomConversation room={state.room} busy={false} asks={[]} send={vi.fn()} action={vi.fn()} answer={vi.fn()} /> : null}</> }
    await act(async () => root.render(<Harness />)); await change('协作消息输入', 'draft retained')
    const before = request.mock.calls.length; await act(async () => button('select same').click()); expect(request.mock.calls).toHaveLength(before)
    await act(async () => Source.instances[0]!.emit('room.changed', {id: 'r1', revision: 2, busy: true, turn: {id: 't1', text: 'question', mode: 'direct', state: 'running', createdAt: room.createdAt, targetRoleId: 'one', steps: [{roleId: 'one', purpose: 'reply', state: 'running', text: 'streamed answer'}]}}))
    expect(container.querySelector('[role="log"]')!.textContent).toContain('streamed answer'); expect(field('协作消息输入').value).toBe('draft retained')
  })
  it('creates a cross-engine continuation with a visible summary and no automatic prompt', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => Response.json(path.endsWith('/engines') ? {engines: [{id: 'claude-code', label: 'Claude', available: true}, {id: 'codex', label: 'Codex', available: true}]} : path.endsWith('/continue') ? {session: {...session, id: 'next', engineId: 'codex', handoff: {sessionId: 's1', summary: JSON.parse(init!.body as string).summary}}} : baseFetch(path)))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />)); await act(async () => button('会话设置').click()); await act(async () => button('继续新话题').click())
    await change('新话题工具', 'codex'); await change('新话题摘要', 'Finished review; implement tests next'); await act(async () => button('承接摘要并创建话题').click())
    expect(JSON.parse(request.mock.calls.find(([path]) => path.endsWith('/continue'))![1]!.body as string)).toEqual({engineId: 'codex', summary: 'Finished review; implement tests next', clientRequestId: expect.any(String)})
    expect(container.textContent).toContain('承接的话题摘要'); expect(container.textContent).toContain('Finished review; implement tests next'); expect(request.mock.calls.some(([path]) => path.endsWith('/prompt'))).toBe(false)
  })

  it('finds messages using server history search even when the title does not match', async () => {
    const request = vi.fn(async (path: string) => Response.json(path.includes('/rooms?') ? {identity, rooms: []} : {identity, sessions: [{...session, title: 'Different title'}]}))
    vi.stubGlobal('fetch', request)
    function Harness() { const search = useConversationSearch('message body', JSON.stringify(['r', 'u', 'p'])); return <AgentChatHistory rooms={search.result?.rooms ?? []} sessions={search.result?.sessions ?? []} query="message body" searched={!!search.result} selected="" disabled={false} openRoom={vi.fn()} openSession={vi.fn()} /> }
    await act(async () => root.render(<Harness />)); await act(async () => new Promise(resolve => setTimeout(resolve, 300)))
    expect(request.mock.calls.some(([path]) => path === '/lumo/api/acp/sessions?q=message%20body')).toBe(true); expect(container.textContent).toContain('Different title')
  })

  it('aborts a preparing prompt on stop, keeps its draft and retry ID, and still sends server cancellation', async () => {
    const requests: Record<string, unknown>[] = []; let signal: AbortSignal | null | undefined
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/prompt')) { requests.push(JSON.parse(init!.body as string)); signal = init!.signal; return new Promise<Response>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) }
      return Response.json(baseFetch(path))
    })
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />)); await change('发送给引擎', 'prepared draft'); await act(async () => button('发送').click()); await act(async () => button('停止').click())
    expect(signal!.aborted).toBe(true); expect(request.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(true); expect(field('发送给引擎').value).toBe('prepared draft'); expect(container.textContent).toContain('草稿已保留')
    await act(async () => button('发送').click()); expect(requests[0]!.clientMessageId).toBe(requests[1]!.clientMessageId)
    await act(async () => button('停止').click())
  })
  it('opens the scoped remote execution tool only when selected', async () => {
    const request = vi.fn(async (path: string) => Response.json(path.includes('/lumo/api/acp/') ? baseFetch(path) : {error: 'not configured'}))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<AcpSessionPanel initialSessionId="s1" />)); expect(container.querySelector('section[aria-label="远程执行"]')).toBeNull()
    await act(async () => button('远程执行').click()); expect(container.querySelector('section[aria-label="远程执行"]')).not.toBeNull()
  })
})
