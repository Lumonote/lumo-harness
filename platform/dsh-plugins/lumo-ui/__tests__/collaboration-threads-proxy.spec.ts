import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'
import { encodeIdentityAssertion, signIdentityAssertion } from '../src/identity.ts'

const secret = 'test-identity-assertion-secret-32-bytes-long'
const config = {
  realm: 'fallback', userId: 'fallback', roles: ['realm_admin'], identityAssertionSecret: secret,
  deploymentMode: 'cluster', clusterStatus: 'ready', governanceUrl: 'http://governance.invalid',
  sessionControlUrl: 'http://controls.invalid', controlPlaneToken: 'fixture-control-token', timeoutMs: 5000,
} as Config

afterEach(() => vi.unstubAllGlobals())

async function readFleet(registry: { listThreads: () => Promise<never[]> | Promise<unknown[]> }, query = 'session_ref=browser-forged&realm=forged') {
  const encoded = encodeIdentityAssertion({ aud: 'lumo-ui', exp: Math.floor(Date.now() / 1000) + 60, realm: 'realm-a', userId: 'reader', roles: ['operator'] })
  const req = Object.assign(Readable.from([]), {
    method: 'GET', url: `/lumo/api/collaboration/threads?${query}`,
    headers: { 'x-lumo-identity': encoded, 'x-lumo-identity-signature': signIdentityAssertion(encoded, secret), 'x-lumo-realm': 'forged' },
  })
  const result = { status: 0, body: undefined as unknown }
  const res = {
    setHeader: () => {}, writeHead: (status: number) => { result.status = status },
    end: (data: string) => { result.body = JSON.parse(data) },
  }
  await api(config, undefined, undefined, undefined, undefined, req as never, res as never,
    undefined, undefined, undefined, undefined, registry as never)
  return result
}

describe('线程聚合同源代理', () => {
  it('只使用签名身份和服务端会话关联；忽略浏览器伪造的 realm/session_ref', async () => {
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      expect(headers['X-Lumo-Realm']).toBe('realm-a')
      expect(headers['X-Lumo-User']).toBe('reader')
      expect(headers.Authorization).toBe('Bearer fixture-control-token')
      const url = new URL(input)
      if (url.hostname === 'governance.invalid') {
        expect(url.searchParams.get('limit')).toBe('200')
        expect(url.searchParams.get('cursor')).toBe('')
        expect(url.searchParams.has('realm')).toBe(false)
        return Response.json({ tasks: [{ id: 'visible', title: '任务' }] })
      }
      expect(url.searchParams.getAll('session_ref')).toEqual(['server-session'])
      return Response.json({ realm: 'realm-a', controls: [{ session_ref: 'server-session', registered: true, state: 'awaiting-approval' }] })
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await readFleet({ listThreads: async () => [{
      id: 'th1', realm: 'realm-a', task_id: 'visible', session_ref: 'server-session', node_id: 'node-1', state: 'running', updated_at: new Date().toISOString(),
    }] })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ threads: [{ id: 'thread:th1', control_state: 'awaiting-approval' }] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('治理授权拒绝时立即返回，不继续读取线程或控制态', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    const listThreads = vi.fn(async () => [])
    const result = await readFleet({ listThreads })
    expect(result.status).toBe(403)
    expect(listThreads).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('任务与线程游标各自传递，只向注册表传服务端可见任务', async () => {
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input)
      expect(url.hostname).toBe('governance.invalid')
      expect([...url.searchParams]).toEqual([['limit', '200'], ['cursor', 'opaque:task/cursor']])
      return Response.json({ tasks: [{ id: 'visible-2' }], next_cursor: 'next-page' })
    })
    vi.stubGlobal('fetch', fetcher)
    const listThreads = vi.fn(async () => [])
    const result = await readFleet({ listThreads }, new URLSearchParams({
      task_cursor: 'opaque:task/cursor', thread_after: 'thread-499', task_id: 'hidden', limit: '10000', realm: 'forged', session_ref: 'secret',
    }).toString())
    expect(result.status).toBe(200)
    expect(listThreads).toHaveBeenCalledExactlyOnceWith({ limit: 500, after: 'thread-499', taskIds: ['visible-2'] })
    expect(result.body).toMatchObject({ pagination: { nextTaskCursor: 'next-page', nextThreadCursor: '', taskCount: 1 } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('空任务页不扫描注册表，也不查询任意会话', async () => {
    const fetcher = vi.fn(async () => Response.json({ tasks: [], next_cursor: '' }))
    vi.stubGlobal('fetch', fetcher)
    const listThreads = vi.fn(async () => [])
    const result = await readFleet({ listThreads })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ threads: [], pagination: { nextTaskCursor: '', nextThreadCursor: '', taskCount: 0 } })
    expect(listThreads).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('非法游标本地拒绝；上游坏游标错误直接保留', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'invalid page cursor' }, { status: 400 }))
    vi.stubGlobal('fetch', fetcher)
    const listThreads = vi.fn(async () => [])
    for (const query of [new URLSearchParams({ task_cursor: 'a'.repeat(4097) }), new URLSearchParams({ thread_after: 'a'.repeat(201) }), new URLSearchParams({ thread_after: 'bad\nvalue' })]) {
      expect((await readFleet({ listThreads }, query.toString())).status).toBe(400)
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(listThreads).not.toHaveBeenCalled()
    expect((await readFleet({ listThreads }, 'task_cursor=bad')).status).toBe(400)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(listThreads).not.toHaveBeenCalled()
  })
})
