import { afterEach, describe, expect, it, vi } from 'vitest'

import { postPlacement, postTerminalState } from '../src/client.ts'

afterEach(() => vi.unstubAllGlobals())

describe('subagent-remote scheduler client', () => {
  it('sends the control-plane bearer token for placement and terminal state', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ node_id: 'node-1', attempt: 2 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)

    await expect(postPlacement({
      base: 'http://scheduler', realm: 'realm-a', childId: 'child-1', controlPlaneToken: 'control-token',
    })).resolves.toEqual({ nodeId: 'node-1', attempt: 2 })
    await expect(postTerminalState({
      base: 'http://scheduler', realm: 'realm-a', childId: 'child-1', state: 'COMPLETED', attempt: 2, nodeId: 'node-1', controlPlaneToken: 'control-token',
    })).resolves.toBeUndefined()

    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ state: 'COMPLETED', attempt: 2, node_id: 'node-1' })
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer control-token', 'x-lumo-realm': 'realm-a' })
    }
  })

  it.each(['ABORTED', 'FAILED', 'COMPLETED', 'CANCELLING'])('rejects a replayed terminal or cancelling 201 placement: %s', async state => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ node_id: 'node-1', attempt: 1, state }, { status: 201 })))
    await expect(postPlacement({ base: 'http://scheduler', realm: 'realm-a', childId: 'child' }))
      .rejects.toMatchObject({ code: 'REMOTE_PLACEMENT_CANCELLED' })
  })

  it('names the field that actually failed when a 201 body is incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ node_id: 'N1' }), { status: 201 })))

    // 缺 attempt 却报「缺 node_id」会把排查引向错误的字段 —— 载荷里 node_id 明明在。
    const rejection = postPlacement({ base: 'http://scheduler', realm: 'realm-a', childId: 'child-1' })
    await expect(rejection).rejects.toThrow(/attempt/)
    await expect(rejection).rejects.not.toThrow(/缺 node_id/)
  })

  it('names node_id when it is the missing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ attempt: 1 }), { status: 201 })))

    await expect(postPlacement({ base: 'http://scheduler', realm: 'realm-a', childId: 'child-1' }))
      .rejects.toThrow(/node_id/)
  })
})
