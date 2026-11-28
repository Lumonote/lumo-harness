import { describe, expect, it, vi } from 'vitest'
import { handleAcpRoute, type AcpRouteDeps } from '../src/routes.ts'
import type { Ask } from '../../../shared/seam-contracts/asks.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
const identity = { realm: 'local', userId: 'owner', projectId: 'p' }
const shared: Ask = { id: 'run:dual-uuid', kind: 'approval', status: 'pending', realm: 'local', requester_user_id: 'owner', project_id: 'p', title: 'tool', options: [{ id: 'original-option', label: 'Allow once' }], source: { kind: 'run', ref: 'dual-uuid', session_ref: 'owned' }, created_at: '', expires_at: '' }
function fixture() {
  const nativeAnswer = vi.fn(() => ({ ok: true })), answer = vi.fn(async () => ({ ok: true }))
  const deps = { host: { get: (id: string) => id === 'owned' ? {} : undefined }, asks: { list: () => [{ ...shared, id: 'session:acp-native' }], answer: nativeAnswer }, conversationAsks: { list: vi.fn(async () => ({ asks: [shared, { ...shared, id: 'connector:foreign', source: { ...shared.source, session_ref: 'foreign' } }], warnings: ['connector unavailable'] })), answer }, identity, readBody: async () => Buffer.from('{"value":"original-option"}') } as unknown as AcpRouteDeps
  const route = async (path: string, method = 'GET') => {
    let status = 0, body: any
    await handleAcpRoute({ url: path, method } as IncomingMessage, { writeHead: (n: number) => { status = n }, end: (value: string) => { body = JSON.parse(value) } } as unknown as ServerResponse, path.split('?')[0]!, deps)
    return { status, body }
  }
  return { deps, route, answer, nativeAnswer }
}
describe('approvals projected into their owned external conversations', () => {
  it('merges sources without changing IDs/options and forwards answers to their authority', async () => {
    const { route, answer, nativeAnswer } = fixture()
    const list = await route('/lumo/api/acp/asks?status=pending')
    expect(list.body.asks.map((ask: Ask) => ask.id)).toEqual(['session:acp-native', 'run:dual-uuid'])
    expect(list.body.warnings).toEqual(['connector unavailable'])
    expect((await route('/lumo/api/acp/asks/run%3Adual-uuid/answer', 'POST')).status).toBe(200)
    expect(answer).toHaveBeenCalledWith('run:dual-uuid', 'original-option', identity); expect(nativeAnswer).not.toHaveBeenCalled()
    expect((await route('/lumo/api/acp/asks/connector%3Aforeign/answer', 'POST')).status).toBe(404)
    expect((await route('/lumo/api/acp/asks/session%3Aacp-native/answer', 'POST')).status).toBe(200)
    expect(nativeAnswer).toHaveBeenCalledWith('session:acp-native', 'original-option', identity)
  })
  it('keeps engine permissions visible when a shared approval source fails', async () => {
    const { deps, route } = fixture(); vi.mocked(deps.conversationAsks!.list).mockRejectedValue(new Error('shared source unavailable'))
    const result = await route('/lumo/api/acp/asks')
    expect(result.status).toBe(200); expect(result.body.asks).toHaveLength(1); expect(result.body.warnings).toEqual(['shared source unavailable'])
  })
})
