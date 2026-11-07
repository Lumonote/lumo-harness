import { expect, it, vi } from 'vitest'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionModelPolicy, SessionTurnModelGuard } from '../src/session-model-policy.ts'

const config = { provider: 'mock', model: 'a', modelChoices: [
  { id: 'a', label: '快速', provider: 'mock', model: 'a', billingModel: 'mock/a' },
  { id: 'b', label: '深入', provider: 'second', model: 'b', billingModel: 'second/b' },
] }
function subject() {
  let selection: ModelSelection = { provider: 'mock', model: 'a' }, seq = 1, busy = false
  return { get status() { return 'idle' }, inbox: { nextTurn: [], nextStep: [] }, session: { get seq() { return seq } },
    model: { current: () => ({ ...selection }), select: (next: ModelSelection) => { selection = { ...next }; seq++ } },
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => { if (busy) throw Error('busy'); busy = true; try { return await task(new AbortController().signal) } finally { busy = false } },
  } as unknown as Agent
}
const hooks = () => ({ authorize: vi.fn(async () => {}), admit: vi.fn(async () => {}), resolve: vi.fn(async () => {}), flush: vi.fn(async () => {}) })
it('keeps fixed configuration closed and rejects ambiguous or unpriced dynamic configuration', () => {
  const fixed = new SessionModelPolicy({ provider: 'mock', model: 'a' })
  expect(fixed.dynamic).toBe(false)
  expect(() => fixed.require({ provider: 'mock', model: 'b' })).toThrow()
})
it('resolves only detached approved routes, rejects retired routes, and freezes a complete turn', () => {
  const policy = new SessionModelPolicy(config)
  const fixed = new SessionTurnModelGuard(policy)
  expect(fixed.check(1, { provider: 'mock', model: 'a' })).toEqual({ provider: 'mock', model: 'a' })
  expect(() => fixed.check(1, { provider: 'second', model: 'b' })).toThrow(/snapshot/)
  expect(fixed.check(2, { provider: 'second', model: 'b' }).model).toBe('b')
  expect(() => new SessionModelPolicy({ ...config, modelChoices: [config.modelChoices[0]!] }).require({ provider: 'second', model: 'b' })).toThrow()
  for (const modelChoices of [[], [config.modelChoices[1]!], [{ ...config.modelChoices[0]!, billingModel: '' }], [config.modelChoices[0]!, config.modelChoices[0]!]]) expect(() => new SessionModelPolicy({ ...config, modelChoices })).toThrow()
})
it('serializes idle selection, verifies the log CAS twice, and persists before acknowledgement', async () => {
  const policy = new SessionModelPolicy(config), agent = subject(), h = hooks()
  const req = { sessionId: 'session-test', choice_id: 'b', expected_revision: 1, policy_digest: policy.digest }
  const gate = Promise.withResolvers<void>()
  h.resolve.mockImplementationOnce(() => gate.promise)
  const first = policy.select(agent, req, h)
  await vi.waitFor(() => expect(h.resolve).toHaveBeenCalledTimes(1))
  await expect(policy.select(agent, req, hooks())).rejects.toMatchObject({ code: 'session_model_busy' })
  expect(agent.model.current()?.model).toBe('a')
  gate.resolve()
  await expect(first).resolves.toMatchObject({ selected_choice_id: 'b', selection_revision: 2 })
  expect(h.flush).toHaveBeenCalledTimes(1)
  await expect(policy.select(agent, req, hooks())).rejects.toMatchObject({ code: 'session_model_changed' })
  await expect(policy.select(agent, { ...req, provider: 'arbitrary' }, hooks())).rejects.toMatchObject({ code: 'session_model_unavailable' })
  const changed = hooks()
  changed.resolve.mockImplementationOnce(async () => { agent.model.select({ provider: 'mock', model: 'a' }) })
  await expect(policy.select(agent, { ...req, expected_revision: 2 }, changed)).rejects.toMatchObject({ code: 'session_model_changed' })
  expect(changed.flush).not.toHaveBeenCalled()
})
