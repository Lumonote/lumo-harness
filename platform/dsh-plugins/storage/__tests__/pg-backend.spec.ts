import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import pg from 'pg'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../../../deepseek-harness/packages/storage/storage/tests/contract.ts'
import * as StoragePg from '../src/index.ts'

/**
 * PG KV 后端（项 12）对真 PG。共享契约套件直接复用 dsh 的
 * `storage/storage/tests/contract.ts`（`runKvBackendContract`）——这与 sqlite 后端跑
 * 的是**同一份断言**，双后端因此被同一标准制约（TS 侧唯一真相源，不复写第五条判据）。
 */
const DSN = process.env['STORAGE_TEST_DSN']
const t = DSN ? it : it.skip
const title = (s: string) => s + (DSN ? '' : '（需 STORAGE_TEST_DSN → 跳过，非通过）')

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'specimen',
  version: 1,
  tables: ['records'],
  hasGlobal: true,
}

// 契约套件的 reopen() 需要「同一介质」重开新 backend：每次用例一个独立 schema。
// runKvBackendContract 自身没有 skip 口，故在调用点判断 DSN：有则真跑，无则登记一条
// 带标签的 skip。标签沿用本文件第 16 行 title() 的同一措辞，「跳过 ≠ 通过」不会被误读，
// 因此这不是假绿；而裸跑 `pnpm test` 也不会因为缺一个环境变量就整体报红。
if (DSN) {
  runKvBackendContract('pg', async () => {
    const { freshSchemaDsn } = await import('../__tests__/pg-schema.ts')
    const dsn = await freshSchemaDsn(DSN, 'storage_kv_contract')
    const backend = new StoragePg.PgStorageBackend(dsn)
    return {
      backend,
      reopen: async () => new StoragePg.PgStorageBackend(dsn),
    }
  })
} else {
  it.skip(title('kv backend contract: pg'), () => {})
}

describe('pg kv backend specifics', () => {
  // afterEach 关闭仍在打开的连接，避免 worker 净退时挂起。DSN 缺失时整体 skip。
  const open: Array<() => Promise<void>> = []
  afterEach(async () => {
    const drains = open.splice(0)
    await Promise.allSettled(drains.map((d) => d()))
  })

  async function freshDsn(label: string): Promise<string> {
    if (!DSN) throw new Error('STORAGE_TEST_DSN 未设置')
    const { freshSchemaDsn } = await import('../__tests__/pg-schema.ts')
    return freshSchemaDsn(DSN, `storage_kv_${label}`)
  }

  async function backendAt(dsn: string): Promise<StoragePg.PgStorageBackend> {
    const backend = new StoragePg.PgStorageBackend(dsn)
    open.push(() => backend.close())
    return backend
  }

  t(title('打开缺失单元立即为空，loadAll 无需预写'), async () => {
    const backend = await backendAt(await freshDsn('empty'))
    const unit = await backend.kv.open(DESCRIPTOR)
    expect(await unit.loadAll()).toEqual({ tables: { records: {} }, global: null })
  })

  t(title('记录往返可复现（值存 JSON，读回逐语义一致）'), async () => {
    const dsn = await freshDsn('roundtrip')
    const backend = await backendAt(dsn)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k1', { n: 1, s: '深挖' })
    await unit.putRecord('records', 'k2', [1, 2, 3])
    await unit.setGlobal({ c: 7 })
    await backend.close()
    open.splice(open.length - 1, 1) // 已手动 close，移除队列登记

    const reopened = await backendAt(dsn)
    const unit2 = await reopened.kv.open(DESCRIPTOR)
    const snap = await unit2.loadAll()
    expect(snap.tables['records']).toEqual({ k1: { n: 1, s: '深挖' }, k2: [1, 2, 3] })
    expect(snap.global).toEqual({ c: 7 })
  })

  t(title('覆盖删除幂等，缺键删除是 no-op'), async () => {
    const backend = await backendAt(await freshDsn('overwrite'))
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { v: 'old' })
    await unit.putRecord('records', 'k', { v: 'new' })
    await unit.deleteRecord('records', 'k')
    await unit.deleteRecord('records', 'k')
    await unit.deleteRecord('records', 'never')
    expect((await unit.loadAll()).tables['records']).toEqual({})
  })

  t(title('版本不匹配在重开后拒，不碰原数据'), async () => {
    const dsn = await freshDsn('vismatch')
    const backend = await backendAt(dsn)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { v: 1 })
    await backend.close()
    open.splice(open.length - 1, 1)

    const reopened = await backendAt(dsn)
    await expect(reopened.kv.open({ ...DESCRIPTOR, version: 4 })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
    const unit2 = await reopened.kv.open(DESCRIPTOR)
    expect((await unit2.loadAll()).tables['records']).toEqual({ k: { v: 1 } })
  })

  t(title('unit close 后拒绝操作，backend close 幂等'), async () => {
    const backend = await backendAt(await freshDsn('closed'))
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.close()
    await unit.close()
    await expect(unit.putRecord('records', 'k', {})).rejects.toMatchObject({ code: 'closed' })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
    await backend.close()
    await backend.close()
    open.splice(open.length - 1, 1) // 手动 close
  })

  t(title('record 键含任意字符串（含 / 空格 : 制表符）——值永不抵达文件路径'), async () => {
    const backend = await backendAt(await freshDsn('weirdkey'))
    const unit = await backend.kv.open(DESCRIPTOR)
    const weird = 'a / b\t:c:some\nkey'
    await unit.putRecord('records', weird, { ok: true })
    expect((await unit.loadAll()).tables['records'][weird]).toEqual({ ok: true })
  })

  t(title('非法 unit/table 名在触介质前拒'), async () => {
    const backend = await backendAt(await freshDsn('badname'))
    await expect(backend.kv.open({ ...DESCRIPTOR, name: 'Bad-Name' })).rejects.toThrow(/violates/)
    await expect(backend.kv.open({ ...DESCRIPTOR, tables: ['ok', '1bad'] })).rejects.toThrow(/violates/)
  })

  t(title('同名二次打开拒（caller bug），close 后可重开'), async () => {
    const backend = await backendAt(await freshDsn('double'))
    const unit = await backend.kv.open(DESCRIPTOR)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/already open/)
    await unit.close()
    const again = await backend.kv.open(DESCRIPTOR)
    await again.putRecord('records', 'k', 1)
  })

  t(title('原型污染键作为自有属性往返，不污染 Object.prototype'), async () => {
    const backend = await backendAt(await freshDsn('proto'))
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', '__proto__', { evil: true })
    await unit.putRecord('records', 'constructor', { n: 1 })
    const { tables } = await unit.loadAll()
    const records = tables['records']!
    expect(Object.hasOwn(records, '__proto__')).toBe(true)
    expect(records['__proto__']).toEqual({ evil: true })
    expect(records['constructor']).toEqual({ n: 1 })
    expect(Object.getPrototypeOf({})).not.toHaveProperty('evil')
  })

  t(title('坏 JSON → malformed-medium（表内直改模拟介质篡改）'), async () => {
    const dsn = await freshDsn('malformed')
    const backend = await backendAt(dsn)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'good', { n: 1 })
    await unit.setGlobal({ g: 1 })
    await backend.close()
    open.splice(open.length - 1, 1)

    // 直连改坏记录的 value 列签名——模拟介质上的 JSON 被破坏。
    await tamper(dsn, `UPDATE u_specimen_records SET value = '{\\\\not json' WHERE key = 'good'`)

    const reopened = await backendAt(dsn)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
  })

  t(title('坏全局 JSON → malformed-medium'), async () => {
    const dsn = await freshDsn('malformedglobal')
    const backend = await backendAt(dsn)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.setGlobal({ g: 1 })
    await backend.close()
    open.splice(open.length - 1, 1)

    await tamper(dsn, `UPDATE unit_globals SET value = '][' WHERE unit = 'specimen'`)

    const reopened = await backendAt(dsn)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
  })

  t(title('非 Error 的 toJSON 抛被包成 Error 拒绝'), async () => {
    const backend = await backendAt(await freshDsn('tojson'))
    const unit = await backend.kv.open(DESCRIPTOR)
    const hostile = { toJSON: () => { throw 'not an error' } }
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toThrow('not an error')
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toBeInstanceOf(Error)
  })

  t(title('未声明 table 的写入/未声明 global 的 setGlobal 拒'), async () => {
    const backend = await backendAt(await freshDsn('undeclared'))
    const unit = await backend.kv.open({ ...DESCRIPTOR, hasGlobal: false })
    await expect(unit.setGlobal({ g: 1 })).rejects.toThrow(/declared no global slot/)
    await expect(unit.putRecord('undeclared', 'k', 1)).rejects.toThrow(/declared no table/)
    expect((await unit.loadAll()).global).toBeNull()
  })

  t(title('backend 注册为 pg 并在 dispose 时注销+关闭'), async () => {
    const dsn = await freshDsn('register')
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin(StoragePg, { connectionString: dsn })
    const backend = ctx.storage.backend.get('pg')
    expect(ctx.get(storageBackendServiceKey('pg'))).toBe(backend)
    const unit = await backend.kv!.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })

    await fiber.dispose()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('pg'))).toBeUndefined()
    await expect(backend.kv!.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })
})

/** 以 admin 连接对介质做一次原始 SQL 篡改（测坏 JSON 用；镜像 sqlite 的直改）。 */
async function tamper(dsn: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: dsn })
  try {
    await client.connect()
    await client.query(statement)
  } finally {
    await client.end()
  }
}