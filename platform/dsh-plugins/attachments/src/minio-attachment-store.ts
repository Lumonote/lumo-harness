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
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  FileAttachmentRef,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  ImageRequestTarget,
  RequestImageAttachment,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  prepareImageFile,
  validateImageFile,
  readImageFile,
  readRequestImageFile,
} from '@deepseek-ai/dsh-attachment-local'
import type { NormalizationPolicy } from '@deepseek-ai/dsh-attachment-local'
import type { Context } from '@deepseek-ai/cordis'

import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'
import { validRealmKey } from '../../../shared/seam-contracts/object-store.ts'
import { bounded,chunks,saveFile,readFile } from './file-transfer.ts'
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
  /** Server-side admission limits; no host path or executable is granted. */
  maxFileBytes?: number
  maxConcurrentTransfers?: number
  transferTimeoutMs?: number
}

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
const DEFAULT_MAX_IMAGE_DIMENSION = 8192
const DEFAULT_NORMALIZED_MAX_PIXELS = 2048 * 2048
const DEFAULT_NORMALIZED_MAX_DIMENSION = 2048
const DEFAULT_NORMALIZED_MAX_BYTES = 4 * 1024 * 1024

function positiveSetting(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new TypeError('Invalid attachment limit')
  }
  return resolved
}

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
  private readonly maxFileBytes:number
  private readonly maxConcurrentTransfers:number
  private readonly transferTimeoutMs:number
  private activeTransfers=0

  constructor(ctx: Context, options: MinioAttachmentOptions) {
    super(ctx)
    if(!validRealmKey(options.realm))throw new TypeError('Attachment Realm is invalid')
    this.realm = options.realm
    this.objectStore = ctx.objectStore as ObjectStoreSeam
    this.imageLimits = Object.freeze({
      maxImageBytes: positiveSetting(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES),
      maxImagesPerMessage: positiveSetting(options.maxImagesPerMessage, DEFAULT_MAX_IMAGES_PER_MESSAGE),
      maxMessageImageBytes: positiveSetting(options.maxMessageImageBytes, DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
      maxImagePixels: positiveSetting(options.maxImagePixels, DEFAULT_MAX_IMAGE_PIXELS),
      maxImageDimension: positiveSetting(options.maxImageDimension, DEFAULT_MAX_IMAGE_DIMENSION),
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.normalizationPolicy = Object.freeze({
      maxPixels: positiveSetting(options.normalizedImageMaxPixels, DEFAULT_NORMALIZED_MAX_PIXELS),
      maxDimension: positiveSetting(options.normalizedImageMaxDimension, DEFAULT_NORMALIZED_MAX_DIMENSION),
      maxBytes: positiveSetting(options.normalizedImageMaxBytes, DEFAULT_NORMALIZED_MAX_BYTES),
    })
    this.maxFileBytes=positiveSetting(options.maxFileBytes,50*1024*1024,1024*1024*1024)
    this.maxConcurrentTransfers=positiveSetting(options.maxConcurrentTransfers,4,16)
    this.transferTimeoutMs=positiveSetting(options.transferTimeoutMs,60000,300000)
  }

  private async transfer<T>(signal:AbortSignal|undefined,work:(active:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.activeTransfers>=this.maxConcurrentTransfers)throw new AttachmentError('Attachment transfer capacity reached.','ATTACHMENT_WRITE_FAILED')
    this.activeTransfers++
    const active=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.transferTimeoutMs)])
    try{return await work(active)}finally{this.activeTransfers--}
  }

  override saveFile(input:SaveFileAttachment):Promise<FileAttachmentRef>{
    return this.saveFileStream({data:(async function*(){yield input.data})(),name:input.name})
  }
  override saveFileStream(input:SaveFileStreamAttachment):Promise<FileAttachmentRef>{
    return this.transfer(input.signal,signal=>saveFile(this.objectStore,this.realm,input,this.maxFileBytes,signal))
  }
  override async *readFileStream(ref:FileAttachmentRef,signal?:AbortSignal):AsyncIterable<Uint8Array>{
    if(this.activeTransfers>=this.maxConcurrentTransfers)throw new AttachmentError('Attachment transfer capacity reached.','ATTACHMENT_READ_FAILED')
    this.activeTransfers++
    const active=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.transferTimeoutMs)])
    try{yield*readFile(this.objectStore,this.realm,ref,this.maxFileBytes,active)}finally{this.activeTransfers--}
  }

  override readImageRequest(ref:ImageAttachmentRef,target:ImageRequestTarget,signal?:AbortSignal):Promise<RequestImageAttachment>{
    return this.transfer(signal,async active=>{
      // Upstream's public helper owns encoding, policy identity, alpha handling
      // and byte budgets. Its cache is a disposable local derivative only.
      const stored=await this.readVerifiedImage(ref,active)
      const directory=await mkdtemp(join(tmpdir(),'lumo-image-variant-'))
      // Await the bounded-pixel native codec itself before releasing capacity
      // or deleting its transient directory; cancellation is checked by the
      // public helper around the codec, never a race that leaks late writes.
      try{return await readRequestImageFile(directory,stored,target,active)}finally{await rm(directory,{recursive:true,force:true})}
    })
  }

  /** 校验一张图而不触存储（batch 调方先全验再全存）。 */
  async validateImage(input: SaveImageAttachment): Promise<void> {
    return this.transfer(undefined, async signal => {
      signal.throwIfAborted()
      await validateImageFile(input, this.imageLimits, this.normalizationPolicy)
      signal.throwIfAborted()
    })
  }

  /**
   * 校验+归一化一次并写入对象存储，返回对象键引用。
   * 引用 = `<realm>/content/<sha256>`——自描述对象键，同内容同键幂等。
   */
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return this.transfer(undefined, async signal => {
      signal.throwIfAborted()
      // Native image work keeps its capacity slot until it actually settles.
      const prepared = await prepareImageFile(input, this.imageLimits, this.normalizationPolicy)
      signal.throwIfAborted()
      const objectKey = attachmentObjectKey(this.realm, String(prepared.ref.attachmentId))
      const { sha256 } = parseAttachmentKey(objectKey)
      await bounded(this.objectStore.put(this.realm, `content/${sha256}`, Buffer.from(prepared.data), prepared.ref.mediaType), signal)
      signal.throwIfAborted()
      return { ...prepared.ref, attachmentId: AttachmentId(objectKey) }
    })
  }

  /**
   * 读一张图并校验字节仍匹配引用：digest + byteLength 双重校验。
   * @throws 非法引用 → ATTACHMENT_INVALID_REF；缺对象 → ATTACHMENT_NOT_FOUND；
   *   digest/长度不符 → ATTACHMENT_CORRUPT；后端不可达穿透 capabilityUnavailable。
   */
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return this.transfer(signal,active=>this.readVerifiedImage(ref,active))
  }
  private async readVerifiedImage(ref:ImageAttachmentRef,signal:AbortSignal):Promise<StoredImageAttachment>{
    signal.throwIfAborted()
    let parsed
    try {
      parsed = parseAttachmentKey(String(ref.attachmentId))
      if(parsed.realm!==this.realm||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>this.normalizationPolicy.maxBytes
        ||!Number.isSafeInteger(ref.width)||ref.width<1||!Number.isSafeInteger(ref.height)||ref.height<1
        ||ref.width>this.imageLimits.maxImageDimension||ref.height>this.imageLimits.maxImageDimension
        ||ref.width>this.normalizationPolicy.maxDimension||ref.height>this.normalizationPolicy.maxDimension
        ||ref.width*ref.height>this.imageLimits.maxImagePixels||ref.width*ref.height>this.normalizationPolicy.maxPixels
        ||!this.imageLimits.mediaTypes.includes(ref.mediaType))throw new Error('Invalid attachment metadata')
    } catch {
      throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
    }
    if(!this.objectStore.getStream)throw new AttachmentError('The object provider cannot stream images.','ATTACHMENT_READ_FAILED')
    const stored = await bounded(this.objectStore.getStream(this.realm, `content/${parsed.sha256}`,signal),signal)
    if (stored === undefined) {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    if(stored.bytes!==ref.bytes||stored.bytes>this.normalizationPolicy.maxBytes)throw new AttachmentError('Stored attachment failed integrity verification.','ATTACHMENT_CORRUPT')
    const parts:Buffer[]=[];let bytes=0
    for await(const part of chunks(stored.body,signal)){bytes+=part.byteLength;if(bytes>ref.bytes||bytes>this.normalizationPolicy.maxBytes)throw new AttachmentError('Stored attachment exceeds its reference size.','ATTACHMENT_CORRUPT');parts.push(Buffer.from(part))}
    const data=Buffer.concat(parts)
    if (sha256Hex(data) !== parsed.sha256 || data.byteLength !== ref.bytes) {
      throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    const directory=await mkdtemp(join(tmpdir(),'lumo-image-verify-'))
    try{
      const parent=join(directory,'objects',parsed.sha256.slice(0,2))
      await mkdir(parent,{recursive:true,mode:0o700});await writeFile(join(parent,parsed.sha256),data,{mode:0o600,signal})
      // This public upstream reader verifies actual format and dimensions as
      // well as digest/length. Temporary files are never exposed as host paths.
      const verified=await bounded(readImageFile(directory,{...ref,attachmentId:AttachmentId(`sha256:${parsed.sha256}`)},signal),signal)
      return {ref,data:verified.data}
    }finally{await rm(directory,{recursive:true,force:true})}
  }
}
