import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorClient } from '../src/client.ts'

afterEach(() => vi.unstubAllGlobals())

describe('ConnectorClient', () => {
  it('binds the control-plane token and server-side identity to every request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ connectors: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = new ConnectorClient({
      gatewayUrl: 'http://connector-gateway',
      controlPlaneToken: 'control-token',
      realm: 'realm-a',
      userId: 'user-a',
      roles: ['operator'],
      projectId: 'project-a',
    })

    await expect(client.list()).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledWith('http://connector-gateway/connectors', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer control-token',
        'X-Lumo-User': 'user-a',
        'X-Lumo-Realm': 'realm-a',
        'X-Lumo-Roles': 'operator',
        'X-Lumo-Project': 'project-a',
      }),
    }))
  })
})
