// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentPermissionRequest } from '../src/client/agent-permission-request.tsx'
import { ConversationManagement } from '../src/client/conversation-management.tsx'
import { AcpSessionPanel } from '../src/client/acp-session-panel.tsx'
import type { AskView } from '../src/client/acp-session-state.ts'

let container: HTMLDivElement, root: Root
const button = (name: string) => [...container.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent) === name)!
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const ask: AskView = { id: 'ask', title: 'claude-code 请求权限：Write test.txt', detail: JSON.stringify({ file_path: '/fixture/test.txt', content: 'expected content' }), status: 'pending', source: {}, options: [
  { id: 'once-original-id', label: 'Yes', permissionKind: 'allow_once' },
  { id: 'session-original-id', label: 'Yes, allow all edits during this session', permissionKind: 'allow_always' },
  { id: 'reject-original-id', label: 'No', permissionKind: 'reject_once' },
] }

it('preserves exact permission IDs and scope with compact labels and inspectable full parameters', async () => {
  const answer = vi.fn()
  await act(async () => root.render(<AgentPermissionRequest ask={ask} member="作者" disabled={false} answer={answer} />))
  expect(container.querySelector('code')!.textContent).toBe('/fixture/test.txt')
  expect(container.querySelector('details')!.open).toBe(false)
  expect(container.querySelector('details pre')!.textContent).toBe(ask.detail)
  for (const name of ['允许一次', '本会话允许编辑', '拒绝']) await act(async () => button(name).click())
  expect(answer.mock.calls.map(([id]) => id)).toEqual(['once-original-id', 'session-original-id', 'reject-original-id'])
  await act(async () => root.render(<AgentPermissionRequest ask={ask} disabled answer={answer} />))
  await act(async () => button('允许一次').click()); expect(answer).toHaveBeenCalledTimes(3)
})

it('keeps unfamiliar authorization labels and non-JSON details intact', async () => {
  const custom = { ...ask, detail: '{truncated…', options: [{ id: 'custom', label: 'Allow only this command prefix', permissionKind: 'allow_always' as const }] }
  await act(async () => root.render(<AgentPermissionRequest ask={custom} disabled={false} answer={vi.fn()} />))
  expect(button('Allow only this command prefix')).toBeDefined()
  expect(container.querySelector('details pre')!.textContent).toBe('{truncated…')
})

it('saves a name with Enter while ignoring composing input', async () => {
  const save = vi.fn()
  await act(async () => root.render(<ConversationManagement scopePath="/session" title="Before" disabled={false} save={save} remove={vi.fn()} />))
  const input = container.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'After'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  expect(save).not.toHaveBeenCalled()
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(save).toHaveBeenCalledWith({ title: 'After' })
})

it('restores released sessions before enabling model or mode changes', async () => {
  const session = { id: 's', realm: 'r', userId: 'u', engineId: 'claude-code', cwd: '/fixture', state: 'closed', historyOnly: true, models: { currentModelId: 'm', availableModels: [{ id: 'm', name: 'Model' }] }, modes: { currentModeId: 'manual', availableModes: [{ id: 'manual', name: 'Manual' }] } }
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.endsWith('/engines') ? { engines: [{ id: 'claude-code', label: 'Claude Code', available: true }] } : path.endsWith('/sessions') ? { identity: { realm: 'r', userId: 'u' }, sessions: [session] } : path.includes('/history') ? { events: [], seq: 0, hasMore: false } : path.includes('/asks') ? { asks: [] } : { session })))
  await act(async () => root.render(<AcpSessionPanel initialSessionId="s" hideHistory />))
  await act(async () => button('会话设置').click())
  expect(container.querySelector<HTMLSelectElement>('[aria-label="会话模型"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLSelectElement>('[aria-label="引擎运行模式"]')!.disabled).toBe(true)
  expect(button('恢复运行').disabled).toBe(false); expect(button('释放运行资源')).toBeUndefined()
})
