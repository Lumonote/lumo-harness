import { randomBytes } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'

import { MinioObjectStore } from '../../object-store/src/minio-store.ts'
import type { MinioStoreOptions } from '../../object-store/src/minio-store.ts'
import { MinioAttachmentStore } from '../src/minio-attachment-store.ts'

/**
 * 附件真依赖测试的共享装配（minio-helper 的附件对应物）。
 *
 * **按 run 独立 realm**：测试桶 `lumo-objects` 共享，不同 run 靠 realm 前缀隔离键命名
 * 空间。附件 Provider 绑定到自己的 realm（对象键第一段），与对象存储 seam 同隔离约定。
 *
 * **无端点即整组跳过且跳过可见**：静默 return 会让报告显示「通过」。
 */

/** 是否已配置真 MinIO 端点+凭据（`OBJECT_STORE_TEST_ENDPOINT` / `OBJECT_STORE_TEST_CREDS`）。 */
export function testEnabled(): boolean {
  return Boolean(process.env['OBJECT_STORE_TEST_ENDPOINT'] && process.env['OBJECT_STORE_TEST_CREDS'])
}

/** 由环境变量组装的 MinIO Provider 配置（endpoint 拆成 endPoint/port）。 */
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

/** 独立对象存储 Provider（供跨命名空间/篡改类断言直接对象读）。 */
export function objectStore(): MinioObjectStore {
  return new MinioObjectStore(minioOptions())
}

/** 装配一个绑定到某 realm 的附件 Provider，跑在真 MinIO 上（ctx.objectStore 一并注入）。 */
export function attachmentStore(realm: string): MinioAttachmentStore {
  const ctx = new Context()
  ctx.provide('objectStore', objectStore())
  return new MinioAttachmentStore(ctx, { realm })
}

/** 生成一张合规的小 PNG（8×8 纯色）——归一化仍能通过准入且字节稳定可复现。 */
export async function tinyPng(): Promise<Uint8Array> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: '#7820c8' },
  }).png().toBuffer()
}