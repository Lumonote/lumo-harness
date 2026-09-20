/**
 * 线程注册表客户端（`control-plane/collaborator` 的 `/threads`）。
 *
 * `fetch` 是注入的：全部路径（201/200/404/409/500、脏返回体、请求头与请求体）都能在
 * `environment: 'node'` 下覆盖，不必起一个协作服务。
 */
import { describe, expect, it } from 'vitest'

import { createHttpThreadRegistry, ThreadRegistryError } from '../src/thread-registry.ts'

/** 一次被观察到的请求。 */
interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** 假 fetch：按队列返回响应，并记录请求。 */
function fetchSpy(responses: { status: number; body: string }[]): {
  fetch: typeof globalThis.fetch
  calls: Call[]
} {
  const calls: Call[] = []
  let index = 0
  const fake = async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const response = responses[Math.min(index, responses.length - 1)]!
    index += 1
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    })
    return {
      status: response.status,
      text: async () => response.body,
    } as unknown as Response
  }
  return { fetch: fake as unknown as typeof globalThis.fetch, calls }
}

const ROW = JSON.stringify({
  id: 't-1',
  realm: 'realm-1',
  project_id: 'proj-1',
  task_id: 'task-7',
  coordinator_session_ref: 'coord-1',
  session_ref: 'sess-1',
  node_id: 'node-a',
  workspace: 'thread/t-1/',
  state: 'idle',
  created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-20T10:00:00Z',
})

function registry(fetch: typeof globalThis.fetch) {
  return createHttpThreadRegistry({
    baseUrl: 'http://collaborator:8081/',
    userId: 'u-1',
    realm: 'realm-1',
    fetch,
  })
}

describe('协议面', () => {
  it('realm 与身份走请求头，不进请求体', async () => {
    // 一个能自报 realm 的写入口等于没有租户边界 —— 服务端也是这么读的
    // （见 cmd/collaborator/main.go 的 headerAuth）。
    const spy = fetchSpy([{ status: 201, body: ROW }])
    await registry(spy.fetch).create({
      id: 't-1',
      project_id: 'proj-1',
      task_id: 'task-7',
      coordinator_session_ref: 'coord-1',
      session_ref: 'sess-1',
      node_id: 'node-a',
      workspace: 'thread/t-1/',
    })
    const call = spy.calls[0]!
    expect(call.url).toBe('http://collaborator:8081/threads')
    expect(call.method).toBe('POST')
    expect(call.headers['x-lumo-realm']).toBe('realm-1')
    expect(call.headers['x-lumo-user']).toBe('u-1')
    expect(call.body).not.toHaveProperty('realm')
  })

  it('列表把过滤条件拼成查询串', async () => {
    const spy = fetchSpy([{ status: 200, body: '[]' }])
    await registry(spy.fetch).list({ project_id: 'proj-1', state: 'awaiting', limit: 5 })
    expect(spy.calls[0]!.url).toBe('http://collaborator:8081/threads?project_id=proj-1&state=awaiting&limit=5')
    await registry(spy.fetch).list()
    expect(spy.calls[1]!.url).toBe('http://collaborator:8081/threads')
  })

  it('空基址 / 空身份 / 空 realm 直接拒绝装配', () => {
    // 缺任何一样，线程面的动作都只会失败得更晚、更难查。
    expect(() => createHttpThreadRegistry({ baseUrl: '  ', userId: 'u', realm: 'r' })).toThrow(ThreadRegistryError)
    expect(() => createHttpThreadRegistry({ baseUrl: 'http://x', userId: '', realm: 'r' })).toThrow(/身份/)
    expect(() => createHttpThreadRegistry({ baseUrl: 'http://x', userId: 'u', realm: '' })).toThrow(/realm/)
  })
})

describe('失败路径', () => {
  it('404 是 undefined（只对 get）：不存在是正常答案，不是异常', async () => {
    const spy = fetchSpy([{ status: 404, body: '{"error":"线程不存在（或不属于本 realm）"}' }])
    await expect(registry(spy.fetch).get('t-9')).resolves.toBeUndefined()
  })

  it('其它非 2xx 抛出服务端原文与状态码', async () => {
    const spy = fetchSpy([{ status: 409, body: '{"error":"该 session_ref 已属于另一条线程"}' }])
    await expect(registry(spy.fetch).transition('t-1', 'running')).rejects.toThrow(/409/)
    await expect(registry(spy.fetch).transition('t-1', 'running')).rejects.toThrow(/已属于另一条线程/)
  })

  it('非 JSON 的失败体也照样带出去（不吞成「未知错误」）', async () => {
    const spy = fetchSpy([{ status: 502, body: 'bad gateway' }])
    await expect(registry(spy.fetch).nodeLoss('t-1', 'node-a')).rejects.toThrow(/bad gateway/)
  })

  it('脏返回体一律拒绝：未知状态、串号的 id', async () => {
    const unknownState = fetchSpy([{ status: 200, body: ROW.replace('"idle"', '"paused"') }])
    await expect(registry(unknownState.fetch).get('t-1')).rejects.toThrow(/不在闭集内/)
    const wrongId = fetchSpy([{ status: 200, body: ROW.replace('"t-1"', '"t-2"') }])
    await expect(registry(wrongId.fetch).get('t-1')).rejects.toThrow(/请求的是 t-1/)
  })

  it('列表返回非数组即拒（不能把半个响应当成空列表）', async () => {
    const spy = fetchSpy([{ status: 200, body: '{"threads":[]}' }])
    await expect(registry(spy.fetch).list()).rejects.toThrow(/不是数组/)
  })
})

describe('成功路径', () => {
  it('五个动作各自解出线程行', async () => {
    const spy = fetchSpy([
      { status: 201, body: ROW },
      { status: 200, body: ROW },
      { status: 200, body: `[${ROW}]` },
      { status: 200, body: ROW.replace('"idle"', '"awaiting"') },
      { status: 200, body: ROW.replace('"idle"', '"failed"') },
    ])
    const client = registry(spy.fetch)
    await expect(client.create({
      id: 't-1', project_id: 'proj-1', task_id: 'task-7',
      coordinator_session_ref: 'coord-1', session_ref: 'sess-1', node_id: 'node-a',
    })).resolves.toMatchObject({ id: 't-1', workspace: 'thread/t-1/' })
    await expect(client.get('t-1')).resolves.toMatchObject({ id: 't-1' })
    await expect(client.list()).resolves.toHaveLength(1)
    await expect(client.transition('t-1', 'awaiting')).resolves.toMatchObject({ state: 'awaiting' })
    await expect(client.nodeLoss('t-1', 'node-a')).resolves.toMatchObject({ state: 'failed' })
    // 节点丢失上报带的是 node_id：服务端按它拦「拿别的节点名关掉这条线程」。
    expect(spy.calls[4]!.body).toEqual({ node_id: 'node-a' })
    expect(spy.calls[3]!.body).toEqual({ to: 'awaiting' })
  })

  it('省略 workspace 时不往请求体里塞空值（由服务端按 thread/<id>/ 派生）', async () => {
    const spy = fetchSpy([{ status: 201, body: ROW }])
    await registry(spy.fetch).create({
      id: 't-1', project_id: 'proj-1', task_id: 'task-7',
      coordinator_session_ref: 'coord-1', session_ref: 'sess-1', node_id: 'node-a',
    })
    expect(spy.calls[0]!.body).not.toHaveProperty('workspace')
  })

  it('读节点失联通知：游标是 seq 而不是时间戳（同毫秒的多条不会被跳过）', async () => {
    const NOTICE = {
      seq: 12, realm: 'realm-1', thread_id: 't-1', node_id: 'node-a',
      session_ref: 'sess-1', coordinator_session_ref: 'coord-1',
      reason: '承载节点 node-a 丢失', created_at: '2026-09-20T10:00:00Z',
    }
    const spy = fetchSpy([{ status: 200, body: JSON.stringify([NOTICE]) }])
    const client = registry(spy.fetch)
    await expect(client.nodeLossNotices({ since: 11, limit: 50 })).resolves.toEqual([NOTICE])
    expect(spy.calls[0]!.url).toContain('/threads/node-loss-notices?since=11&limit=50')
    expect(spy.calls[0]!.method).toBe('GET')
    expect(spy.calls[0]!.headers['x-lumo-realm']).toBe('realm-1')
  })

  it('脏通知在客户端就被拒（进了唤醒路径的症状是「永远不醒」或「唤醒错的线程」）', async () => {
    // 缺协调者 ref：这条通知投不出去，而它在日志里看起来完全正常。
    const dirty = JSON.stringify([{
      seq: 1, realm: 'realm-1', thread_id: 't-1', node_id: 'node-a',
      session_ref: 'sess-1', reason: 'x', created_at: '2026-09-20T10:00:00Z',
    }])
    await expect(registry(fetchSpy([{ status: 200, body: dirty }]).fetch).nodeLossNotices())
      .rejects.toThrow(/coordinator_session_ref/)
    // 返回的不是数组同样响亮。
    await expect(registry(fetchSpy([{ status: 200, body: '{"not":"an array"}' }]).fetch).nodeLossNotices())
      .rejects.toThrow(/不是数组/)
  })
})
