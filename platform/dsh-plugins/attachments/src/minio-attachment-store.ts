/**
 * MinIO 版附件 Provider（§5.1：MinIO → ctx.attachments 对象化；P2b 项 10）。
 *
 * 复用 `@deepseek-ai/dsh-attachment-local` 的**纯件**（`prepareImageFile` 校验+归一化，
 * 不触存储），只换存储底座：
 *   - 写：内容寻址对象键（`realm/content/<sha256>`，引用一律对象键），走 `ctx.objectStore.put`；
 *   - 读：`ctx.objectStore.get` 直读 + digest 校验 + byteLength 校验；
 *   - 错误映射：非法引用 → ATTACHMENT_INVALID_REF；缺对象 → ATTACHMENT_NOT_FOUND；
 *     digest 不符 → ATTACHMENT_CORRUPT；后端不可达**穿透** capabilityUnavailable（铁律
 *     21：fail closed，不降级本地文件——那是第二条真相源）。
 */
import { createHash } from 'node:crypto'

import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  prepareImageFile,
  validateImageFile,
} from '@deepseek-ai/dsh-attachment-local'
import type { NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local'
import type { Context } from '@deepseek-ai/cordis'

import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'
import {
  attachmentObjectKey,
  parseAttachmentKey,
} from '../../../shared/seam-contracts/attachment.ts'

export interface MinioAttachmentOptions {
  /** 附件归属 realm（身份语义，拼进存储键第一段）。 */
  realm: string
  /** 单张最大编码字节。默认 20 MiB。 */
  maxImageBytes?: number
  /** 单次消息最大图片数。默认 20。 */
  maxImagesPerMessage?: number
  /** 单次消息最大聚合编码字节。默认 200 MiB。 */
  maxMessageImageBytes?: number
  /** 单张最大像素（宽×高）。默认 64,000,000。 */
  maxImagePixels?: number
  /** 单张最大单边像素。默认 8192px。 */
  maxImageDimension?: number
  /** 归一化后长边上限。默认 2048px。 */
  normalizedImageMaxDimension?: number
  /** 归一化后总像素预算。默认 2048×2048。 */
  normalizedImageMaxPixels?: number
  /** 归一化后编码字节安全上限。默认 4 MiB。 */
  normalizedImageMaxBytes?: number
}

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
const DEFAULT_MAX_IMAGE_DIMENSION = 8192
const DEFAULT_NORMALIZED_MAX_PIXELS = 2048 * 2048
const DEFAULT_NORMALIZED_MAX_DIMENSION = 2048
const DEFAULT_NORMALIZED_MAX_BYTES = 4 * 1024 * 1024

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** MinIO 版附件 seam：继承 {@link AttachmentStore}，写读走 `ctx.objectStore`。 */
export class MinioAttachmentStore extends AttachmentStore {
  /** 附件归属 realm（对象键第一段；公开供契约对拍/测试）。 */
  readonly realm: string

  /** 部署期解析的图片准入限制（镜像 dsh-attachment-local）。 */
  readonly imageLimits: ImageAttachmentLimits

  private readonly objectStore: ObjectStoreSeam
  private readonly normalizationPolicy: Readonly<NormalizationPolicy>

  constructor(ctx: Context, options: MinioAttachmentOptions) {
    super(ctx)
    this.realm = options.realm
    this.objectStore = ctx.objectStore as ObjectStoreSeam
    this.imageLimits = Object.freeze({
      maxImageBytes: options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: options.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: options.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: options.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.normalizationPolicy = Object.freeze({
      maxPixels: options.normalizedImageMaxPixels ?? DEFAULT_NORMALIZED_MAX_PIXELS,
      maxDimension: options.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_MAX_DIMENSION,
      maxBytes: options.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_MAX_BYTES,
    })
  }

  /** 校验一张图而不触存储（batch 调方先全验再全存）。 */
  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits, this.normalizationPolicy)
  }

  /**
   * 校验+归一化一次并写入对象存储，返回对象键引用。
   * 引用 = `<realm>/content/<sha256>`——自描述对象键，同内容同键幂等。
   */
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = await prepareImageFile(input, this.imageLimits, this.normalizationPolicy)
    const objectKey = attachmentObjectKey(this.realm, String(prepared.ref.attachmentId))
    const { sha256 } = parseAttachmentKey(objectKey)
    await this.objectStore.put(this.realm, `content/${sha256}`, Buffer.from(prepared.data), prepared.ref.mediaType)
    return { ...prepared.ref, attachmentId: AttachmentId(objectKey) }
  }

  /**
   * 读一张图并校验字节仍匹配引用：digest + byteLength 双重校验。
   * @throws 非法引用 → ATTACHMENT_INVALID_REF；缺对象 → ATTACHMENT_NOT_FOUND；
   *   digest/长度不符 → ATTACHMENT_CORRUPT；后端不可达穿透 capabilityUnavailable。
   */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    let parsed
    try {
      parsed = parseAttachmentKey(String(ref.attachmentId))
    } catch {
      throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
    }
    const stored = await this.objectStore.get(parsed.realm, `content/${parsed.sha256}`)
    signal?.throwIfAborted()
    if (stored === undefined) {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    const data = stored.body
    if (sha256Hex(data) !== parsed.sha256 || data.byteLength !== ref.bytes) {
      throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    signal?.throwIfAborted()
    return { ref, data }
  }
}
