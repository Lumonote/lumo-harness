import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionQuestionAsks, connectorAsksOf, isSessionAskAnswer } from '../src/session-asks.ts'

function fixture() {
  const handlers = new Map<string, Function>()
  const emit = vi.fn()
  const ctx = { on: (name: string, cb: Function) => { handlers.set(name, cb) }, effect: vi.fn(), emit }
  const agent = { id: 'session-a', session: { id: 'session-a' }, ctx } as unknown as Agent
  const asks = new SessionQuestionAsks(() => ({ realm: 'r', owner: 'alice' }))
  asks.install(agent)
  return { agent, asks, emit, request: (q: object) => handlers.get('user-questions/request')!({ agent, questions: [q] }, async () => 'next') }
}

describe('owned session question asks', () => {
  it('registers a choice ask and returns the selected label to the session', async () => {
    const f = fixture()
    const pending = f.request({ id: 'q1', question: 'Which env?', options: [{ label: 'staging' }, { label: 'prod' }] })
    await Promise.resolve()
    const [ask] = f.asks.list(f.agent)
    expect(ask).toMatchObject({ kind: 'choice', status: 'pending', source: { kind: 'session', ref: 'q1', session_ref: 'session-a' } })
    expect(f.emit).toHaveBeenCalledWith('lumo/ask-link', expect.objectContaining({ askId: ask!.id, state: 'pending', sessionRef: 'session-a' }))
    f.asks.answer(f.agent, { askId: ask!.id, value: 'o2' }, 'alice')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['prod'] }] })
    expect(f.asks.list(f.agent)).toHaveLength(0)
  })
  it('returns free text for question asks and rejects double answers', async () => {
    const f = fixture()
    const pending = f.request({ id: 'q2', question: 'Name?' })
    await Promise.resolve()
    const [ask] = f.asks.list(f.agent)
    expect(ask!.kind).toBe('question')
    f.asks.answer(f.agent, { askId: ask!.id, value: 'Lumo' }, 'alice')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q2', selected: [], custom: 'Lumo' }] })
    expect(() => f.asks.answer(f.agent, { askId: ask!.id, value: 'again' }, 'alice')).toThrow()
  })
  it('passes approval intents through to the connector handler', async () => {
    const f = fixture()
    await expect(f.request({ id: 'q3', question: 'ok?', options: [{ label: 'A' }, { label: 'R' }], intent: { kind: 'approval', approve: 'A', reject: 'R' } })).resolves.toBe('next')
  })
  it('validates answer shape and projects connector receipts', () => {
    expect(isSessionAskAnswer({ askId: 'x', value: 'y' })).toBe(true)
    expect(isSessionAskAnswer({ questionId: 'x', decision: 'approve' })).toBe(false)
    const [ask] = connectorAsksOf('session-a', 'r', 'alice', [{ questionId: 'qq', receiptId: 'rc', expiresAt: '2999-01-01T00:00:00Z', questions: [{ id: 'qq', question: 'write?' }] }])
    expect(ask).toMatchObject({ kind: 'approval', source: { kind: 'session', ref: 'rc', session_ref: 'session-a' } })
  })
})
