import { expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleAcpRoute, type AcpRouteDeps } from '../src/routes.ts'
import { sameScope } from '../src/session-scope.ts'

it('lists only tools bound to the owned session or group members, including unstarted members', async () => {
  const identity = { realm: 'r', userId: 'u', projectId: 'p' }
  const sharedTools = vi.fn(() => ({ supplied: true, tools: [{ name: 'knowledge_query' }] }))
  const deps = { identity, sharedTools, asks: {}, readBody: async () => Buffer.alloc(0),
    host: { get: (id: string, scope: typeof identity) => id === 'owned' && sameScope(scope, identity) ? { id, engineId: 'claude-code' } : undefined },
    rooms: { view: (id: string, scope: typeof identity) => id === 'team' && sameScope(scope, identity) ? { roles: [
      { id: 'first', name: 'Research', engineId: 'claude-code', sessionId: 'owned' },
      { id: 'second', name: 'Review', engineId: 'codex' },
      { id: 'stale', name: 'Unavailable', engineId: 'gemini', sessionId: 'foreign' },
    ] } : undefined },
  } as unknown as AcpRouteDeps
  const route = async (path: string, scope = identity) => {
    let status = 0, body: any
    await handleAcpRoute({ method: 'GET', url: path } as IncomingMessage, {
      writeHead: (value: number) => { status = value }, end: (value: string) => { body = JSON.parse(value) },
    } as unknown as ServerResponse, path, { ...deps, identity: scope })
    return { status, body }
  }
  expect((await route('/lumo/api/acp/sessions/owned/tools')).body.members[0]).toMatchObject({ supplied: true, tools: [{ name: 'knowledge_query' }] })
  const group = await route('/lumo/api/acp/rooms/team/tools')
  expect(group.body.members.map((member: { supplied: boolean }) => member.supplied)).toEqual([true, false, false])
  expect(sharedTools.mock.calls).toEqual([[identity, 'owned'], [identity, 'owned']])
  expect((await route('/lumo/api/acp/sessions/foreign/tools')).status).toBe(404)
  expect((await route('/lumo/api/acp/rooms/team/tools', { ...identity, projectId: 'other' })).status).toBe(404)
  expect(sharedTools).toHaveBeenCalledTimes(2)
})
