/**
 * @lumo/attachments —— 附件 seam（§5.1：MinIO → ctx.attachments 对象化；P2b 项 10）。
 *
 * 挂 `ctx.attachments`：沿用 dsh AttachmentStore 抽象类（引用一律对象键），写读走
 * `ctx.objectStore`（对象存储 seam，realm 前缀按本插件 realm 注入）。能力缺失
 * （铁律 21）由 {@link MinioAttachmentStore} 显式抛 capabilityUnavailable，绝不降级。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'
import { MinioAttachmentStore } from './minio-attachment-store.ts'

export interface AttachmentsConfig {
  /** 附件归属 realm（对象键第一段；装配层身份语义）。 */
  realm: string
  maxImageBytes?: number
  maxImagesPerMessage?: number
  maxMessageImageBytes?: number
  maxImagePixels?: number
  maxImageDimension?: number
  normalizedImageMaxPixels?: number
  normalizedImageMaxDimension?: number
  normalizedImageMaxBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    objectStore: ObjectStoreSeam
  }
}

/** Schemastery validation for {@link AttachmentsConfig}（默认值与 provider 内部一致）。 */
export const Config: z<AttachmentsConfig> = z.object({
  realm: z.string(),
  maxImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024),
  maxImagesPerMessage: z.number().step(1).min(1).default(20),
  maxMessageImageBytes: z.number().step(1).min(1).default(200 * 1024 * 1024),
  maxImagePixels: z.number().step(1).min(1).default(64_000_000),
  maxImageDimension: z.number().step(1).min(1).default(8192),
  normalizedImageMaxPixels: z.number().step(1).min(1).default(2048 * 2048),
  normalizedImageMaxDimension: z.number().step(1).min(1).default(2048),
  normalizedImageMaxBytes: z.number().step(1).min(1).default(4 * 1024 * 1024),
})

export const inject: string[] = ['objectStore']

export function apply(ctx: Context, config: AttachmentsConfig): void {
  // AttachmentStore extends Cordis Service and registers `attachments` from
  // super(ctx). Providing the instance a second time races the Service-owned
  // registration and makes multi-plugin profile boot fail as a duplicate.
  new MinioAttachmentStore(ctx, config)
}

export default apply
export { MinioAttachmentStore } from './minio-attachment-store.ts'
export type { MinioAttachmentOptions } from './minio-attachment-store.ts'
