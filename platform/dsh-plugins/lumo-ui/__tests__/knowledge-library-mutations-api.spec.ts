import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { api, type Config } from '../src/index.ts'
import { forbidden } from '../../../shared/seam-contracts/errors.ts'
import { KnowledgeSourceConflictError } from '../../knowledge/src/pg-provider.ts'

const config: Config = {
  schedulerUrl: '', projectsUrl: '', flowsUrl: '', connectorUrl: '', governanceUrl: '', registryUrl: '',
  realm: 'realm-a', userId: 'member-a', roles: ['viewer'], projectId: 'project-a', deptId: 'dept-a',
  controlPlaneToken: '', identityAssertionSecret: '', timeoutMs: 5000,
  deploymentMode: 'standalone', storageBackend: 'postgres', middleware: [], clusterStatus: 'not_ready', plugins: [],
  sessionControlUrl: '', desktopHandoffFile: '', skillhubCatalogFile: '', skillhubInstallFile: '', skillhubRoot: '',
  skillhubCommand: '', skillhubApiBase: '', skillhubSnapshotFile: '',
}
const file = {
  docId: 'file-a', realm: 'realm-a', folderId: 'folder-a', filename: '报告.txt', mimeType: 'text/plain',
  objectKey: 'private/objects/raw-report', byteSize: 12, sha256: 'a'.repeat(64), ownerUserId: 'member-a',
  extractionState: 'ready' as const, ocrState: 'not_needed' as const, createdAt: '2026-11-07T00:00:00Z', revision: 3, canEdit: true,
}
const folder = { folderId: 'folder-a', realm: 'realm-a', parentId: null, name: '业务', ownerUserId: 'member-a', createdAt: file.createdAt, revision: 4, canEdit: true }
function manager() {
  return {
    query: vi.fn().mockResolvedValue([]),
    listLibraryFolders: vi.fn().mockResolvedValue([folder]), canAccessLibraryFolder: vi.fn().mockResolvedValue(true),
    createLibraryFolder: vi.fn(), updateLibraryFolder: vi.fn().mockResolvedValue({ ...folder, name: '更新', revision: 5 }), deleteLibraryFolder: vi.fn(),
    listLibraryFiles: vi.fn().mockResolvedValue([file]), getLibraryFile: vi.fn().mockResolvedValue(file),
    createLibraryFile: vi.fn(), removeLibraryFile: vi.fn(), deleteLibraryFile: vi.fn(),
    updateLibraryFile: vi.fn().mockResolvedValue({ ...file, filename: '更新.txt', revision: 4 }),
    canAccessLibraryFile: vi.fn().mockResolvedValue(true), setLibraryGrants: vi.fn(), listLibraryGrants: vi.fn(),
    getSource: vi.fn(), upsertSource: vi.fn(),
  }
}
const objectStore = () => ({ putContent: vi.fn().mockResolvedValue('private/new-object'), get: vi.fn() })
async function invoke(method: string, path: string, knowledge: ReturnType<typeof manager>, body?: unknown, objects?: ReturnType<typeof objectStore>) {
  const bytes = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]
  const req = Object.assign(Readable.from(bytes), { method, url: path, headers: {
    'x-lumo-file-name': encodeURIComponent('上传.txt'),
    'x-lumo-user': 'forged', 'x-lumo-realm': 'forged', 'x-lumo-roles': 'platform_admin',
  } })
  const result = { status: 0, body: undefined as unknown }
  const res = { setHeader() {}, writeHead(status: number) { result.status = status }, end(chunk?: string) { result.body = chunk === undefined ? undefined : JSON.parse(chunk) } }
  await api(config, knowledge, undefined, undefined, undefined, req as never, res as never, undefined, undefined, objects)
  return result
}

describe('资料库整理与版本 API', () => {
  it('文件名与移动只透传白名单字段和可信身份，响应隐藏原始对象 key', async () => {
    const knowledge = manager()
    const result = await invoke('PATCH', '/lumo/api/knowledge/library/files/file-a', knowledge, {
      expectedRevision: 3, filename: ' 更新.txt ', folderId: null,
      realm: 'forged', actorUserId: 'forged', roles: ['platform_admin'], isAdmin: true, objectKey: 'forged',
    })
    expect(result.status).toBe(200)
    expect(knowledge.updateLibraryFile).toHaveBeenCalledExactlyOnceWith({
      realm: 'realm-a', docId: 'file-a', actorUserId: 'member-a', roles: ['viewer'], isAdmin: false,
      expectedRevision: 3, filename: '更新.txt', folderId: null,
    })
    expect(result.body).toMatchObject({ file: { filename: '更新.txt', revision: 4 } })
    expect((result.body as { file: object }).file).not.toHaveProperty('objectKey')
  })

  it('目录重命名和移动可同时保存，省略目标不会变成根目录', async () => {
    const knowledge = manager()
    expect((await invoke('PATCH', '/lumo/api/knowledge/library/folders/folder-a', knowledge, { expectedRevision: 4, name: ' 更新 ', parentId: 'folder-next' })).status).toBe(200)
    expect(knowledge.updateLibraryFolder).toHaveBeenCalledWith({ realm: 'realm-a', folderId: 'folder-a', actorUserId: 'member-a', roles: ['viewer'], isAdmin: false, expectedRevision: 4, name: '更新', parentId: 'folder-next' })
    await invoke('PATCH', '/lumo/api/knowledge/library/folders/folder-a', knowledge, { expectedRevision: 5, name: '仅改名' })
    expect(knowledge.updateLibraryFolder.mock.calls[1]![0]).not.toHaveProperty('parentId')
  })

  it('更新拒绝无版本、无更改、空名称和无效目标，不进入 provider 写入', async () => {
    const knowledge = manager()
    for (const payload of [{ filename: '新.txt' }, { expectedRevision: 0, filename: '新.txt' }, { expectedRevision: 1.5, filename: '新.txt' }, { expectedRevision: 3 }, { expectedRevision: 3, filename: '' }, { expectedRevision: 3, folderId: 42 }, { expectedRevision: 3, folderId: '../bad' }]) {
      expect((await invoke('PATCH', '/lumo/api/knowledge/library/files/file-a', knowledge, payload)).status).toBe(400)
    }
    for (const payload of [{ name: '新' }, { expectedRevision: 4 }, { expectedRevision: 4, name: null }, { expectedRevision: 4, parentId: [] }]) {
      expect((await invoke('PATCH', '/lumo/api/knowledge/library/folders/folder-a', knowledge, payload)).status).toBe(400)
    }
    expect(knowledge.updateLibraryFile).not.toHaveBeenCalled()
    expect(knowledge.updateLibraryFolder).not.toHaveBeenCalled()
  })

  it('权限被撤销或版本冲突保持 403/409，旧 provider 整理操作明确不可用', async () => {
    const knowledge = manager()
    knowledge.updateLibraryFile.mockRejectedValueOnce(forbidden('已撤权')).mockRejectedValueOnce(new KnowledgeSourceConflictError('已变更'))
    expect(await invoke('PATCH', '/lumo/api/knowledge/library/files/file-a', knowledge, { expectedRevision: 3, filename: '新.txt' })).toEqual({ status: 403, body: { error: '已撤权' } })
    expect(await invoke('PATCH', '/lumo/api/knowledge/library/files/file-a', knowledge, { expectedRevision: 3, filename: '新.txt' })).toEqual({ status: 409, body: { error: '已变更' } })
    Object.assign(knowledge, { updateLibraryFolder: undefined, updateLibraryFile: undefined })
    expect((await invoke('PATCH', '/lumo/api/knowledge/library/files/file-a', knowledge, { expectedRevision: 3, filename: '新.txt' })).status).toBe(501)
    expect((await invoke('PATCH', '/lumo/api/knowledge/library/folders/folder-a', knowledge, { expectedRevision: 4, name: '新' })).status).toBe(501)
    expect((await invoke('GET', '/lumo/api/knowledge/library/files', knowledge)).status).toBe(200)
  })

  it('版本化文件删除必须携带 SHA 和 revision，版本化目录必须携带 revision', async () => {
    const knowledge = manager()
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-a', knowledge, { expectedSha256: file.sha256 })).status).toBe(400)
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/folders/folder-a', knowledge)).status).toBe(400)
    expect(knowledge.deleteLibraryFile).not.toHaveBeenCalled()
    expect(knowledge.deleteLibraryFolder).not.toHaveBeenCalled()
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-a', knowledge, { expectedSha256: file.sha256, expectedRevision: 3 })).status).toBe(200)
    expect(knowledge.deleteLibraryFile).toHaveBeenCalledExactlyOnceWith({ realm: 'realm-a', docId: 'file-a', actorUserId: 'member-a', roles: ['viewer'], isAdmin: false, expectedSha256: file.sha256, expectedRevision: 3 })
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/folders/folder-a', knowledge, { expectedRevision: 4 })).status).toBe(200)
    expect(knowledge.deleteLibraryFolder).toHaveBeenCalledExactlyOnceWith({ realm: 'realm-a', folderId: 'folder-a', actorUserId: 'member-a', roles: ['viewer'], isAdmin: false, expectedRevision: 4 })
  })

  it('老 provider 未暴露 revision 时保留 SHA 删除与空目录 DELETE 兼容', async () => {
    const knowledge = manager()
    knowledge.getLibraryFile.mockResolvedValue({ ...file, revision: undefined } as unknown as typeof file)
    knowledge.listLibraryFolders.mockResolvedValue([{ ...folder, revision: undefined }] as unknown as typeof folder[])
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/files/file-a', knowledge, { expectedSha256: file.sha256 })).status).toBe(200)
    expect((await invoke('DELETE', '/lumo/api/knowledge/library/folders/folder-a', knowledge)).status).toBe(200)
    expect(knowledge.deleteLibraryFile.mock.calls[0]![0]).not.toHaveProperty('expectedRevision')
    expect(knowledge.deleteLibraryFolder.mock.calls[0]![0]).not.toHaveProperty('expectedRevision')
  })

  it('列表保留整理 revision，同时不公开内部对象地址', async () => {
    const result = await invoke('GET', '/lumo/api/knowledge/library/files', manager())
    expect(result.body).toMatchObject({ files: [{ revision: 3 }] })
    expect((result.body as { files: object[] }).files[0]).not.toHaveProperty('objectKey')
  })
})

describe('上传目标权限二次校验', () => {
  it('将可信角色传给事务写入，上传期间撤权时不会建立来源或回报成功', async () => {
    const knowledge = manager()
    const objects = objectStore()
    knowledge.createLibraryFile.mockRejectedValue(forbidden('上传期间编辑权限已撤销'))
    expect(await invoke('POST', '/lumo/api/knowledge/library/files?folder_id=folder-a', knowledge, Buffer.from('业务资料正文'), objects)).toEqual({ status: 403, body: { error: '上传期间编辑权限已撤销' } })
    expect(objects.putContent).toHaveBeenCalledOnce()
    expect(knowledge.createLibraryFile).toHaveBeenCalledWith(expect.objectContaining({ realm: 'realm-a', ownerUserId: 'member-a', folderId: 'folder-a' }), { roles: ['viewer'], isAdmin: false })
    expect(knowledge.upsertSource).not.toHaveBeenCalled()
    expect(knowledge.removeLibraryFile).not.toHaveBeenCalled()
  })

  it('上传返回数据库的 revision，完成时已删除则返回冲突', async () => {
    const knowledge = manager()
    const objects = objectStore()
    knowledge.createLibraryFile.mockImplementation(async uploaded => { knowledge.getLibraryFile.mockResolvedValue({ ...uploaded, revision: 1 }) })
    const uploaded = await invoke('POST', '/lumo/api/knowledge/library/files', knowledge, Buffer.from('业务资料正文'), objects)
    expect(uploaded.status).toBe(201)
    expect(uploaded.body).toMatchObject({ file: { revision: 1, canEdit: true, filename: '上传.txt' }, indexed: true })
    expect((uploaded.body as { file: object }).file).not.toHaveProperty('objectKey')
    knowledge.createLibraryFile.mockImplementation(async () => { knowledge.getLibraryFile.mockResolvedValue(undefined) })
    expect((await invoke('POST', '/lumo/api/knowledge/library/files', knowledge, Buffer.from('第二份资料'), objects)).status).toBe(409)
  })
})
