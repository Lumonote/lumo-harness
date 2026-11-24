import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineConnectorTools } from '../src/tools.ts'
import { GatewayError, type ConnectorClient } from '../src/client.ts'

const approval = { id: 'ap1', requester_user_id: 'u', connector_id: 'billing', connector_version: 1, operation: 'refund', status: 'pending' as const, created_at: '2026-11-24T00:00:00Z', expires_at: '2999-01-01T00:00:00Z' }
const required = () => new GatewayError('approval_required', 428, 'need approval', { code: 'approval_required', approval })

function setup(invoke: ReturnType<typeof vi.fn>, listAsks: ReturnType<typeof vi.fn>, askWaitMs?: number) {
  const tools = new Map<string, ToolDefinition>()
  const emit = vi.fn()
  const ctx = { tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {} } }, emit }
  const scope = { allowedFor: () => undefined }
  defineConnectorTools(ctx as never, { invoke, listAsks, list: vi.fn() } as unknown as ConnectorClient, scope as never, { askPollMs: 1, ...(askWaitMs !== undefined ? { askWaitMs } : {}) })
  const exec = { agent: { session: { id: 'session-1' } }, runId: 'run-9' }
  return { emit, run: (args: object) => tools.get('connector_invoke')!.execute(args, exec as never) }
}

describe('connector_invoke with unified ask', () => {
  it('waits for approval, replays with approvalId and links the ask to the run tree', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(required()).mockResolvedValueOnce({ status: 200, durationMs: 1, redacted: false })
    const listAsks = vi.fn(async () => [{ id: 'connector:ap1', status: 'answered', source: { kind: 'connector', ref: 'ap1' }, answer: { value: 'approve' }, expires_at: '2999-01-01T00:00:00Z' }])
    const { emit, run } = setup(invoke, listAsks)
    const out = await run({ connectorId: 'billing', operation: 'refund' }) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(invoke.mock.calls[1]![0]).toMatchObject({ approvalId: 'ap1', sessionRef: 'session-1' })
    expect(emit).toHaveBeenCalledWith('lumo/ask-link', { askId: 'connector:ap1', state: 'pending', runId: 'run-9', sessionRef: 'session-1' })
    expect(emit).toHaveBeenCalledWith('lumo/ask-link', expect.objectContaining({ askId: 'connector:ap1', state: 'resolved' }))
  })
  it('returns a structured rejection with askId', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(required())
    const listAsks = vi.fn(async () => [{ id: 'connector:ap1', status: 'rejected', source: { kind: 'connector', ref: 'ap1' }, expires_at: '2999-01-01T00:00:00Z' }])
    const out = await setup(invoke, listAsks).run({ connectorId: 'billing', operation: 'refund' }) as Record<string, unknown>
    expect(out).toMatchObject({ ok: false, code: 'approval_required', askId: 'connector:ap1', askStatus: 'rejected' })
  })
  it('askWaitMs=0 keeps the legacy immediate return but still links the ask', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(required())
    const { emit, run } = setup(invoke, vi.fn(), 0)
    const out = await run({ connectorId: 'billing', operation: 'refund' }) as Record<string, unknown>
    expect(out).toMatchObject({ ok: false, code: 'approval_required', askId: 'connector:ap1', askStatus: 'pending' })
    expect(emit).toHaveBeenCalledOnce()
  })
})
