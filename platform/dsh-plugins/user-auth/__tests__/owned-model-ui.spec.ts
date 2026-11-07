// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ownedChatHtml, ownedChatScript } from '../src/owned-chat.ts'
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })
it('uses approved model choice IDs with the observed policy and log revision', async () => {
  const id = `session-${'a'.repeat(32)}`
  let view = { choices: [{ id: 'fast', label: '快速' }, { id: 'deep', label: '深入' }], selected_choice_id: 'fast', policy_digest: 'policy-test', selection_revision: 4, can_select: true }
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const action = url.split('/').at(-1), body = JSON.parse(String(init.body))
    if (action === 'wait') return await new Promise<Response>(() => {})
    if (action === 'list') return new Response(JSON.stringify({ owners: [{ session_ref: id, created_at: '2026-11-07' }], next_cursor: '' }))
    if (action === 'models') return new Response(JSON.stringify(view))
    if (action === 'selectModel') { expect(body).toEqual({ sessionId: id, choice_id: 'deep', expected_revision: 4, policy_digest: 'policy-test' }); view = { ...view, selected_choice_id: 'deep', selection_revision: 5 }; return new Response(JSON.stringify(view)) }
    return new Response('{"events":[]}')
  })
  vi.stubGlobal('fetch', fetcher)
  document.body.innerHTML = ownedChatHtml
  Function(ownedChatScript)()
  await waitFor(() => expect(document.querySelectorAll('#sessions button')).toHaveLength(1))
  fireEvent.click(document.querySelector('#sessions button')!)
  const choices = screen.getByLabelText('会话模型') as HTMLSelectElement
  await waitFor(() => expect(choices.disabled).toBe(false))
  fireEvent.change(choices, { target: { value: 'deep' } })
  fireEvent.click(screen.getByRole('button', { name: '切换模型' }))
  await waitFor(() => expect(choices.value).toBe('deep'))
  await waitFor(() => expect(document.getElementById('model-state')!.textContent).toContain('当前模型：深入'))
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/selectModel'))).toBe(true)
})
