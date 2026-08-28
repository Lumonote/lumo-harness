import { describe, expect, it, vi } from 'vitest'

import { resolveNacosNode } from '../src/nacos.ts'

describe('resolveNacosNode', () => {
  it('resolves a healthy scaled node by Nacos node_id metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      hosts: [
        { ip: '10.0.0.9', port: 8091, healthy: true, enabled: true, metadata: { node_id: 'dsh-9' } },
        { ip: '10.0.0.8', port: 8091, healthy: true, enabled: true, metadata: { node_id: 'dsh-8' } },
      ],
    }), { status: 200 }))

    await expect(resolveNacosNode({
      baseUrl: 'http://nacos:8848/',
      serviceName: 'lumo-dsh-node',
      groupName: 'DEFAULT_GROUP',
      fetch,
    }, 'dsh-9')).resolves.toEqual({ nodeId: 'dsh-9', baseUrl: 'http://10.0.0.9:8091' })
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/nacos/v1/ns/instance/list?'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('does not route to unhealthy, disabled, or unknown nodes', async () => {
    const body = JSON.stringify({
      hosts: [
        { ip: '10.0.0.1', port: 8091, healthy: false, enabled: true, metadata: { node_id: 'dsh-1' } },
        { ip: '10.0.0.2', port: 8091, healthy: true, enabled: false, metadata: { node_id: 'dsh-2' } },
      ],
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      new Response(body, { status: 200 }))

    await expect(resolveNacosNode({
      baseUrl: 'http://nacos:8848', serviceName: 'lumo-dsh-node', groupName: 'DEFAULT_GROUP', fetch,
    }, 'dsh-1')).resolves.toBeUndefined()
    await expect(resolveNacosNode({
      baseUrl: 'http://nacos:8848', serviceName: 'lumo-dsh-node', groupName: 'DEFAULT_GROUP', fetch,
    }, 'dsh-3')).resolves.toBeUndefined()
  })

  it('fails closed on a Nacos error response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status: 503 }))
    await expect(resolveNacosNode({
      baseUrl: 'http://nacos:8848', serviceName: 'lumo-dsh-node', groupName: 'DEFAULT_GROUP', fetch,
    }, 'dsh-9')).rejects.toThrow('HTTP 503')
  })
})
