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
      base: 'http://scheduler', realm: 'realm-a', childId: 'child-1', state: 'COMPLETED', attempt: 2, controlPlaneToken: 'control-token',
    })).resolves.toBeUndefined()

    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer control-token', 'x-lumo-realm': 'realm-a' })
    }
  })
})
