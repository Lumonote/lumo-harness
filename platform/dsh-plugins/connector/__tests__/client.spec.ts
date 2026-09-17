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

/**
 * 会话归属头（§10.1 外部调用时间线的前置）。
 *
 * 网关把 `X-Lumo-Session` 写进 `connector_audit.session_id`，并在缺省时回落
 * `"system"` —— **不发它不会报错，只会静默丢掉会话归属**。因此这里钉的是
 * 「发了要原样到达」与「没有就不要发一个看起来有值的空串」两件事。
 */
describe('ConnectorClient 会话归属', () => {
  const headersOf = async (path: string, call: (client: ConnectorClient) => Promise<unknown>) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 200, durationMs: 1, redacted: false }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const client = new ConnectorClient({ gatewayUrl: 'http://connector-gateway', realm: 'realm-a', userId: 'user-a', roles: [] })
    await call(client)
    const sent = fetch.mock.calls.find(([url]) => String(url).endsWith(path))
    if (!sent) throw new Error(`没有发往 ${path} 的请求`)
    return (sent[1] as RequestInit).headers as Record<string, string>
  }

  const invoke = (extra: { sessionRef?: string }) => (client: ConnectorClient) =>
    client.invoke({ connectorId: 'c1', operation: 'op', ...extra })

  it('带会话 ref 时原样发出 —— 网关据此写 connector_audit.session_id', async () => {
    const headers = await headersOf('/connectors/c1/invoke', invoke({ sessionRef: 'sess-1' }))
    expect(headers['X-Lumo-Session']).toBe('sess-1')
  })

  it('没有会话时不发这个头，让网关按 system 回落', async () => {
    const headers = await headersOf('/connectors/c1/invoke', invoke({}))
    expect('X-Lumo-Session' in headers).toBe(false)
  })

  it('空白串也不发 —— 发空串会让网关两侧的 def() 拿到一个「看起来有会话」的值', async () => {
    const headers = await headersOf('/connectors/c1/invoke', invoke({ sessionRef: '   ' }))
    expect('X-Lumo-Session' in headers).toBe(false)
  })

  it('webFetch 走同一条规则（它也是被审计的出站路径）', async () => {
    const headers = await headersOf('/web/fetch', (client) => client.webFetch({ url: 'https://example.test/', sessionRef: 'sess-2' }))
    expect(headers['X-Lumo-Session']).toBe('sess-2')
  })
})
