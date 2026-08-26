/**
 * MinIO 版对象存储 Provider（§5.1：ctx.datastore.object，写后可读强一致）。
 *
 * 越权防线在 {@link joinRealmKey}（契约）：realm 前缀拼接 + 越狱段拒绝，Provider
 * 不重复实现也不放行。能力缺失（铁律 21）：后端不可达/未配置 → capabilityUnavailable，
 * 绝不静默降级成本地文件——那是第二条真相源。
 */
import * as Minio from 'minio'

import {
  capabilityUnavailable,
  invalid,
  SeamError,
} from '../../../shared/seam-contracts/errors.ts'
import {
  contentKeyOf,
  joinRealmKey,
  type ObjectStat,
  type ObjectStoreSeam,
  type StoredObject,
} from '../../../shared/seam-contracts/object-store.ts'

export interface MinioStoreOptions {
  endPoint: string
  port?: number
  useSSL?: boolean
  accessKey: string
  secretKey: string
  bucket: string
  region?: string
}

/** S3/MinIO 错误码形态（SDK 抛的错带 code 字段；连接错误带 node 错误码）。 */
function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code)
  }
  return undefined
}

/** 后端不可达判定：非 S3 语义错误（连接拒绝/超时/DNS）都算能力缺失。 */
function isConnectivityError(err: unknown): boolean {
  const code = errorCode(err)
  if (code === undefined) return false
  return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code)
}

/**
 * 缺失对象判定：S3/MinIO 对同一「缺对象」给了两种码——GET 带 body 时为 `NoSuchKey`，
 * HEAD（statObject）无 body 时 SDK 按 404 兜底成 `NotFound`。缺对象是正常态（契约：
 * 返回 undefined），两种码都归入缺失而非当异常抛。
 */
function isNotFound(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'NoSuchKey' || code === 'NotFound'
}

export class MinioObjectStore implements ObjectStoreSeam {
  private client: Minio.Client
  private bucket: string
  /** init 幂等标志：桶存在性只在首次 ensure。 */
  private ensured: Promise<void> | undefined

  constructor(opts: MinioStoreOptions) {
    this.client = new Minio.Client({
      endPoint: opts.endPoint,
      port: opts.port ?? (opts.useSSL ? 443 : 80),
      useSSL: opts.useSSL ?? false,
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: opts.region,
    })
    this.bucket = opts.bucket
  }

  /** 幂等建桶（dev 拓扑允许服务先于运维建桶）。 */
  init(): Promise<void> {
    this.ensured ??= (async () => {
      try {
        if (!(await this.client.bucketExists(this.bucket))) {
          await this.client.makeBucket(this.bucket)
        }
      } catch (err) {
        this.ensured = undefined // 失败不缓存——下次 init 重试
        throw wrap(err, '初始化对象存储桶失败')
      }
    })()
    return this.ensured
  }

  async put(realm: string, key: string, body: Buffer | string, contentType?: string): Promise<void> {
    const full = safeJoin(realm, key)
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    try {
      await this.init()
      await this.client.putObject(this.bucket, full, buf, buf.length, contentType ? { 'Content-Type': contentType } : undefined)
    } catch (err) {
      throw wrap(err, `写入对象 ${full} 失败`)
    }
  }

  async putContent(realm: string, body: Buffer | string, contentType?: string): Promise<string> {
    // 键派生与内容写入之间没有 TOCTOU 问题：同内容必然同键，后写覆盖先写是同字节
    const relative = contentKeyOf(body)
    await this.put(realm, relative, body, contentType)
    return joinRealmKey(realm, relative)
  }

  async get(realm: string, key: string): Promise<StoredObject | undefined> {
    const full = safeJoin(realm, key)
    try {
      await this.init()
      const stream = await this.client.getObject(this.bucket, full)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      const metaData = await this.client.statObject(this.bucket, full)
      return {
        body: Buffer.concat(chunks),
        contentType: metaData.metaData?.['content-type'] ?? metaData.metaData?.['Content-Type'],
      }
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw wrap(err, `读取对象 ${full} 失败`)
    }
  }

  async delete(realm: string, key: string): Promise<void> {
    const full = safeJoin(realm, key)
    try {
      await this.init()
      // MinIO removeObject 对缺对象幂等（不抛 NoSuchKey）——契约要求删除幂等，正合适
      await this.client.removeObject(this.bucket, full)
    } catch (err) {
      throw wrap(err, `删除对象 ${full} 失败`)
    }
  }

  async stat(realm: string, key: string): Promise<ObjectStat | undefined> {
    const full = safeJoin(realm, key)
    try {
      await this.init()
      const s = await this.client.statObject(this.bucket, full)
      return { bytes: s.size, etag: s.etag }
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw wrap(err, `stat 对象 ${full} 失败`)
    }
  }
}

/** 键规则错误透传（invalid 语义由调用面包装）；连接错误统一 capabilityUnavailable。 */
function safeJoin(realm: string, key: string): string {
  try {
    return joinRealmKey(realm, key)
  } catch (err) {
    throw invalid(String((err as Error).message))
  }
}

function wrap(err: unknown, context: string): Error {
  // 已分类的 seam 错误（如 init 里先抛出的 capabilityUnavailable）直接透传——
  // 绝不二次包成 generic Error 丢掉 code（否则 host 侧会把「能力缺失」误判成 internal）。
  if (err instanceof SeamError) return err
  if (isConnectivityError(err)) {
    return capabilityUnavailable(`${context}：对象存储后端不可达（${errorCode(err)}）——显式拒绝，不降级为本地存储`)
  }
  return new Error(`${context}: ${String((err as Error)?.message ?? err)}`)
}
