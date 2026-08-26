import { randomBytes } from 'node:crypto'

import type { MinioStoreOptions } from '../src/minio-store.ts'

/**
 * 对象存储真依赖测试的共享装配（pg-schema.ts 的 MinIO 对应物）。
 *
 * **按 run 独立 realm**：测试桶 `lumo-objects` 是共享的（同 compose 拓扑），不同
 * spec 文件、不同 run 之间靠 realm 前缀隔离键命名空间——不共享、不清理，也就不存在
 * 相互 TRUNCATE 之类越界抹数据的问题（对象垃圾由部署期生命周期策略回收，dev 无限留）。
 *
 * **无端点即整组跳过且跳过可见**：静默 return 会让报告显示「通过」。
 */

/** 是否已配置真 MinIO 端点+凭据（`OBJECT_STORE_TEST_ENDPOINT` / `OBJECT_STORE_TEST_CREDS`）。 */
export function testEnabled(): boolean {
  return Boolean(process.env['OBJECT_STORE_TEST_ENDPOINT'] && process.env['OBJECT_STORE_TEST_CREDS'])
}

/** 由环境变量组装的 Provider 配置（endpoint 拆成 endPoint/port）。 */
export function minioOptions(): MinioStoreOptions {
  const endpoint = process.env['OBJECT_STORE_TEST_ENDPOINT'] ?? '127.0.0.1:19000'
  const creds = process.env['OBJECT_STORE_TEST_CREDS'] ?? 'lumo:lumo-minio-123'
  const [accessKey, secretKey] = creds.split(':')
  const [endPoint, portStr] = endpoint.split(':')
  return {
    endPoint,
    port: portStr ? Number(portStr) : 9000,
    useSSL: false,
    accessKey,
    secretKey,
    bucket: 'lumo-objects',
  }
}

/** 每次 run 独立 realm（合法单段：非空、无 `/`）。 */
export function uniqueRealm(): string {
  return `t-${randomBytes(6).toString('hex')}`
}