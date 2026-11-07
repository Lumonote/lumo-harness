// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ownedChatHtml, ownedChatScript } from '../src/owned-chat.ts'
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })
it.each(['approve', 'reject'] as const)('renders the exact native approval as inert text and sends a single bound %s answer', async decision => {
  const sessionId = `session-${'a'.repeat(32)}`
  const expected = { questionId: 'connector-question', receiptId: 'b'.repeat(48), digest: 'c'.repeat(64), revision: 1, decision }
  let pending = true
  const detail = 'Exact business payload: ```\n<img src="https://external.invalid/pixel" onerror="alert(1)">'
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const action = url.split('/').at(-1), body = JSON.parse(String(init.body))
    if (action === 'wait') return await new Promise<Response>(() => {})
    if (action === 'list') return new Response(JSON.stringify({ owners: [{ session_ref: sessionId, created_at: '2026-11-07' }], next_cursor: '' }))
    if (action === 'models') return new Response(JSON.stringify({ choices: [], can_select: false }))
    if (action === 'interactionList') return new Response(JSON.stringify({ questions: pending ? [{ ...expected, decision: undefined, expiresAt: new Date(Date.now() + 60_000).toISOString(), questions: [{ id: expected.questionId, question: 'Create one issue?', detail }] }] : [] }))
    if (action === 'interactionAnswer') {
      expect((init.headers as Record<string, string>)['x-lumo-auth-request']).toBe('1')
      expect(body).toEqual({ sessionId, answer: expected })
      pending = false
      return new Response('{"accepted":true}')
    }
    return new Response('{"events":[]}')
  })
  vi.stubGlobal('fetch', fetcher)
  document.body.innerHTML = ownedChatHtml
  Function(ownedChatScript)()
  await waitFor(() => expect(document.querySelectorAll('#sessions button')).toHaveLength(1))
  fireEvent.click(document.querySelector('#sessions button')!)
  await waitFor(() => expect(document.querySelector('#interactions pre')!.textContent).toBe(detail))
  expect(document.querySelector('#interactions img')).toBeNull()
  const button = screen.getByRole('button', { name: decision === 'approve' ? '确认并执行一次' : '拒绝' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(document.querySelectorAll('#interactions button')).toHaveLength(0))
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/interactionAnswer'))).toHaveLength(1)
})
