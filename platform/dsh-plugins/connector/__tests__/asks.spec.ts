import { describe, expect, it, vi } from 'vitest'

import { AskRejectedError, askFromGatewayError, invokeWithAsk } from '../src/asks.ts'
import { GatewayError } from '../src/client.ts'
import type { Ask } from '../../../shared/seam-contracts/asks.ts'

const approval = { id: 'ap1', requester_user_id: 'u', connector_id: 'billing', connector_version: 1, operation: 'refund', status: 'pending' as const, created_at: '2026-11-24T00:00:00Z', expires_at: '2999-01-01T00:00:00Z' }
const required = () => new GatewayError('approval_required', 428, 'need approval', { code: 'approval_required', approval })

describe('connector ask gate', () => {
  it('extracts the ask from a 428 response', () => {
    expect(askFromGatewayError(required())?.id).toBe('connector:ap1')
    expect(askFromGatewayError(new GatewayError('rate_limited', 429, 'x'))).toBeUndefined()
  })

  it('replays the same request with approvalId once answered', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(required()).mockResolvedValueOnce({ status: 200, durationMs: 1, redacted: false })
    const answered = { ...askFromGatewayError(required())!, status: 'answered', answer: { value: 'approve', answered_by: 'a', answered_at: '' } } as Ask
    const onAsk = vi.fn()
    const result = await invokeWithAsk({ invoke }, { connectorId: 'billing', operation: 'refund' }, { fetchAsk: async () => answered, onAsk, pollMs: 1 })
    expect(result.status).toBe(200)
    expect(onAsk).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[1]![0]).toMatchObject({ approvalId: 'ap1', operation: 'refund' })
  })

  it('throws AskRejectedError when rejected', async () => {
    const invoke = vi.fn().mockRejectedValue(required())
    const rejected = { ...askFromGatewayError(required())!, status: 'rejected' } as Ask
    await expect(invokeWithAsk({ invoke }, { connectorId: 'billing', operation: 'refund' }, { fetchAsk: async () => rejected, pollMs: 1 })).rejects.toBeInstanceOf(AskRejectedError)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('passes non-approval errors through unchanged', async () => {
    const err = new GatewayError('egress_denied', 403, 'no')
    await expect(invokeWithAsk({ invoke: vi.fn().mockRejectedValue(err) }, { connectorId: 'c', operation: 'o' }, { fetchAsk: async () => undefined })).rejects.toBe(err)
  })
})
