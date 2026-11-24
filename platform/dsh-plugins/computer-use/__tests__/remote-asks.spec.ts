import { describe, expect, it, vi } from 'vitest'
import { answerRemoteComputerAsk, remoteAskStatus, remoteComputerAsk } from '../src/remote-asks.ts'
import type { RemoteComputerLocalRequest } from '../../../shared/seam-contracts/remote-computer.ts'

const row = (state: RemoteComputerLocalRequest['state'], expires = '2999-01-01T00:00:00Z') => ({
  envelope: { version: 1, request_id: 'req1', digest: 'd'.repeat(64), plan_json: '{}' },
  plan: { realm: 'r', node_id: 'n', owner_user_id: 'owner', project_id: 'p', session_ref: 'session-x', capability: 'desktop', expires_at: expires, intent: 'open app', channel: 'c', subject: 's', sender_user_id: 'alice', team_id: 't', agent_id: 'a' },
  state, revision: 1, summary: '',
}) as unknown as RemoteComputerLocalRequest

describe('remote computer ask adapter', () => {
  it('projects ledger rows to unified asks', () => {
    const ask = remoteComputerAsk(row('pending'))
    expect(ask.id).toBe('remote-computer:req1')
    expect(ask.source).toMatchObject({ kind: 'remote-computer', ref: 'req1', session_ref: 'session-x' })
    expect(ask.status).toBe('pending')
  })
  it('maps states', () => {
    expect(remoteAskStatus(row('denied'))).toBe('rejected')
    expect(remoteAskStatus(row('cancelled'))).toBe('cancelled')
    expect(remoteAskStatus(row('running'))).toBe('answered')
    expect(remoteAskStatus(row('pending', '2000-01-01T00:00:00Z'))).toBe('expired')
  })
  it('forwards answers to broker.decide with the ledger digest', async () => {
    const decide = vi.fn(async () => row('denied'))
    const ask = await answerRemoteComputerAsk({ decide }, row('pending'), 'reject')
    expect(decide).toHaveBeenCalledWith('req1', { digest: 'd'.repeat(64), approve: false })
    expect(ask.status).toBe('rejected')
    await expect(answerRemoteComputerAsk({ decide }, row('pending'), 'maybe')).rejects.toThrow()
  })
})
