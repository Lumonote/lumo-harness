// @vitest-environment jsdom
import { fireEvent, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ownedChatHtml, ownedChatScript } from '../src/owned-chat.ts'

const sessionId = `session-${'a'.repeat(32)}`
const migrationId = `mig_${'b'.repeat(48)}`
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
type Receipt = { id: string; state: 'checkpointed' | 'activated'; source_node_id: string; target_node_id: string }
function mount(initial: Receipt | null = null, failCheckpoint = false) {
  let migration = initial, unavailable = false
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const action = url.split('/').at(-1), body = JSON.parse(String(init.body))
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-lumo-auth-request': '1' })
    if (action === 'list') return new Response(JSON.stringify({ owners: [{ session_ref: sessionId, created_at: '2026-11-08' }], next_cursor: '' }))
    if (action === 'wait') return new Promise<Response>(() => {})
    if (action === 'migrationStatus') return unavailable ? new Response('{"error":"session_migration_unavailable"}', { status: 503 }) : new Response(JSON.stringify({ migration, targets: ['node-b'] }))
    if (action === 'checkpoint') {
      expect(body).toEqual({ sessionId, targetNodeId: 'node-b' })
      if (failCheckpoint) { unavailable = true; throw new TypeError('Failed to fetch') }
      migration = { id: migrationId, source_node_id: 'node-a', target_node_id: 'node-b', state: 'checkpointed' }
      return new Response(JSON.stringify({ migration }))
    }
    if (action === 'recover') { expect(body).toEqual({ sessionId, migrationId }); migration!.state = 'activated'; return new Response(JSON.stringify({ migration, ready: true })) }
    if (action === 'models') return new Response('{"choices":[],"can_select":false}')
    if (action === 'events') return new Response('{"events":[]}')
    return new Response('{"questions":[]}')
  })
  vi.stubGlobal('fetch', fetcher); document.body.innerHTML = ownedChatHtml; Function(ownedChatScript)()
  const open = async () => {
    await waitFor(() => expect(document.querySelectorAll('#sessions button')).toHaveLength(1))
    fireEvent.click(document.querySelector('#sessions button')!)
    await waitFor(() => expect(byId('migration-panel').hidden).toBe(false))
    byId<HTMLDetailsElement>('migration-panel').open = true
  }
  return { fetcher, open, makeAvailable: () => { unavailable = false } }
}
afterEach(() => { window.dispatchEvent(new Event('pagehide')); document.body.replaceChildren(); vi.unstubAllGlobals() })

it('saves and recovers through the chosen node without sending or clearing the unsent draft', async () => {
  const f = mount(); await f.open()
  fireEvent.change(byId('text'), { target: { value: 'unsent private draft' } })
  fireEvent.click(byId('migration-checkpoint'))
  await waitFor(() => expect(byId('migration-state').textContent).toContain('等待恢复'))
  expect(byId<HTMLButtonElement>('send').disabled).toBe(true)
  expect(byId<HTMLInputElement>('attachment-files').disabled).toBe(true)
  expect(byId<HTMLButtonElement>('migration-recover').disabled).toBe(false)
  fireEvent.click(byId('migration-recover'))
  await waitFor(() => expect(byId('migration-state').textContent).toContain('已恢复至 node-b'))
  await waitFor(() => expect(byId<HTMLButtonElement>('send').disabled).toBe(false))
  expect(byId<HTMLTextAreaElement>('text').value).toBe('unsent private draft')
  expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/prompt'))).toBe(false)
})

it('shows a frozen checkpoint on an online replica without querying the offline source history', async () => {
  const f = mount({ id: migrationId, state: 'checkpointed', source_node_id: 'node-a', target_node_id: 'node-b' }); await f.open()
  expect(byId('history').textContent).toContain('会话已冻结')
  expect(byId<HTMLButtonElement>('send').disabled).toBe(true)
  expect(f.fetcher.mock.calls.some(([url]) => /\/(events|models|wait)$/u.test(url))).toBe(false)
  fireEvent.click(byId('migration-recover'))
  await waitFor(() => expect(byId<HTMLButtonElement>('send').disabled).toBe(false))
})

it('keeps sending disabled after an unknown checkpoint response and an unavailable status read', async () => {
  const f = mount(null, true); await f.open()
  fireEvent.change(byId('text'), { target: { value: 'retain draft' } }); fireEvent.click(byId('migration-checkpoint'))
  await waitFor(() => expect(byId('status').textContent).toContain('提交结果尚未确认'))
  await waitFor(() => expect(byId<HTMLButtonElement>('migration-refresh').disabled).toBe(false))
  expect(byId<HTMLButtonElement>('send').disabled).toBe(true)
  fireEvent.submit(byId('prompt'))
  expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/prompt'))).toBe(false)
  expect(byId<HTMLTextAreaElement>('text').value).toBe('retain draft')
  fireEvent.click(byId('reload'))
  await waitFor(() => expect(byId('migration-panel').hidden).toBe(false))
  expect(byId<HTMLButtonElement>('send').disabled).toBe(true)
  expect(byId<HTMLButtonElement>('migration-refresh').disabled).toBe(false)
  expect(byId<HTMLTextAreaElement>('text').value).toBe('retain draft')
})
