import pg from 'pg'

/**
 * 给每个 PG KV backend 测试一个独立的 PG schema。
 *
 * 为什么需要（镜像 metering/__tests__/pg-schema.ts 的动机）：契约套件每条用例需要一个
 * 空介质——「打开缺失单元即空 + loadAll 立即可用」「版本不匹配不碰数据」等都以介质初始
 * 状态为前件。共享一个 schema 会让用例间残留影响彼此（打开过 == 不在「缺失单元」态）。
 * 复用而非 DROP：每次 DROP/CREATE 会抢锁，而 numpy 式 `IF NOT EXISTS` 复用不会留下无界
 * 增长垃圾；垃圾由部署期生命周期策略回收。
 */

const cache = new Map<string, Promise<string>>()

/** 本 worker 内按 (base, label) 固定一个 schema（vitest 一文件一 worker）。 */
export function schemaDsn(base: string, label: string): Promise<string> {
  const key = `${base} ${label}`
  let p = cache.get(key)
  if (!p) {
    p = create(base, label)
    cache.set(key, p)
  }
  return p
}

/** 每条用例独立 schema：契约套件的 `reopen()` 需在「同一介质」上重开新 backend。 */
export function freshSchemaDsn(base: string, label: string): Promise<string> {
  return create(base, `${label}_${crypto.randomUUID().replace(/-/g, '')}`)
}

async function create(base: string, schema: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`schema 名 ${schema} 不合法（要拼进 DDL，不能带引号或空格）`)
  }
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  try {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
  } finally {
    await admin.end()
  }
  const url = new URL(base)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}