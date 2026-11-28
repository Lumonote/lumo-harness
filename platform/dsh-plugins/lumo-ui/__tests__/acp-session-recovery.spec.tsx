// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpSessionPanel, AcpSessionSection } from '../src/client/acp-session-panel.tsx'

const identity = { realm: 'r', userId: 'u', projectId: 'p' }
const session = { ...identity, id: 's1', engineId: 'claude-code', state: 'idle', cwd: '/workspace' }
class Source {
  static instances: Source[] = []
  closed = false; onerror?: () => void
  handlers = new Map<string, (event: { data: string; lastEventId: string }) => void>()
  constructor(readonly url: string) { Source.instances.push(this) }
  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void) { this.handlers.set(type, listener) }
  close() { this.closed = true }
  emit(type: string, data: unknown, seq = '') { this.handlers.get(type)?.({ data: JSON.stringify(data), lastEventId: seq }) }
}
let container: HTMLDivElement; let root: Root
function button(label: string, index = 0) { return [...container.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label') ?? b.textContent) === label)[index]! }
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }) }
function setup(options: { sessions?: typeof session[]; override?: (path: string, init?: RequestInit) => Promise<Response> | undefined } = {}) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const override = options.override?.(path, init); if (override) return override
    if (path === '/lumo/api/acp/engines') return response({ engines: [{ id: 'claude-code', label: 'Claude', available: true }] })
    if (path === '/lumo/api/acp/sessions' && init?.method !== 'POST') return response({ identity, sessions: options.sessions ?? [] })
    if (path.includes('/asks')) return response({ asks: [] })
    if (path.endsWith('/release') || path.endsWith('/cancel')) return response({ ok: true })
    return response({ session })
  })
  vi.stubGlobal('fetch', request); return request
}
beforeEach(() => {
  vi.stubGlobal('EventSource', Source); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); sessionStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Source.instances = []; vi.unstubAllGlobals() })

describe('ACP session recovery controls', () => {
  it('keeps one SSE connection across model snapshots and updates, and reattaches the same session', async () => {
    setup({ sessions: [session] })
    await act(async () => root.render(<AcpSessionPanel />)); await act(async () => button('连接会话').click())
    const models = { source: 'legacy', currentModelId: 'large', availableModels: [{ id: 'small', name: 'Fast' }, { id: 'large', name: 'Thorough' }] }
    const events = Source.instances[0]!
    await act(async () => events.emit('session', { type: 'session.models', sessionId: session.id, models }, '1'))
    await act(async () => events.emit('hello', { session: { ...session, models } }))
    await act(async () => button('会话设置').click())
    expect((container.querySelector('[aria-label="会话模型"]') as HTMLSelectElement).value).toBe('large')
    expect(Source.instances).toHaveLength(1); expect(events.closed).toBe(false)
    await act(async () => button('断开查看').click()); await act(async () => button('连接会话').click())
    expect(events.closed).toBe(true); expect(Source.instances).toHaveLength(2)
  })
  it('does not consume desktop launch intents while showing read-only group member details', async () => {
    const request = setup({ sessions: [session] })
    const intent = { engineId: 'claude-code', cwd: '/workspace', at: Date.now() }
    sessionStorage.setItem('lumo.acpPending', JSON.stringify(intent))
    await act(async () => root.render(<AcpSessionPanel initialSessionId={session.id} readOnly />))
    await act(async () => window.dispatchEvent(new CustomEvent('lumo:acp-open', { detail: intent })))
    expect(sessionStorage.getItem('lumo.acpPending')).toBe(JSON.stringify(intent))
    expect(request.mock.calls.filter(([url, init]) => url === '/lumo/api/acp/sessions' && init?.method === 'POST')).toEqual([])
    expect(container.querySelector('[aria-label="发送给引擎"]')).toBeNull()
    expect(button('释放运行资源')).toBeUndefined(); expect(Source.instances).toHaveLength(1)
  })
  it('passes the selected tool model into independent session creation', async () => {
    const request = setup()
    await act(async () => root.render(<AcpSessionPanel defaultCwd="/workspace" initialModelId="large" />))
    expect(container.textContent).toContain('初始模型：large')
    await act(async () => button('开始会话').click())
    expect(request.mock.calls.find(([path, init]) => path === '/lumo/api/acp/sessions' && init?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({ engineId: 'claude-code', cwd: '/workspace', modelId: 'large' }))
  })
  it('shows group ownership instead of direct lifecycle controls for member sessions', async () => {
    setup({ sessions: [{ ...session, room: { id: 'team', name: 'Team', roleId: 'coder', roleName: 'Coder' } } as typeof session] })
    await act(async () => root.render(<AcpSessionPanel />))
    expect(button('进入群组 · Team')).toBeDefined(); expect(button('释放运行资源')).toBeUndefined(); expect(button('连接会话')).toBeUndefined()
  })
  it('lists existing sessions after refresh, attaches without creation, and retains controls after close failure', async () => {
    const request = setup({ sessions: [{ ...session, state: 'running' }], override: path => path.endsWith('/release') ? Promise.resolve(response({ error: 'disk unavailable' }, 500)) : undefined })
    await act(async () => root.render(<AcpSessionPanel />))
    await act(async () => button('连接会话').click())
    expect(Source.instances).toHaveLength(1)
    expect(request.mock.calls.some(([path, init]) => path === '/lumo/api/acp/sessions' && init?.method === 'POST')).toBe(false)
    await act(async () => button('会话设置').click())
    await act(async () => button('释放运行资源').click())
    expect(container.textContent).toContain('disk unavailable'); expect(button('释放运行资源')).toBeDefined()
    expect(Source.instances[0]!.closed).toBe(false)
  })
  it('shows an unavailable notice for malformed engine listings without crashing the panel', async () => {
    setup({ override: path => path === '/lumo/api/acp/engines' ? Promise.resolve(response({})) : undefined })
    await act(async () => root.render(<AcpSessionPanel />))
    expect(container.textContent).toContain('ACP 引擎会话不可用')
    expect(container.textContent).toContain('引擎列表响应无效')
  })
  it('guards same-tick double creation from buttons and desktop launches', async () => {
    let resolve!: (r: Response) => void
    const request = setup({ override: (path, init) => path === '/lumo/api/acp/sessions' && init?.method === 'POST' ? new Promise(r => { resolve = r }) : undefined })
    await act(async () => root.render(<AcpSessionPanel defaultCwd="/workspace" />))
    await act(async () => {
      button('开始会话').click(); button('开始会话').click()
      window.dispatchEvent(new CustomEvent('lumo:acp-open', { detail: { engineId: 'claude-code', cwd: '/workspace', at: Date.now() } }))
    })
    expect(request.mock.calls.filter(([path, init]) => path === '/lumo/api/acp/sessions' && init?.method === 'POST')).toHaveLength(1)
    await act(async () => resolve(response({ session })))
    expect(Source.instances).toHaveLength(1)
  })
  it('deduplicates sequences, clears transcript on reset, and never uses hello.seq as a cursor', async () => {
    const request = setup({ sessions: [session] })
    await act(async () => root.render(<AcpSessionPanel />)); await act(async () => button('连接会话').click())
    const events = Source.instances[0]!
    const chunk = { type: 'message.chunk', sessionId: session.id, role: 'agent', text: 'a' }
    await act(async () => { events.emit('session', chunk, '1'); events.emit('session', chunk, '1'); events.emit('session', chunk, '0') })
    expect(container.querySelector('.lumo-role-reply p')?.textContent).toBe('a')
    const before = request.mock.calls.filter(([p]) => p.includes('/asks')).length
    await act(async () => events.emit('hello', { session: { ...session, state: 'running' }, seq: 99 }))
    expect(button('停止')).toBeDefined(); expect(request.mock.calls.filter(([p]) => p.includes('/asks')).length).toBe(before + 1)
    await act(async () => events.emit('session', { ...chunk, text: 'b' }, '2'))
    expect(container.querySelector('.lumo-role-reply p')?.textContent).toBe('ab')
    await act(async () => {
      events.emit('reset', { session, resetAfter: 4, reason: 'buffer_truncated' }, '4')
      events.emit('session', { ...chunk, text: 'tail' }, '5')
      events.emit('session', { ...chunk, text: 'old' }, '3')
      events.onerror?.()
    })
    expect(container.querySelector('[role="log"]')?.textContent).toContain('补齐断线期间的消息')
    expect(container.querySelector('[role="log"]')?.textContent).toContain('tail')
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('ab')
    expect(events.closed).toBe(false); expect(container.textContent).toContain('自动重连')
  })
  it('abandons late attach responses when the user selects another session', async () => {
    const second = { ...session, id: 's2' }; let finish!: (r: Response) => void
    setup({ sessions: [session, second], override: path => path.includes('/s1/attach') ? new Promise(r => { finish = r }) : path.includes('/s2/attach') ? Promise.resolve(response({ session: second })) : undefined })
    await act(async () => root.render(<AcpSessionPanel />))
    await act(async () => button('连接会话', 0).click()); await act(async () => button('连接会话', 1).click())
    await act(async () => finish(response({ session })))
    expect(Source.instances).toHaveLength(1); expect(Source.instances[0]!.url).toContain('/s2/events')
  })
  it.each(['idle', 'detached'] as const)('ignores a late %s success after closing its pending target', async action => {
    const entry = { ...session, state: action === 'detached' ? 'detached' : 'idle' }
    let finish!: (r: Response) => void; let signal!: AbortSignal
    setup({ sessions: [entry], override: (path, init) => {
      if (!path.endsWith('/attach')) return undefined
      signal = init!.signal as AbortSignal
      // Deliberately resolve despite abort: late network completions must be fenced too.
      return new Promise(resolve => { finish = resolve })
    } })
    await act(async () => root.render(<AcpSessionPanel />))
    await act(async () => button(action === 'detached' ? '恢复会话' : '连接会话').click())
    await act(async () => button('释放运行资源').click())
    await act(async () => finish(response({ session })))
    expect(Source.instances).toHaveLength(0)
    expect(signal.aborted).toBe(true)
    expect(container.querySelectorAll('.lumo-chat-composer')).toHaveLength(0)
  })
  it.each(['idle', 'detached'] as const)('keeps pending %s alive when a different session is closed', async action => {
    const entry = { ...session, state: action === 'detached' ? 'detached' : 'idle' }
    const other = { ...session, id: 's2' }
    let finish!: (r: Response) => void; let signal!: AbortSignal
    setup({ sessions: [entry, other], override: (path, init) => {
      if (!path.endsWith('/s1/attach')) return undefined
      signal = init!.signal as AbortSignal
      return new Promise(resolve => { finish = resolve })
    } })
    await act(async () => root.render(<AcpSessionPanel />))
    await act(async () => button(action === 'detached' ? '恢复会话' : '连接会话').click())
    await act(async () => button('释放运行资源', 1).click())
    expect(signal.aborted).toBe(false)
    await act(async () => finish(response({ session })))
    expect(Source.instances).toHaveLength(1)
    expect(Source.instances[0]!.url).toContain('/s1/events')
    expect(container.querySelectorAll('.lumo-chat-composer')).toHaveLength(1)
  })
  it('clears old identity contents and ignores pending responses after identity changes', async () => {
    let finish!: (r: Response) => void
    setup({ sessions: [session], override: path => path.includes('/attach') ? new Promise(r => { finish = r }) : undefined })
    await act(async () => root.render(<AcpSessionPanel identityKey="r/u/p" />)); await act(async () => button('连接会话').click())
    await act(async () => root.render(<AcpSessionPanel identityKey="other/u/p" />))
    await act(async () => finish(response({ session })))
    expect(Source.instances).toHaveLength(0); expect(container.querySelectorAll('.lumo-role-reply')).toHaveLength(0)
  })
  it('restores only after a click and explains incomplete history', async () => {
    const detached = { ...session, state: 'detached', historyIncomplete: true }
    const request = setup({ sessions: [detached], override: path => path.endsWith('/attach') ? Promise.resolve(response({ session: { ...detached, historyOnly: true } })) : undefined })
    await act(async () => root.render(<AcpSessionPanel />))
    expect(request.mock.calls.some(([path]) => path.endsWith('/resume'))).toBe(false)
    await act(async () => button('恢复会话').click())
    expect(container.textContent).toContain('历史聊天转写不完整')
  })
  it('keys the actual production section from the BFF scope on focus refresh', async () => {
    let changed = false
    setup({ sessions: [session], override: (path, init) => changed && path === '/lumo/api/acp/sessions' && init?.method !== 'POST' ? Promise.resolve(response({ identity: { ...identity, projectId: 'other' }, sessions: [] })) : undefined })
    await act(async () => root.render(<AcpSessionSection />)); await act(async () => button('连接会话').click())
    const events = Source.instances[0]!
    await act(async () => events.emit('session', { type: 'message.chunk', sessionId: 's1', role: 'agent', text: 'private transcript' }, '1'))
    changed = true; await act(async () => window.dispatchEvent(new Event('focus')))
    expect(container.textContent).not.toContain('private transcript'); expect(events.closed).toBe(true)
    expect(container.querySelectorAll('.lumo-chat-composer')).toHaveLength(0)
  })
  it('clears transcript/asks and disconnects immediately when a list refresh reports a new scope', async () => {
    let changed = false
    setup({ sessions: [session], override: (path, init) => changed && path === '/lumo/api/acp/sessions' && init?.method !== 'POST' ? Promise.resolve(response({ identity: { ...identity, realm: 'other' }, sessions: [] })) : undefined })
    await act(async () => root.render(<AcpSessionPanel />)); await act(async () => button('连接会话').click())
    const events = Source.instances[0]!
    await act(async () => events.emit('session', { type: 'message.chunk', sessionId: 's1', role: 'agent', text: 'secret' }, '1'))
    changed = true; await act(async () => button('刷新会话').click())
    expect(container.textContent).not.toContain('secret'); expect(events.closed).toBe(true)
    await act(async () => events.emit('session', { type: 'message.chunk', sessionId: 's1', role: 'agent', text: 'late-secret' }, '2'))
    expect(container.textContent).not.toContain('late-secret')
  })
})
