import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { teamAuthorityHandler } from '../src/team-authority.ts'
import { AgentTeamsService } from '../src/service.ts'
import { StorageHubTeamStore, TEAM_TABLE, teamStorageKey, type KvUnitLike, type StorageFacetLike } from '../src/store.ts'
import { createCourier } from '../src/courier.ts'

type Handler = ReturnType<typeof teamAuthorityHandler>
async function request(handler: Handler, options: { token?: string; realm?: string; path?: string; method?: string; headers?: Record<string, string> } = {}) {
  let status = 0
  let headers: Record<string, string> = {}
  let body: unknown
  const req = { method: options.method ?? 'GET', url: options.path ?? '/lumo/runtime/teams/team1', headers: {
    authorization: options.token ?? 'Bearer control-service', 'x-lumo-realm': options.realm ?? 'r1', ...options.headers,
  } } as IncomingMessage
  const res = { writeHead(code: number, values: Record<string, string>) { status = code; headers = values }, end(value: string) { body = JSON.parse(value) } } as unknown as ServerResponse
  await handler(req, res)
  return { status, headers, body }
}

const bound = { realm: 'r1', id: 'team1', ownerUserId: 'owner', captainSessionId: 'captain', revision: 'revision1' }
function fixture(value: unknown = bound, durableValue = true) {
  const get = vi.fn(async () => value)
  const durable = vi.fn(() => durableValue)
  const handler = teamAuthorityHandler({ realm: 'r1', token: 'control-service', service: { get } as unknown as AgentTeamsService, durable })
  return { get, durable, handler }
}

describe('trusted team authority', () => {
  it.each(['', 'Bearer wrong', 'control-service', 'bearer control-service'])('rejects missing or invalid service authentication: %j', async token => {
    const f = fixture()
    const result = await request(f.handler, { token, headers: { 'x-lumo-user': 'owner', 'x-lumo-roles': 'platform_admin' } })
    expect(result.status).toBe(401)
    expect(f.get).not.toHaveBeenCalled()
    expect(f.durable).not.toHaveBeenCalled()
    expect(result.headers['cache-control']).toBe('no-store')
  })

  it.each([
    { realm: 'foreign' }, { realm: '' }, { method: 'POST' },
    { path: '/lumo/runtime/teams/team1/extra' }, { path: '/lumo/runtime/teams/team%2F1' },
    { path: '/lumo/runtime/teams/' }, { path: '/lumo/runtime/teams/../team1' },
  ])('rejects a foreign realm or invalid exact route: %j', async options => {
    const f = fixture()
    expect((await request(f.handler, options)).status).toBe(404)
    expect(f.get).not.toHaveBeenCalled()
  })

  it('requires the durable backing seam and never authorizes its memory fallback', async () => {
    const f = fixture(bound, false)
    expect((await request(f.handler)).status).toBe(503)
    expect(f.get).not.toHaveBeenCalled()
  })

  it('returns only the current team binding facts under the service credential', async () => {
    const f = fixture({ ...bound, members: [{ name: 'private' }], tasks: [{ subject: 'private' }] })
    const result = await request(f.handler, { headers: { 'x-lumo-user': 'forged', 'x-lumo-roles': 'platform_admin' } })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ realm: 'r1', id: 'team1', owner_user_id: 'owner', captain_session_ref: 'captain', revision: 'revision1' })
    expect(f.get).toHaveBeenCalledExactlyOnceWith('team1')
  })

  it.each([
    { realm: 'r2' }, { id: 'another-team' }, { ownerUserId: undefined },
    { captainSessionId: '' }, { revision: undefined },
  ])('rejects an incomplete or inconsistent durable binding: %j', async change => {
    const f = fixture({ ...bound, ...change })
    expect((await request(f.handler)).status).toBe(404)
  })

  it('reads cross-instance KV revisions and honors durable deletion tombstones', async () => {
    const records = new Map<string, unknown>()
    const unit: KvUnitLike = {
      async getRecord(_table, key) { return structuredClone(records.get(key)) },
      async loadAll() { return { tables: { [TEAM_TABLE]: Object.fromEntries(records) }, global: undefined } },
      async putRecord(_table, key, value) { records.set(key, structuredClone(value)) },
      async deleteRecord(_table, key) { records.delete(key) },
      async compareAndSetRecord(_table, key, expected, next) {
        if (!isDeepStrictEqual(records.get(key), expected)) return false
        records.set(key, structuredClone(next))
        return true
      },
      async close() {},
    }
    const facet: StorageFacetLike = { kv: { open: async () => unit } }
    const store1 = new StorageHubTeamStore(facet, { realm: 'r1', requireAtomic: true })
    const store2 = new StorageHubTeamStore(facet, { realm: 'r1', requireAtomic: true })
    const service = (store: StorageHubTeamStore) => new AgentTeamsService({
      realm: 'r1', ownerUserId: 'owner', requireDurableStore: true,
      resolveStore: () => ({ store, durable: true }), resolveCourier: () => createCourier(undefined),
    })
    const writer = service(store1)
    const reader = service(store2)
    const initial = await writer.create({ id: 'team1', name: 'Team', topology: 'planner-worker', subjects: ['Investigate'], captainSessionId: 'captain' })
    const handler = teamAuthorityHandler({ realm: 'r1', token: 'control-service', service: reader, durable: () => true })
    expect((await request(handler)).body).toMatchObject({ revision: initial.revision })
    const changed = await writer.addTasks('team1', [{ subject: 'Review evidence' }])
    expect(changed.revision).not.toBe(initial.revision)
    expect((await request(handler)).body).toMatchObject({ revision: changed.revision })
    await writer.remove('team1')
    expect(records.get(teamStorageKey('r1', 'team1'))).toMatchObject({ kind: 'lumo-team-deleted' })
    expect((await request(handler)).status).toBe(404)
    await expect(writer.create({ id: 'team1', name: 'Replacement', topology: 'planner-worker', subjects: [], captainSessionId: 'captain' })).rejects.toThrow()
    await store1.close()
    await store2.close()
  })
})
