/**
 * 平台 PG KV 后端的 schema 与打开序列（镜像 `storage-sqlite` 的 schema.ts）。
 *
 * PG 没有 SQLite 的 `PRAGMA user_version`，版本戳放在 `storage_meta` 单行表里：
 *   - 打开时读 `schema_version`；缺失 = 全新介质，建表后**最后一**步戳版本；
 *   - 版本已戳且不等 → `version-mismatch` 拒（本未发布格式无迁移）；
 *   - 建表 + 戳版本在同一事务里，中途失败整体回滚（不留下「半建好却已戳版本」的介质）。
 *
 * 元数据表（`units`/`unit_globals`）与 sqlite 逐列一致；单 unit 的记录表在
 * `unit.ts`/`index.ts` 里按 descriptor 创建（`u_<unit>_<table>`）。
 */
import pg from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'

/**
 * PG 侧物理布局版本。正交于每个 unit 自己的 `version`（按 unit 戳在 `units` 行）。
 * 只在表布局破坏性变更时递增；其它已戳版本一律拒——本未发布格式无迁移。
 */
export const STORAGE_PG_SCHEMA_VERSION = 1

/**
 * 物理记录表名。两个段（unit/table）都已过 `UNIT_NAME_RE` 校验，结果安全拼进 DDL
 * 与参数化语句的标识符位（标识符不能被参数化，只能用白名单正则兜底）。
 */
export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}

/**
 * 打开/配置介质：确保版本戳与元数据表存在。幂等；「戳版本 LAST」保证半建成的介质
 * 不会被误标为当前版本（失败重试从零重跑 materialization）。
 * @param pool - 后端持有的连接池；本函数只负责 schema 层。
 * @returns 介质就绪。
 */
export async function ensureSchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    const row = await client.query(`SELECT value FROM storage_meta WHERE key = 'schema_version'`)
    const onDisk = row.rows[0]?.value as string | undefined
    if (onDisk !== undefined && Number(onDisk) !== STORAGE_PG_SCHEMA_VERSION) {
      throw new StorageError(
        'version-mismatch',
        `storage database has schema version ${onDisk}, incompatible with this build (${STORAGE_PG_SCHEMA_VERSION})`,
      )
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS units (
        name    TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS unit_globals (
        unit  TEXT PRIMARY KEY REFERENCES units(name),
        value TEXT NOT NULL
      )
    `)
    if (onDisk === undefined) {
      // 全新介质：元数据表建好后才戳版本——戳版本断言布局完整，中途失败回滚不戳。
      await client.query(
        `INSERT INTO storage_meta (key, value) VALUES ('schema_version', $1)`,
        [String(STORAGE_PG_SCHEMA_VERSION)],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}