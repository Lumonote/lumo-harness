import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStorageBackend, Config } from '../../../../deepseek-harness/packages/storage/storage-sqlite/src/index.ts'
import { DesktopPetReceiptStore, desktopPetOwnerScope, desktopPetReceiptsHandler } from '../src/desktop-pet-receipts.ts'
import type { DesktopPetReceipt, DesktopPetReceiptClaim } from '../src/desktop-pet-receipt-types.ts'

const descriptor = { name: 'lumo_desktop_pet_receipts', version: 1, tables: ['requests'], hasGlobal: false, layout: 'per-record' as const }
const scope = 'a'.repeat(64)
const claim: DesktopPetReceiptClaim = { id: 'send-1', digest: 'b'.repeat(64), owner: 'window-1', workspaceId: 'workspace-1' }
const directories: string[] = []
const stores: DesktopPetReceiptStore[] = []
const backends: SqliteStorageBackend[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const backend of backends.splice(0)) await backend.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lumo-pet-receipts-')); directories.push(directory)
  const open = async (epoch: string) => {
    const backend = new SqliteStorageBackend(new Config({ path: join(directory, 'storage.db') })); backends.push(backend)
    const store = new DesktopPetReceiptStore(await backend.kv.open(descriptor), epoch, () => 1_000, join(directory, 'lock')); stores.push(store)
    return store
  }
  return { directory, open }
}
function update(record: DesktopPetReceipt, phase: DesktopPetReceipt['phase'], extra = {}) {
  return { id: record.id, digest: record.digest, owner: record.owner, revision: record.revision, phase, ...extra }
}

describe('桌宠 SQLite 权威回执', () => {
  it.each(['creating', 'submitting', 'accepted'] as const)('真实数据库重新打开保留 %s，未知结果不会取得重放权', async phase => {
    const f = await fixture(); const first = await f.open('process-1')
    let { record } = await first.claim(scope, claim)
    record = await first.update(scope, update(record, 'creating'))
    if (phase !== 'creating') {
      record = await first.update(scope, update(record, 'preparing', { sessionId: 'original-session' }))
      record = await first.update(scope, update(record, 'submitting', { hostRequestId: 'original-request' }))
    }
    if (phase === 'accepted') record = await first.update(scope, update(record, 'accepted'))
    await first.close()
    const restarted = await f.open('process-2')
    const result = await restarted.claim(scope, { ...claim, owner: 'window-2' })
    expect(result).toMatchObject({ acquired: false, record: { phase, revision: record.revision } })
    if (phase !== 'creating') expect(result.record.sessionId).toBe('original-session')
    await expect(restarted.update(scope, update(record, 'accepted'))).rejects.toMatchObject({ code: 'receipt_lease_conflict' })
  })
  it('两个独立 SQLite 连接在共享锁内重新读取，竞争最多授予一个窗口', async () => {
    const f = await fixture(); const first = await f.open('process'); const second = await f.open('process')
    const results = await Promise.all([first.claim(scope, claim), second.claim(scope, { ...claim, owner: 'window-2' })])
    expect(results.filter(result => result.acquired)).toHaveLength(1)
    const winner = results.find(result => result.acquired)!.record
    const next = await second.update(scope, update(winner, 'creating'))
    await expect(first.update(scope, update(winner, 'creating'))).rejects.toMatchObject({ code: 'receipt_lease_conflict' })
    expect((await first.claim(scope, { ...claim, owner: 'third' })).record.revision).toBe(next.revision)
  })
  it('重启可接管尚未提交的已知会话，旧进程被 fence；会话身份不能更换', async () => {
    const f = await fixture(); const first = await f.open('process-1')
    let { record } = await first.claim(scope, claim)
    record = await first.update(scope, update(record, 'creating'))
    record = await first.update(scope, update(record, 'preparing', { sessionId: 'known-session', uploads: [{ receiptId: 'old-peer-receipt' }] }))
    const second = await f.open('process-2')
    const transferred = await second.claim(scope, { ...claim, owner: 'new-window' })
    expect(transferred).toMatchObject({ acquired: true, record: { sessionId: 'known-session', uploads: [] } })
    await expect(first.update(scope, update(record, 'submitting', { hostRequestId: 'stale' }))).rejects.toMatchObject({ code: 'receipt_lease_conflict' })
    await expect(second.update(scope, update(transferred.record, 'preparing', { sessionId: 'another-session' }))).rejects.toMatchObject({ code: 'receipt_transition_invalid' })
  })
  it('同一标识的内容冲突拒绝，不同 owner scope 隔离', async () => {
    const f = await fixture(); const store = await f.open('process')
    await store.claim(scope, claim)
    await expect(store.claim(scope, { ...claim, digest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'receipt_payload_conflict' })
    expect((await store.claim('d'.repeat(64), { ...claim, digest: 'c'.repeat(64) })).acquired).toBe(true)
  })
  it('磁盘写失败不授予租约，重新读取能识别写入结果不明的持久事实', async () => {
    const f = await fixture()
    const backend = new SqliteStorageBackend(new Config({ path: join(f.directory, 'failure.db') })); backends.push(backend)
    const unit = await backend.kv.open(descriptor)
    const store = new DesktopPetReceiptStore({ ...unit, loadAll: () => unit.loadAll(), close: () => unit.close(), putRecord: async (table, key, value) => {
      await unit.putRecord(table, key, value); throw Error('fsync response lost')
    } }, 'process', Date.now, join(f.directory, 'lock')); stores.push(store)
    await expect(store.claim(scope, claim)).rejects.toThrow('fsync response lost')
    // The persisted lease remains visible; another caller cannot assume absence.
    expect(await store.claim(scope, { ...claim, owner: 'second-window' })).toMatchObject({ acquired: false, record: { owner: claim.owner } })
  })
})

describe('桌宠回执认证与元数据边界', () => {
  const secret = Buffer.alloc(32, 7).toString('base64url')
  function context(grant = secret) {
    const peer = {}; const connection = { browserPeer: peer, admit: () => ({ peer }) }
    return { connection, ctx: { get: (key: string) => ({ connection, webServer: { protocol: 'http:' }, credentials: { readRecord: async () => ({ kind: 'grant', payload: { version: 1, secret: grant } }) } })[key] } }
  }
  async function invoke(options: { local?: boolean; path?: string; method?: string; origin?: string; contentType?: string; body?: unknown; admitted?: boolean; grant?: string } = {}) {
    const f = await fixture(); const store = await f.open(randomUUID())
    const { ctx, connection } = context(options.grant)
    if (options.admitted === false) connection.admit = () => ({ peer: {} })
    const req = Object.assign(Readable.from([JSON.stringify(options.body ?? claim)]), { method: options.method ?? 'POST', url: options.path ?? '/lumo/api/desktop-pet/receipts/claim', headers: { host: '127.0.0.1:4185', origin: options.origin ?? 'http://127.0.0.1:4185', 'content-type': options.contentType ?? 'application/json' } })
    const response = { status: 0, body: undefined as unknown }
    await desktopPetReceiptsHandler(ctx, options.local ?? true, () => store)(req as never, { setHeader() {}, writeHead(code: number) { response.status = code }, end(body: string) { response.body = JSON.parse(body) } } as never)
    return response
  }
  it('使用持久签名身份，重启一致、不同 profile 隔离且不返回密钥', async () => {
    const first = await desktopPetOwnerScope(context().ctx)
    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(await desktopPetOwnerScope(context().ctx)).toBe(first)
    expect(await desktopPetOwnerScope(context(Buffer.alloc(32, 8).toString('base64url')).ctx)).not.toBe(first)
    await expect(desktopPetOwnerScope(context('invalid').ctx)).rejects.toMatchObject({ code: 'receipt_owner_unavailable' })
    const result = await invoke(); expect(result.status).toBe(200); expect(JSON.stringify(result)).not.toContain(secret)
  })
  it.each([
    [{ local: false }, 404], [{ admitted: false }, 403], [{ origin: 'https://foreign.test' }, 403],
    [{ method: 'GET' }, 405], [{ contentType: 'text/plain' }, 415], [{ grant: 'invalid' }, 503],
    [{ body: { ...claim, draft: 'never persisted' } }, 400], [{ body: { ...claim, id: '../invalid' } }, 400],
    [{ body: { ...claim, workspaceId: 'a'.repeat(17000) } }, 413],
  ] as const)('拒绝未经授权或畸形请求 %o', async (options, status) => {
    expect((await invoke(options)).status).toBe(status)
  })
})
