import { describe, expect, it } from 'vitest'

import { askFromConnectorApproval, effectiveStatus, isTerminal, parseAskID, transition, validateAnswer, type ConnectorApprovalRecord } from '../asks.ts'

const base: ConnectorApprovalRecord = {
  id: 'abc_1', realm: 'r1', requester_user_id: 'u1', connector_id: 'billing', connector_version: 3,
  operation: 'refund', status: 'pending', created_at: '2026-11-24T00:00:00Z', expires_at: '2999-01-01T00:00:00Z',
}

describe('ask state machine', () => {
  it('only pending can transition', () => {
    expect(transition('pending', 'answer')).toEqual({ next: 'answered', ok: true })
    expect(transition('pending', 'cancel')).toEqual({ next: 'cancelled', ok: true })
    for (const s of ['answered', 'rejected', 'expired', 'cancelled'] as const) {
      expect(transition(s, 'answer')).toEqual({ next: s, ok: false })
      expect(isTerminal(s)).toBe(true)
    }
    expect(isTerminal('pending')).toBe(false)
  })
  it('expires on read without mutating', () => {
    expect(effectiveStatus({ status: 'pending', expires_at: '2000-01-01T00:00:00Z' })).toBe('expired')
    expect(effectiveStatus({ status: 'answered', expires_at: '2000-01-01T00:00:00Z' })).toBe('answered')
  })
})

describe('connector approval projection', () => {
  it('maps legacy statuses', () => {
    expect(askFromConnectorApproval(base).status).toBe('pending')
    expect(askFromConnectorApproval({ ...base, status: 'approved', approver_user_id: 'a' }).answer?.value).toBe('approve')
    expect(askFromConnectorApproval({ ...base, status: 'consumed' }).status).toBe('answered')
    expect(askFromConnectorApproval({ ...base, status: 'rejected', approver_user_id: 'a' }).status).toBe('rejected')
    expect(askFromConnectorApproval({ ...base, status: 'expired' }).status).toBe('expired')
  })
  it('round-trips the id', () => {
    const ask = askFromConnectorApproval(base)
    expect(ask.id).toBe('connector:abc_1')
    expect(parseAskID(ask.id)).toEqual({ kind: 'connector', ref: 'abc_1' })
    expect(parseAskID('bogus:x')).toBeUndefined()
    expect(parseAskID('connector:../x')).toBeUndefined()
  })
  it('validates approval answers against options', () => {
    const ask = askFromConnectorApproval(base)
    expect(validateAnswer(ask, { value: 'approve' })).toBeUndefined()
    expect(validateAnswer(ask, { value: 'maybe' })).toBeDefined()
    expect(validateAnswer(ask, { value: '' })).toBeDefined()
  })
})
