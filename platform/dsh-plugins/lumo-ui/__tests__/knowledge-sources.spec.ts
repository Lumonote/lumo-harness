import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'

const config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'admin-a', roles: ['realm_admin'], projectId: '', deptId: '',
  controlPlaneToken: '', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
} as Config

function request(method: string, url: string, body?: unknown) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return Object.assign(Readable.from(chunks), { method, url, headers: {} })
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

const source = {
  docId: 'doc-ops', realm: 'realm-a', space: 'operations', title: '审批边界', sourceVersion: 2,
  embeddingModel: 'bge-m3', chunkCount: 1, updatedAt: '2026-09-01T00:00:00Z',
}

function manager() {
  return {
    query: vi.fn(),
    listSources: vi.fn().mockResolvedValue([source]),
    getSource: vi.fn(),
    upsertSource: vi.fn().mockResolvedValue(source),
    removeSource: vi.fn(),
    rebuild: vi.fn(),
  }
}

describe('knowledge source management API', () => {
  it('lists source summaries only for a realm administrator', async () => {
    const knowledge = manager()
    const { res, result } = response()
    await api(config, knowledge, undefined, undefined, undefined, request('GET', '/lumo/api/knowledge/sources') as never, res)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ realm: 'realm-a', state: 'synchronized', sources: [source] })
    expect(knowledge.listSources).toHaveBeenCalledWith('realm-a')
  })

  it('does not treat query authorization as source-management authorization', async () => {
    const knowledge = manager()
    const { res, result } = response()
    await api({ ...config, roles: ['viewer'] }, knowledge, undefined, undefined, undefined, request('GET', '/lumo/api/knowledge/sources') as never, res)

    expect(result.status).toBe(403)
    expect(knowledge.listSources).not.toHaveBeenCalled()
  })

  it('takes the realm from the signed/fallback identity rather than the request body', async () => {
    const knowledge = manager()
    const { res, result } = response()
    await api(config, knowledge, undefined, undefined, undefined, request('POST', '/lumo/api/knowledge/sources', {
      docId: 'doc-new', realm: 'other-realm', space: 'operations', title: '新来源',
      chunks: [{ text: '受管理的来源内容', metadata: { classification: 'internal' } }],
    }) as never, res)

    expect(result.status).toBe(201)
    expect(knowledge.upsertSource).toHaveBeenCalledWith({
      docId: 'doc-new', realm: 'realm-a', space: 'operations', title: '新来源',
      chunks: [{ text: '受管理的来源内容', metadata: { classification: 'internal' } }],
    })
  })

  it('requires an optimistic version for updates and reports a provider without source truth', async () => {
    const knowledge = manager()
    const missingVersion = response()
    await api(config, knowledge, undefined, undefined, undefined, request('PUT', '/lumo/api/knowledge/sources/doc-ops', {
      space: 'operations', title: '审批边界', chunks: [{ text: '内容', metadata: {} }],
    }) as never, missingVersion.res)
    expect(missingVersion.result.status).toBe(400)
    expect(knowledge.upsertSource).not.toHaveBeenCalled()

    const unsupported = response()
    await api(config, { query: vi.fn() }, undefined, undefined, undefined, request('GET', '/lumo/api/knowledge/sources') as never, unsupported.res)
    expect(unsupported.result.status).toBe(501)
  })
})
