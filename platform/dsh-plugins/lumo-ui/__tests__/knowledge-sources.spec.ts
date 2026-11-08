import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { api, type Config } from '../src/index.ts'
import { encodeIdentityAssertion, signIdentityAssertion } from '../src/identity.ts'

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

  it('lets the local desktop read sources without admin roles (single-machine vault fallback identity)', async () => {
    const knowledge = manager()
    const { res, result } = response()
    await api({ ...config, deploymentMode: 'local', roles: ['operator'] }, knowledge, undefined, undefined, undefined, request('GET', '/lumo/api/knowledge/sources') as never, res)

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ realm: 'realm-a', state: 'synchronized', sources: [source] })
    expect(knowledge.listSources).toHaveBeenCalledWith('realm-a')
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

describe('knowledge query space narrowing', () => {
  it.each([undefined, [], ['operations'], ['产品知识', 'operations', 'operations']])('passes spaces %j with only the current trusted identity', async spaces => {
    const knowledge = manager(); knowledge.query.mockResolvedValue([])
    const { res, result } = response()
    await api({ ...config, roles: ['viewer'], userId: 'viewer-a' }, knowledge, undefined, undefined, undefined, request('POST', '/lumo/api/knowledge/query', {
      text: '  如何审批  ', topK: 3, ...(spaces === undefined ? {} : { spaces }),
      realm: 'foreign', roles: ['realm_admin'], userId: 'attacker', libraryAdmin: true, scope: 'draft',
    }) as never, res)
    expect(result.status).toBe(200)
    expect(knowledge.query).toHaveBeenCalledWith({ realm: 'realm-a', roles: ['viewer'], userId: 'viewer-a', libraryAdmin: false, text: '如何审批', topK: 3, scope: 'published', ...(spaces === undefined ? {} : { spaces: [...new Set(spaces)] }) })
    expect(result.body).toEqual({ query: '如何审批', scope: 'published', hits: [] })
  })
  it.each([null, 'operations', {}, [null], [''], [' space'], ['space '], ['space\u0000'], ['a'.repeat(129)], Array.from({ length: 65 }, () => 'a')])('rejects malformed or oversized space selectors %j', async spaces => {
    const knowledge = manager(); const { res, result } = response()
    await api(config, knowledge, undefined, undefined, undefined, request('POST', '/lumo/api/knowledge/query', { text: '审批', spaces }) as never, res)
    expect(result.status).toBe(400); expect(knowledge.query).not.toHaveBeenCalled()
  })
  it('does not turn empty spaces into a bypass of provider authorization', async () => {
    const knowledge = manager(); knowledge.query.mockRejectedValue(Object.assign(Error('knowledge forbidden'), { code: 'forbidden' }))
    const { res, result } = response()
    await api(config, knowledge, undefined, undefined, undefined, request('POST', '/lumo/api/knowledge/query', { text: '审批', spaces: [] }) as never, res)
    expect(knowledge.query).toHaveBeenCalledWith(expect.objectContaining({ spaces: [], realm: 'realm-a' }))
    expect(result.status).not.toBe(200)
  })
})

it('binds narrowed knowledge queries to signed browser identity instead of deployment defaults', async () => {
  const secret = '0123456789abcdef0123456789abcdef'
  const encoded = encodeIdentityAssertion({ aud: 'lumo-ui', exp: Math.floor(Date.now() / 1000) + 60, realm: 'signed-realm', userId: 'signed-user', roles: ['viewer'] })
  const req = request('POST', '/lumo/api/knowledge/query', { text: '审批', spaces: ['team-space'], realm: 'forged', userId: 'forged', roles: ['admin'], libraryAdmin: true })
  req.headers = { 'x-lumo-identity': encoded, 'x-lumo-identity-signature': signIdentityAssertion(encoded, secret) }
  const knowledge = manager(); knowledge.query.mockResolvedValue([]); const { res, result } = response()
  await api({ ...config, identityAssertionSecret: secret }, knowledge, undefined, undefined, undefined, req as never, res)
  expect(result.status).toBe(200)
  expect(knowledge.query).toHaveBeenCalledWith({ realm: 'signed-realm', userId: 'signed-user', roles: ['viewer'], libraryAdmin: false, text: '审批', topK: 8, scope: 'published', spaces: ['team-space'] })
})
