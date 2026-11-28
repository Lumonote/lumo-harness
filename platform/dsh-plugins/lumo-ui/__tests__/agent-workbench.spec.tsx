// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevelopmentTools } from '../src/client/development-tools.tsx'
import { AgentDirectory } from '../src/client/agent-directory.tsx'
import { RoleRoomSurface } from '../src/client/role-room-surface.tsx'
import { scopeKey } from '../src/client/acp-session-state.ts'
import { openAgentRoom, takeAgentRoom } from '../src/client/agent-navigation.ts'

const identity = { realm: 'local', userId: 'owner', projectId: 'project' }, key = scopeKey(identity)
const engines = [{ id: 'claude-code', label: 'Claude Code', protocol: 'acp', available: true, launchKind: 'on-demand' as const }, { id: 'codex', label: 'Codex', protocol: 'codex-app-server', available: true }, { id: 'gemini', label: 'Gemini CLI', protocol: 'acp', available: false, reason: '找不到入口' }]
const models = { source: 'config' as const, configId: 'model', currentModelId: 'small', availableModels: [{ id: 'small', name: 'Fast' }, { id: 'large', name: 'Thorough' }] }
const agents = [{ ...identity, id: 'helper', name: '助理', engineId: 'claude-code', modelId: 'large', instruction: '汇总证据' }, { ...identity, id: 'coder', name: '开发', engineId: 'codex', instruction: '实现与测试' }]
let container: HTMLDivElement, root: Root
const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
const change = async (label: string, value: string) => act(async () => {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); takeAgentRoom(key); vi.unstubAllGlobals() })

describe('development tools, real model choices and reusable agents', () => {
  it('selects asynchronously detected tools and carries the chosen model to both entry points', async () => {
    const request = vi.fn(async () => response({ models, identity })), create = vi.fn(), session = vi.fn()
    vi.stubGlobal('fetch', request)
    const view = (available = engines) => <DevelopmentTools engines={available} identity={key} refresh={vi.fn()} createAgent={create} openSession={session} />
    await act(async () => root.render(view([])))
    await act(async () => root.render(view()))
    expect(container.textContent).toContain('适配器按需启动'); expect(request).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('.lumo-dev-catalog [data-engine-logo]')].map(mark => mark.getAttribute('data-engine-logo'))).toEqual(['claude-code', 'codex', 'gemini'])
    expect(container.querySelector('.lumo-dev-detail [data-engine-logo]')?.getAttribute('data-engine-logo')).toBe('claude-code')
    await change('工具工作区目录', '/workspace'); await act(async () => button('连接并读取模型').click())
    expect(request.mock.calls[0]?.[0]).toContain('/claude-code/models')
    await change('模型', 'large')
    await act(async () => button('用此工具创建 Agent').click()); expect(create).toHaveBeenCalledWith({ engineId: 'claude-code', modelId: 'large' })
    await act(async () => button('打开独立会话').click()); expect(session).toHaveBeenCalledWith('claude-code', '/workspace', 'large')
  })
  it('discards a late model response after switching tools and disables unavailable tools', async () => {
    let done!: (value: Response) => void
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>(resolve => { done = resolve }))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<DevelopmentTools engines={engines} identity={key} refresh={vi.fn()} createAgent={vi.fn()} openSession={vi.fn()} />))
    await change('工具工作区目录', '/workspace'); await act(async () => button('连接并读取模型').click())
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.lumo-dev-catalog button')[1]!.click())
    expect(container.querySelector('.lumo-dev-detail [data-engine-logo]')?.getAttribute('data-engine-logo')).toBe('codex')
    expect(request.mock.calls[0]![1]!.signal?.aborted).toBe(true)
    await act(async () => done(response({ models, identity })))
    expect(container.textContent).not.toContain('Thorough')
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.lumo-dev-catalog button')[2]!.click())
    expect(button('连接并读取模型').disabled).toBe(true); expect(button('用此工具创建 Agent').disabled).toBe(true)
    expect(container.textContent).toContain('找不到入口')
  })
  it.each([null, 'foreign'] as const)('handles absent capabilities or identity changes without showing invented models (%s)', async mode => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ models: mode === null ? null : models, identity: mode === 'foreign' ? { ...identity, userId: 'other' } : identity })))
    await act(async () => root.render(<DevelopmentTools engines={engines} identity={key} refresh={vi.fn()} createAgent={vi.fn()} openSession={vi.fn()} />))
    await change('工具工作区目录', '/workspace'); await act(async () => button('连接并读取模型').click())
    expect(container.textContent).toContain(mode === null ? '未提供模型列表' : '身份已变化')
    expect(container.textContent).not.toContain('Thorough')
  })
  it('edits real model choices directly in the directory and preserves group-member configuration', async () => {
    const group = vi.fn(), request = vi.fn(async (path: string, init?: RequestInit) => path.endsWith('/models') ? response({ models, identity })
      : init?.method === 'POST' ? response({ agent: { ...JSON.parse(init.body as string), ...identity }, identity }) : response({ agents, identity }))
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<AgentDirectory engines={engines} identity={key} group={group} tools={vi.fn()} />))
    expect([...container.querySelectorAll('.lumo-agent-check [data-engine-logo]')].map(mark => mark.getAttribute('data-engine-logo'))).toEqual(['claude-code', 'codex'])
    await act(async () => button('编辑').click())
    await change('工具工作区目录', '/workspace'); await act(async () => button('连接并读取模型').click()); await change('模型', 'small')
    await act(async () => button('保存 Agent').click())
    const saved = request.mock.calls.find(([path, init]) => path === '/lumo/api/acp/agents' && init?.method === 'POST')!
    expect(JSON.parse(saved[1]!.body as string)).toMatchObject({ id: 'helper', modelId: 'small', instruction: '汇总证据' })
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => input.click()))
    await act(async () => button('组建群组（2/6）').click())
    expect(group).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'helper', modelId: 'small' }), expect.objectContaining({ id: 'coder' })]))
  })
  it('creates a group from saved agents without discarding selected model or provenance', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/engines')) return response({ engines })
      if (path.endsWith('/sessions')) return response({ sessions: [], identity })
      if (path.endsWith('/agents')) return response({ agents, identity })
      if (path.endsWith('/rooms') && init?.method === 'POST') return response({ room: { ...JSON.parse(init.body as string), ...identity, sessionStates: {}, turns: [], busy: false }, identity })
      return response({ rooms: [], identity })
    })
    vi.stubGlobal('fetch', request)
    await act(async () => root.render(<RoleRoomSurface onClose={vi.fn()} />))
    await act(async () => button('Agent 通讯录').click())
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => input.click()))
    await act(async () => button('组建群组（2/6）').click())
    await change('协作工作区目录', '/workspace'); await act(async () => button('创建协作房间').click())
    const created = request.mock.calls.find(([path, init]) => path.endsWith('/rooms') && init?.method === 'POST')!
    expect(JSON.parse(created[1]!.body as string)).toMatchObject({ coordinatorId: 'helper', roles: [expect.objectContaining({ id: 'helper', agentId: 'helper', modelId: 'large' }), expect.objectContaining({ id: 'coder', agentId: 'coder' })] })
    expect(request.mock.calls.some(([path, init]) => path.endsWith('/sessions') && init?.method === 'POST')).toBe(false)
  })
  it('clears saved member drafts when identity changes, including a group not yet created', async () => {
    let current = identity
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path.endsWith('/engines') ? { engines } : path.endsWith('/agents') ? { agents, identity: current } : { rooms: [], identity: current })))
    await act(async () => root.render(<RoleRoomSurface onClose={vi.fn()} />)); await act(async () => button('Agent 通讯录').click())
    await act(async () => container.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => input.click()))
    await act(async () => button('组建群组（2/6）').click())
    expect((container.querySelector('[aria-label="角色 1 名称"]') as HTMLInputElement).value).toBe('助理')
    current = { ...identity, userId: 'other' }; await act(async () => window.dispatchEvent(new Event('focus')))
    expect(container.querySelector('[aria-label="角色 1 名称"]')).toBeNull()
    await act(async () => button('新建对话').click()); await act(async () => button('Bot / Agent 协作群组').click())
    expect((container.querySelector('[aria-label="角色 1 名称"]') as HTMLInputElement).value).toBe('个人助理')
    expect(container.textContent).not.toContain('large')
  })
  it('consumes group navigation once and rejects targets from another identity', () => {
    openAgentRoom('team', key); expect(takeAgentRoom(key)).toBe('team'); expect(takeAgentRoom(key)).toBeUndefined()
    openAgentRoom('team', key); expect(takeAgentRoom(scopeKey({ ...identity, userId: 'other' }))).toBeUndefined()
    expect(takeAgentRoom(key)).toBeUndefined()
  })
})
