/**
 * @lumo/object-store —— 对象存储 seam（§5.1：MinIO → ctx.objectStore）+ spillStore 收敛。
 *
 * 挂两件事（seam 远程形态设计 §1 第 10/11 行的共同地基）：
 *   - `ctx.objectStore`：realm 隔离的对象读写面（写后可读强一致）；
 *   - `ctx.spillStore`：MinIO 版 SpillStore —— 溢出内容对象化，跨节点 resume 任意节点可取回。
 *
 * 越权防线不在本插件复制实现：键规则（realm 前缀拼接 / 越狱段拒绝 / 内容寻址派生）
 * 锁在 `shared/seam-contracts/object-store.ts`，Provider 只调用并信任它。能力缺失
 * （铁律 21）由 `MinioObjectStore` 显式抛 `capabilityUnavailable`，绝不静默降级。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { MinioObjectStore } from './minio-store.ts'
import { MinioSpillStore } from './minio-spill.ts'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'

export interface ObjectStoreConfig {
  endPoint: string
  port?: number
  useSSL?: boolean
  accessKey: string
  secretKey: string
  bucket: string
  region?: string
  /** 本节点 realm（身份语义，装配层注入；spill 键前缀） */
  realm: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    objectStore: ObjectStoreSeam
  }
}

/** Schemastery validation for {@link ObjectStoreConfig} */
export const Config: z<ObjectStoreConfig> = z.object({
  endPoint: z.string(),
  port: z.number(),
  useSSL: z.boolean(),
  accessKey: z.string(),
  secretKey: z.string(),
  bucket: z.string(),
  region: z.string(),
  realm: z.string(),
})

export const inject: string[] = []

export function apply(ctx: Context, config: ObjectStoreConfig): void {
  const store = new MinioObjectStore(config)
  ctx.provide('objectStore', store)

  // MinioSpillStore extends SpillStore extends Service → 经 super(ctx) 自注册 ctx.spillStore。
  new MinioSpillStore(ctx, { ...config, realm: config.realm })

  // 幂等建桶（dev 拓扑允许服务先于运维建桶）。失败只 warn 不吞：能力缺失会在
  // 首次 put/get 时显式以 capabilityUnavailable 暴露，这里提前把「桶建不起来」
  // 的不可达也记到日志，方便装配期定位。
  void store.init().catch((e: unknown) => {
    ctx.logger.warn('object-store: 桶初始化失败（能力缺失将在首次读写时显式拒绝）: %s',
      e instanceof Error ? e.message : String(e))
  })
}

export default apply
export { MinioObjectStore } from './minio-store.ts'
export { MinioSpillStore } from './minio-spill.ts'
export type { MinioStoreOptions } from './minio-store.ts'
export type { MinioSpillOptions } from './minio-spill.ts'
export type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'