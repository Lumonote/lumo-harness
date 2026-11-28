// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationTools } from '../src/client/conversation-tools.tsx'
import { acpCall } from '../src/client/acp-session-state.ts'
vi.mock('../src/client/acp-session-state.ts', () => ({ acpCall: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const value = { members: [{ id: 'a', name: '研究员', engineId: 'claude-code', supplied: true, tools: [{ name: 'knowledge_query', title: '知识检索', description: '已发布文档', action: 'knowledge:query', risk: 'low', approval: 'never' }] }] }

it('shows actual member tools and permissions, and refreshes after session delivery', async () => {
  vi.mocked(acpCall).mockResolvedValueOnce({ members: [{ ...value.members[0], supplied: false, tools: [], reason: '启动此成员会话后加载共享工具' }] }).mockResolvedValueOnce(value)
  render(<ConversationTools scopePath="/rooms/a" />)
  expect(await screen.findByText('启动此成员会话后加载共享工具')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '刷新共享工具' }))
  expect(await screen.findByText('knowledge_query')).toBeTruthy()
  expect(screen.getByText('知识检索 · 无需额外确认')).toBeTruthy()
  expect(screen.getByText('knowledge:query')).toBeTruthy()
})

it('drops a late result when switching conversation identity', async () => {
  let settle!: (value: unknown) => void
  vi.mocked(acpCall).mockReturnValueOnce(new Promise(resolve => { settle = resolve })).mockResolvedValueOnce({ members: [] })
  const view = render(<ConversationTools scopePath="/sessions/old" />)
  view.rerender(<ConversationTools scopePath="/sessions/new" />)
  await act(async () => { settle(value) })
  expect(screen.queryByText('knowledge_query')).toBeNull()
})
