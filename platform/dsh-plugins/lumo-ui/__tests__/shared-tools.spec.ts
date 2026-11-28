import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSharedTools } from '../src/shared-tools.ts'
import { DualPluginGateway, LocalDecider, handleMcpMessage, type DualHost } from '../../dual-plugins/src/index.ts'
import { defineKnowledgeTool, type KnowledgeQueryTool } from '../../knowledge/src/consumer.ts'
import { createSessionScope } from '../../knowledge/src/session-scope.ts'
import { defineConnectorTools, type ConnectorTools } from '../../connector/src/tools.ts'
import { ConnectorClient, GatewayError } from '../../connector/src/client.ts'
import type { Ask } from '../../../shared/seam-contracts/asks.ts'

const identity = { realm: 'r', userId: 'u', projectId: 'p' }, caller = { ...identity, sessionRef: 'session-a' }
const dispose: Array<() => void> = []
afterEach(() => { dispose.splice(0).reverse().forEach(off => off()); vi.restoreAllMocks() })
function harness(services: Record<string, unknown>) {
  const gateway = new DualPluginGateway({ decider: new LocalDecider(), handlerTimeoutMs: 30_000 })
  const ctx = { get: (name: string) => services[name], effect: (run: () => (() => void)) => { dispose.push(run()) }, inject: (names: string[], run: (ctx: unknown) => void) => { if (names.every(name => services[name])) run(ctx) } }
  const host = { gateway, mcp: {}, close() {} } as DualHost
  const asks = installSharedTools(ctx as never, host, { ...identity, deploymentMode: 'local' })!
  return { gateway, asks }
}
const call = (gateway: DualPluginGateway, name: string, args: unknown, who = caller) => handleMcpMessage(gateway, who, { id: 1, method: 'tools/call', params: { name, arguments: args } })

describe('shared native consumer services over MCP', () => {
  it('reuses native knowledge narrowing, published scope and reranking with a real session identity', async () => {
    const query = vi.fn(async () => [{ docId: 'a', text: 'A', score: .9 }, { docId: 'b', text: 'B', score: .1 }])
    const rerank = vi.fn(async () => [.1, .9]), scope = createSessionScope(); scope.set('session-a', ['allowed']); scope.setUser('session-a', 'u')
    let service!: KnowledgeQueryTool
    const register = vi.fn(() => () => {})
    defineKnowledgeTool({ tools: { register }, logger: { warn: vi.fn() } } as never, { query } as never, { realm: 'r', roles: ['viewer'], defaultTopK: 5, rerank: { model: 'test', rerank } }, scope, value => { service = value })
    const { gateway } = harness({ knowledgeQueryTool: service })
    expect(await call(gateway, 'knowledge_query', { question: 'question', topK: 1 })).toMatchObject({ result: { isError: false, structuredContent: { hits: [{ docId: 'b', text: 'B', score: .1 }] } } })
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ realm: 'r', userId: 'u', roles: ['viewer'], scope: 'published', spaces: ['allowed'], topK: 3 }))
    expect(register).toHaveBeenCalledOnce(); expect(gateway.listTools('platform')).toEqual([])
    expect(await call(gateway, 'knowledge_query', { question: 'q' }, { ...caller, userId: 'other' })).toMatchObject({ result: { isError: true } })
    expect(await call(gateway, 'knowledge_query', { question: 'q', realm: 'other' })).toHaveProperty('error')
    expect(query).toHaveBeenCalledOnce()
  })
  it('shares connector approval receipts with exact options and replays only the approved request', async () => {
    let state: Ask = { id: 'connector:receipt', kind: 'approval', status: 'pending', realm: 'r', project_id: 'p', requester_user_id: 'u', title: 'Write item', options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '拒绝' }], source: { kind: 'connector', ref: 'receipt' }, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }
    const client = new ConnectorClient({ gatewayUrl: 'http://fixture.invalid', ...identity, roles: ['operator'] })
    const invoke = vi.spyOn(client, 'invoke').mockRejectedValueOnce(new GatewayError('approval_required', 428, 'ask', { ask: state })).mockResolvedValue({ status: 200, body: { result: 'done' }, durationMs: 1, redacted: false })
    vi.spyOn(client, 'listAsks').mockImplementation(async () => [state])
    const answer = vi.spyOn(client, 'answerAsk').mockImplementation(async (_id, value) => { state = { ...state, status: value === 'reject' ? 'rejected' : 'answered', answer: { value, answered_by: 'u', answered_at: new Date().toISOString() } }; return state })
    let tools!: ConnectorTools
    defineConnectorTools({ tools: { register: () => () => {} }, emit: vi.fn() } as never, client, { allowedFor: () => ['crm'] } as never, { askPollMs: 1, publish: value => { tools = value } })
    const { gateway, asks } = harness({ connectors: client, connectorTools: tools })
    const input = { connectorId: 'crm', operation: 'write', body: { exact: 'payload' }, correlationId: 'once' }
    const response = call(gateway, 'connector_invoke', input)
    await vi.waitFor(async () => expect((await asks.list(identity, 'pending')).asks).toHaveLength(1))
    expect((await asks.list(identity, 'pending')).asks[0]).toMatchObject({ id: 'connector:receipt', options: state.options, source: { session_ref: 'session-a' } })
    expect((await asks.list({ ...identity, projectId: 'foreign' }, 'pending')).asks).toEqual([])
    expect((await asks.answer(state.id, 'approve', { ...identity, realm: 'other' })).ok).toBe(false)
    expect((await asks.answer(state.id, 'made-up', identity)).ok).toBe(false); expect(answer).not.toHaveBeenCalled()
    expect((await asks.answer(state.id, 'approve', identity)).ok).toBe(true)
    expect(await response).toMatchObject({ result: { isError: false, structuredContent: { ok: true, provenance: 'external:connector/crm' } } })
    expect(invoke).toHaveBeenNthCalledWith(2, { ...input, sessionRef: 'session-a', approvalId: 'receipt' }, expect.any(AbortSignal))
    expect((await asks.list(identity, 'pending')).asks).toEqual([])
    expect(await call(gateway, 'connector_invoke', { connectorId: 'denied', operation: 'write' })).toMatchObject({ result: { structuredContent: { code: 'connector_scope_denied' } } })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('does not advertise missing services and removes tools on plugin disposal', () => {
    const { gateway } = harness({})
    expect(gateway.listTools('acp')).toEqual([])
    const query: KnowledgeQueryTool = { realm: 'r', parameters: { type: 'object' }, execute: async () => ({ hits: [] }) }
    const loaded = harness({ knowledgeQueryTool: query }); expect(loaded.gateway.listTools('acp')).toHaveLength(1)
    dispose.splice(0).forEach(off => off()); expect(loaded.gateway.listTools()).toEqual([])
  })
})
