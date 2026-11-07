import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'
import { encodeIdentityAssertion, signIdentityAssertion } from '../src/identity.ts'
import { KnowledgeSourceConflictError } from '../../knowledge/src/pg-provider.ts'
import { forbidden } from '../../../shared/seam-contracts/errors.ts'

const config: Config = {
  schedulerUrl: '', projectsUrl: 'http://projects.test', flowsUrl: '', connectorUrl: '', governanceUrl: 'http://governance.test', registryUrl: '',
  realm: 'realm-a', userId: 'member-a', roles: ['viewer'], projectId: 'project-a', deptId: 'dept-a',
  controlPlaneToken: 'management-test-service-token', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
  sessionControlUrl: '', desktopHandoffFile: '', skillhubCatalogFile: '', skillhubInstallFile: '', skillhubRoot: '',
  skillhubCommand: '', skillhubApiBase: '', skillhubSnapshotFile: '',
}
const digest = 'a'.repeat(64)

it('Space 授权代理使用受信身份与指定项目，保留 CAS 冲突且不转发伪造 query', async () => {
  const ready: Config = { ...config, collaboratorUrl: 'http://collaborator.test', deploymentMode: 'cluster', clusterStatus: 'ready' }
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"grants":[]}', { status: 200 })).mockResolvedValueOnce(new Response('{"error":"changed"}', { status: 409 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await invoke('GET', '/lumo/api/projects/p-1/spaces/s-1/grants?user_id=forged&realm=forged', { config: ready })).toEqual({ status: 200, body: { grants: [] } })
  expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://collaborator.test/v1/projects/p-1/spaces/s-1/grants', expect.objectContaining({ headers: trustedHeaders(), method: 'GET' }))
  const body = { permissions: ['read', 'edit'], expectedRevision: 4 }
  expect(await invoke('PUT', '/lumo/api/projects/p-1/spaces/s-1/grants/bob', { config: ready, body })).toEqual({ status: 409, body: { error: 'changed' } })
  expect(fetchMock).toHaveBeenLastCalledWith('http://collaborator.test/v1/projects/p-1/spaces/s-1/grants/bob', expect.objectContaining({ headers: { ...trustedHeaders(), 'content-type': 'application/json' }, method: 'PUT', body: JSON.stringify(body) }))
  expect((await invoke('DELETE', '/lumo/api/projects/p-1/spaces/s-1/grants/bob', { config: ready })).status).toBe(405)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
const file = {
  docId: 'file-report', realm: 'realm-a', folderId: null, filename: '报告.txt', mimeType: 'text/plain',
  objectKey: 'private/raw/objects/report', byteSize: 12, sha256: digest, ownerUserId: 'member-a',
  extractionState: 'ready' as const, ocrState: 'not_needed' as const, createdAt: '2026-11-07T00:00:00Z', canEdit: true,
}
const forgedHeaders = {
  'x-lumo-user': 'forged-user', 'x-lumo-realm': 'forged-realm', 'x-lumo-roles': 'platform_admin',
  'x-lumo-project': 'forged-project', 'x-lumo-dept': 'forged-dept', authorization: 'Bearer forged-token',
}

function libraryManager() {
  return {
    query: vi.fn().mockResolvedValue([]),
    listLibraryFolders: vi.fn().mockResolvedValue([]), canAccessLibraryFolder: vi.fn().mockResolvedValue(false),
    createLibraryFolder: vi.fn(), deleteLibraryFolder: vi.fn(),
    listLibraryFiles: vi.fn().mockResolvedValue([file]), getLibraryFile: vi.fn().mockResolvedValue(file),
    createLibraryFile: vi.fn(), removeLibraryFile: vi.fn(), deleteLibraryFile: vi.fn().mockResolvedValue(undefined),
    canAccessLibraryFile: vi.fn().mockResolvedValue(false), setLibraryGrants: vi.fn(), listLibraryGrants: vi.fn(),
    getSource: vi.fn(), upsertSource: vi.fn(),
  }
}

async function invoke(method: string, url: string, options: {
  body?: unknown; knowledge?: ReturnType<typeof libraryManager>; config?: Config; headers?: Record<string, string>
} = {}) {
  const req = Object.assign(Readable.from(options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]), {
    method, url, headers: { ...forgedHeaders, ...options.headers },
  })
  const result = { status: 0, body: undefined as unknown }
  const res = {
    setHeader() {}, writeHead(status: number) { result.status = status },
    end(chunk?: string) { result.body = chunk === undefined ? undefined : JSON.parse(chunk) },
  }
  await api(options.config ?? config, options.knowledge, undefined, undefined, undefined, req as never, res as never)
  return result
}

function trustedHeaders(userId = 'member-a', realm = 'realm-a', roles = 'viewer', project = 'project-a', dept = 'dept-a') {
  return { Authorization: 'Bearer management-test-service-token', 'X-Lumo-User': userId, 'X-Lumo-Realm': realm,
    'X-Lumo-Roles': roles, 'X-Lumo-Project': project, 'X-Lumo-Dept': dept }
}

afterEach(() => vi.unstubAllGlobals())

describe('用户目录与项目管理代理边界', () => {
  it('只代理允许的用户列表过滤参数，保留重复值，丢弃调用方伪造的身份参数和请求头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ users: [], total: 0 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await invoke('GET', '/lumo/api/users?q=alice&q=bob&status=active&status=disabled&department_id=dept-1&limit=20&limit=40&offset=3&realm=forged&user_id=forged&roles=platform_admin&project_id=forged&unknown=discard')
    expect(result).toEqual({ status: 200, body: { users: [], total: 0 } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    const target = new URL(url)
    expect(target.origin + target.pathname).toBe('http://governance.test/v1/users')
    expect([...target.searchParams]).toEqual([
      ['q', 'alice'], ['q', 'bob'], ['status', 'active'], ['status', 'disabled'],
      ['department_id', 'dept-1'], ['limit', '20'], ['limit', '40'], ['offset', '3'],
    ])
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: trustedHeaders() })
    expect(Object.values(init.headers)).not.toContain('forged-user')
  })

  it('项目详情与修改使用签名身份，并保留上游并发冲突状态和内容', async () => {
    const secret = 'test-management-identity-secret-32-bytes'
    const assertion = encodeIdentityAssertion({ aud: 'lumo-ui', exp: Math.floor(Date.now() / 1000) + 60,
      realm: 'signed-realm', userId: 'signed-user', roles: ['manager'], projectId: 'signed-project', deptId: 'signed-dept' })
    const signed = { config: { ...config, identityAssertionSecret: secret }, headers: {
      'x-lumo-identity': assertion, 'x-lumo-identity-signature': signIdentityAssertion(assertion, secret),
    } }
    const conflict = { error: 'project_changed', current_updated_at: '2026-11-07T00:01:00Z' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'project-b', title: '项目' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(conflict), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await invoke('GET', '/lumo/api/projects/project-b?realm=forged', signed)).toEqual({ status: 200, body: { id: 'project-b', title: '项目' } })
    const mutation = { title: '更新后的项目', description: '业务说明', expected_updated_at: '2026-11-07T00:00:00Z' }
    expect(await invoke('PATCH', '/lumo/api/projects/project-b', { ...signed, body: mutation })).toEqual({ status: 409, body: conflict })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('http://projects.test/v1/projects/project-b')
      expect(init).toMatchObject({ redirect: 'error', headers: trustedHeaders('signed-user', 'signed-realm', 'manager', 'signed-project', 'signed-dept') })
    }
    expect(fetchMock.mock.calls[0]![1].method).toBe('GET')
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'PATCH', body: JSON.stringify(mutation) })
  })

  it('缺失有效签名时在任何项目上游调用前拒绝请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await invoke('PATCH', '/lumo/api/projects/project-b', { config: { ...config, identityAssertionSecret: 'management-identity-secret-at-least-32' }, body: { title: 'forged' } })).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('资料库文件管理 API', () => {
  it('列表公开版本 SHA 与权限提示，同时隐藏对象存储键和内部字段', async () => {
    const knowledge = libraryManager()
    knowledge.listLibraryFiles.mockResolvedValue([{ ...file, canEdit: false, internalSecret: 'hidden' } as typeof file, file])
    const result = await invoke('GET', '/lumo/api/knowledge/library/files?realm=forged', { knowledge })
    expect(result.status).toBe(200)
    const files = (result.body as { files: Array<Record<string, unknown>> }).files
    expect(files.map(item => [item.sha256, item.canEdit])).toEqual([[digest, false], [digest, true]])
    for (const item of files) { expect(item).not.toHaveProperty('objectKey'); expect(item).not.toHaveProperty('internalSecret') }
    expect(knowledge.listLibraryFiles).toHaveBeenCalledWith('realm-a', 'member-a', ['viewer'], false)
  })

  it('删除只调用完整生命周期方法，并从可信身份传入 actor、realm、roles 与管理员标记', async () => {
    const knowledge = libraryManager()
    const result = await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { knowledge, body: {
      expectedSha256: digest, realm: 'forged', actorUserId: 'forged', userId: 'forged', roles: ['platform_admin'], isAdmin: true,
    } })
    expect(result).toEqual({ status: 200, body: { docId: 'file-report', state: 'removed' } })
    expect(knowledge.getLibraryFile).toHaveBeenCalledWith('file-report', 'realm-a')
    expect(knowledge.deleteLibraryFile).toHaveBeenCalledExactlyOnceWith({ realm: 'realm-a', docId: 'file-report', actorUserId: 'member-a', roles: ['viewer'], isAdmin: false, expectedSha256: digest })
    expect(knowledge.removeLibraryFile).not.toHaveBeenCalled()
  })

  it('缺少或无效 SHA 在任何删除写入前返回 400', async () => {
    const knowledge = libraryManager()
    for (const body of [{}, { expectedSha256: null }, { expectedSha256: 123 }, { expectedSha256: 'bad' }, { expectedSha256: 'A'.repeat(64) }, { expectedSha256: 'a'.repeat(63) }]) {
      expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { knowledge, body })).status).toBe(400)
    }
    expect(knowledge.deleteLibraryFile).not.toHaveBeenCalled()
    expect(knowledge.removeLibraryFile).not.toHaveBeenCalled()
  })

  it('旧 Provider 没有完整删除能力时返回 501，不回退到只删元数据', async () => {
    const knowledge = libraryManager()
    delete (knowledge as Partial<typeof knowledge>).deleteLibraryFile
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { knowledge, body: { expectedSha256: digest } })).status).toBe(501)
    expect(knowledge.removeLibraryFile).not.toHaveBeenCalled()
  })

  it('权限拒绝映射为 403，来源版本冲突映射为 409，均保留生命周期原子性边界', async () => {
    const knowledge = libraryManager()
    knowledge.deleteLibraryFile.mockRejectedValueOnce(forbidden('没有删除权限'))
      .mockRejectedValueOnce(new KnowledgeSourceConflictError('内容已变化'))
    expect(await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { knowledge, body: { expectedSha256: digest } })).toEqual({ status: 403, body: { error: '没有删除权限' } })
    expect(await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { knowledge, body: { expectedSha256: digest } })).toEqual({ status: 409, body: { error: '内容已变化' } })
    expect(knowledge.deleteLibraryFile).toHaveBeenCalledTimes(2)
    expect(knowledge.removeLibraryFile).not.toHaveBeenCalled()
  })

  it('不存在的文件返回 404，未装配资料库能力返回 501', async () => {
    const knowledge = libraryManager()
    knowledge.getLibraryFile.mockResolvedValue(undefined)
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { knowledge, body: { expectedSha256: digest } })).status).toBe(404)
    expect(knowledge.deleteLibraryFile).not.toHaveBeenCalled()
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-report', { body: { expectedSha256: digest } })).status).toBe(501)
  })
})
