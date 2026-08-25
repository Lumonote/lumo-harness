import pg from 'pg'

/**
 * 给每个 spec 文件一个独立的 PG schema。
 *
 * **为什么需要**：vitest 默认按文件并行，而这些用例都用 `TRUNCATE` 清台账。共用一个
 * schema 时，A 文件的 TRUNCATE 会在 B 文件跑到一半时抹掉它的预算行——两边都会红，
 * 且红的原因与被测代码无关。这类失败比没有测试更坏：它训练人「再跑一次就绿了」。
 *
 * 不用 `fileParallelism: false` 解决，是因为那要为两个文件牺牲整个套件的并行度；
 * 也不用改表名，那会让测试跑的 DDL 不是生产的 DDL。按 schema 隔离还顺带覆盖了真实
 * 场景：几个人对着同一个开发库跑测试。
 *
 * schema 固定命名、`IF NOT EXISTS` 复用，不做 DROP —— 每次 DROP/CREATE 会与并行的
 * 另一文件抢锁，而复用不会留下无界增长的垃圾。
 */
export function schemaDsn(base: string, schema: string): Promise<string> {
  const key = `${base} ${schema}`
  let p = cache.get(key)
  if (!p) {
    p = create(base, schema)
    cache.set(key, p)
  }
  return p
}

/**
 * 每个 worker 内按 (base, schema) 记一次。
 *
 * vitest 一个文件一个 worker，模块状态不跨文件共享，所以这里缓存的粒度天然就是
 * 「本文件一次」。不缓存的话每个用例都要多开一条 admin 连接建 schema —— 十个用例
 * 十次往返，而结果必然相同。失败的 promise 也留在表里：同一个错误重复抛，比重试
 * 到某次偶然成功更容易定位。
 */
const cache = new Map<string, Promise<string>>()

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
