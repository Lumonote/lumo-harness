import { describe, expect, it } from 'vitest'
import type { Ask } from '../../../shared/seam-contracts/asks.ts'
import { answerPath, isHighRisk, loadAllAsks, mergeAsks, visibleOptions } from '../src/client/ask-sources.ts'

const base = (over: Partial<Ask>): Ask => ({ id: 'connector:1', kind: 'approval', status: 'pending', realm: 'r', title: 't', source: { kind: 'connector', ref: '1' }, requester_user_id: 'u', created_at: '2026-11-24T00:00:00Z', expires_at: '2999-01-01T00:00:00Z', ...over })
const opts = [{ id: 'approve_once', label: '允许本次' }, { id: 'approve_session', label: '本会话内允许' }, { id: 'reject', label: '拒绝' }]

describe('ask sources', () => {
  it('routes answers back to the owning backend', () => {
    expect(answerPath({ id: 'run:dual-3' })).toBe('/lumo/api/dual/asks/run%3Adual-3/answer')
    expect(answerPath({ id: 'run:remote-install-h1-2' })).toBe('/lumo/api/remote-hosts/asks/run%3Aremote-install-h1-2/answer')
    expect(answerPath({ id: 'session:acp-9' })).toBe('/lumo/api/acp/asks/session%3Aacp-9/answer')
    expect(answerPath({ id: 'connector:1' })).toBe('/lumo/api/asks/connector%3A1/answer')
  })
  it('hides session-scope approval for high risk', () => {
    const low = base({ id: 'run:dual-1', title: 'p · t 请求执行（x，风险 low）', options: opts })
    const high = base({ id: 'run:dual-2', title: 'p · t 请求执行（x，风险 high）', options: opts })
    expect(visibleOptions(low).map(o => o.id)).toEqual(['approve_once', 'approve_session', 'reject'])
    expect(visibleOptions(high).map(o => o.id)).toEqual(['approve_once', 'reject'])
    expect(isHighRisk(base({ id: 'run:remote-tunnel-h-1' }))).toBe(true)
  })
  it('merges and dedupes; tolerates disabled sources', async () => {
    expect(mergeAsks([[base({})], [base({})]]).length).toBe(1)
    const r = await loadAllAsks(async path => {
      if (path === '/lumo/api/acp/asks') throw Object.assign(new Error('off'), { status: 501 })
      if (path === '/lumo/api/dual/asks') return { asks: [base({ id: 'run:dual-1' })] }
      return { asks: path === '/lumo/api/asks' ? [base({})] : [] }
    })
    expect(r.asks.map(a => a.id).sort()).toEqual(['connector:1', 'run:dual-1'])
    expect(r.errors).toEqual([])
  })
})
