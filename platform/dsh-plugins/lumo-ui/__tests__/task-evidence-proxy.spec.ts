import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
  realm: 'realm-a', userId: 'editor-a', roles: ['editor'], projectId: 'project-a', deptId: '',
  controlPlaneToken: 'test-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config

function request(method: string, url: string) {
  return Object.assign(Readable.from([]), { method, url, headers: {} })
}

function response(): { res: import('node:http').ServerResponse; result: { status: number; body: unknown } } {
  const result = { status: 0, body: undefined as unknown }
  const res = {
    setHeader: () => undefined,
    writeHead: (status: number) => { result.status = status; return res },
    end: (chunk?: string) => { result.body = chunk === undefined ? undefined : JSON.parse(chunk); return res },
  }
  return { res: res as unknown as import('node:http').ServerResponse, result }
}

async function forward(method: string, url: string, payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const { res, result } = response()
  await api(config, undefined, undefined, undefined, undefined, request(method, url) as never, res)
  return { fetchMock, result }
}

describe('task collaboration and run result proxy', () => {
  afterEach(() => vi.unstubAllGlobals())

  // The ops surface reads child progress from one governance face and the full
  // evidence from another. Both are separate routes upstream, so both need a
  // route here -- a proxy that forwards only one of them looks identical to a
  // backend that is missing the other.
  it('forwards the collaboration view', async () => {
    const { fetchMock, result } = await forward('GET', '/lumo/api/tasks/task-1/collaboration', { summary: { total: 1 }, children: [] })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ summary: { total: 1 }, children: [] })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://governance.test/v1/tasks/task-1/collaboration',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('forwards the full run result', async () => {
    const { fetchMock, result } = await forward('GET', '/lumo/api/tasks/task-1/runs/run-1/result', { state: 'COMPLETED', output: { a: 1 } })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ state: 'COMPLETED', output: { a: 1 } })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://governance.test/v1/tasks/task-1/runs/run-1/result',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  // The run list is a distinct path one segment shorter; a result route that
  // matched too greedily would shadow it and return evidence where a list was
  // expected.
  it('leaves the run list route untouched', async () => {
    const { fetchMock } = await forward('GET', '/lumo/api/tasks/task-1/runs', [])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://governance.test/v1/tasks/task-1/runs',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('refuses identifiers the proxy does not accept', async () => {
    const oversized = await forward('GET', `/lumo/api/tasks/${'a'.repeat(129)}/collaboration`, {})
    expect(oversized.result.status).toBe(400)
    expect(oversized.fetchMock).not.toHaveBeenCalled()

    const malformed = await forward('GET', '/lumo/api/tasks/task-1/runs/bad%20id/result', {})
    expect(malformed.result.status).toBe(400)
    expect(malformed.fetchMock).not.toHaveBeenCalled()
  })
})
