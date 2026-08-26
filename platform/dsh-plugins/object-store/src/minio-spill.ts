/**
 * MinIO 版 SpillStore —— dsh `ctx.spillStore` 抽象类的平台实现（seam 远程形态设计
 * 2026-08-26 §1 第 11 行：溢出内容对象化，跨节点 resume 任意节点可取回）。
 *
 * dsh 契约语义逐条兑现（packages/spill/spill/lib/types）：
 *   - saveText **全文 verbatim**（UTF-8）；bytes = 字节长度；
 *   - 存储按 owner.sessionId 分组；名字从 suggestedName 派生但**不等于**它（hint 非
 *     路径），加内容哈希防碰撞；
 *   - 真实存储失败即 **reject**（capabilityUnavailable）——降级决策留给 spill policy
 *     （它把拒绝视为 best-effort，保持 inline 结果），语义链完整。
 *
 * 键形：`<realm>/spill/<sessionId>/<sanitized>-<sha256 前 8>`——`spill/` 前缀供部署期
 * 桶生命周期规则做 TTL（设计说明 §3：不做每对象 TTL——MinIO 无此语义，伪造即撒谎）。
 */
import { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill'

import { MinioObjectStore, type MinioStoreOptions } from './minio-store.ts'
import { createHash } from 'node:crypto'

/** suggestedName → 单个安全路径段（dsh 契约：「sanitizes it to a single safe path segment」）。 */
function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]+/g, '_') // 非法字符折叠
    .replace(/^\.+/, '')                // 前导点（隐藏文件/穿越起手）剥掉
    .slice(0, 64)                       // 长度上限：FAT/显示友好
  return cleaned === '' ? 'spill' : cleaned
}

export interface MinioSpillOptions extends MinioStoreOptions {
  /** realm 由装配层注入（SpillOwner 无 realm 字段——身份语义不在存储契约里）。 */
  realm: string
}

export class MinioSpillStore extends SpillStore {
  private store: MinioObjectStore
  private realm: string

  constructor(ctx: Context, opts: MinioSpillOptions) {
    // SpillStore extends Service(ctx)——`super(ctx)` 注册为 `ctx.spillStore`（同 spill-local）。
    super(ctx)
    this.store = new MinioObjectStore(opts)
    this.realm = opts.realm
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const buf = Buffer.from(input.content, 'utf8')
    // 防碰撞后缀：内容指纹前 8 位。同 session 同名同内容 → 同键幂等（重投良性）；
    // 同名不同内容 → 不同键（两个 artifact，dsh 契约未承诺去重，内容区分即正确）。
    const fingerprint = createHash('sha256').update(buf).digest('hex').slice(0, 8)
    const relative = `spill/${input.owner.sessionId}/${sanitizeSegment(input.suggestedName)}-${fingerprint}`
    await this.store.put(this.realm, relative, buf, 'text/plain; charset=utf-8')
    const fullKey = `${this.realm}/${relative}`
    return {
      locator: SpillLocator(fullKey),
      bytes: buf.length,
      retrievalHint:
        `溢出内容已对象化（平台对象存储，键 ${fullKey}）。` +
        '跨节点可经 ctx.datastore.object 按同一键取回；保留期由对象生命周期策略管理。',
    }
  }

  /** 测试/装配辅助：经同一 seam 取回（跨节点取回性的最小等价验证）。 */
  async readBack(locator: string): Promise<Buffer | undefined> {
    // locator 是完整对象键（realm 已含在前缀里）——从键里拆回 realm 与相对键
    const idx = locator.indexOf('/')
    if (idx <= 0) return undefined
    const realm = locator.slice(0, idx)
    const key = locator.slice(idx + 1)
    const got = await this.store.get(realm, key)
    return got?.body
  }
}
