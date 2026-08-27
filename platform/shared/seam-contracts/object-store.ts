/**
 * 对象存储 seam 契约（§5.1：MinIO → ctx.datastore.object，写后可读强一致）。
 *
 * 定位（seam 远程形态设计 2026-08-26 §1 第 10/11 行）：附件与溢出内容的归属是
 * 对象存储——「引用 = 对象键，正文按需取」，禁止逐次代理到某节点（第二条真相源）。
 *
 * 本文件锁**键规则与派生函数**（纯函数，两侧可测）；IO 语义（写后可读、能力缺失
 * fail closed）由 Provider 实现并以其集成测试承担：
 *   - realm 前缀是**越权防线**：调用方只给 realm 与相对键，Provider 拼接并拒绝越狱段；
 *   - 内容寻址键由 sha256 派生，同内容幂等同键；
 *   - MinIO 不可达 → capabilityUnavailable（铁律 21：显式拒绝，不静默降级）。
 */

import { createHash } from 'node:crypto'

/** 对象读取结果。缺对象由调用方以 undefined 处理（不是异常——命名对象缺失是正常态）。 */
export interface StoredObject {
  body: Buffer
  contentType?: string
}

export interface ObjectStat {
  bytes: number
  etag?: string
}

/** 对象存储 seam（Provider 接口；契约纯函数见下方导出）。 */
export interface ObjectStoreSeam {
  /** 命名对象写入。key 是 realm 内相对键（键规则见 {@link joinRealmKey}）。 */
  put(realm: string, key: string, body: Buffer | string, contentType?: string): Promise<void>
  /** 内容寻址写入：键 = content/<sha256>，同内容幂等同键。返回完整对象键。 */
  putContent(realm: string, body: Buffer | string, contentType?: string): Promise<string>
  /** 读取。缺对象返回 undefined；后端不可达抛 capabilityUnavailable。 */
  get(realm: string, key: string): Promise<StoredObject | undefined>
  /** 删除（幂等：缺对象不报错）。 */
  delete(realm: string, key: string): Promise<void>
  stat(realm: string, key: string): Promise<ObjectStat | undefined>
}

/** 合法 realm 段：非空、单段（无 `/`）、非 `.`/`..`。拼进存储键的第一段，先于一切校验。 */
export function validRealmKey(realm: string): boolean {
  return realm !== '' && !realm.includes('/') && realm !== '.' && realm !== '..' && !realm.includes('\\')
}

/** 合法相对键段：非空、无空段（`//`）、无前导/尾随斜杠、无 `..` 段（穿越即越权）。 */
function validRelativeKey(key: string): boolean {
  if (key === '' || key.startsWith('/') || key.endsWith('/')) return false
  const segments = key.split('/')
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

/**
 * realm 前缀键拼接（越权防线的执法点）。
 *
 * @throws 参数非法（realm 含分隔符 / 键含穿越或空段）——SeamError(invalid) 的职责
 *   由 Provider 包裹；契约层抛裸错即可（两侧测试同断言）。
 */
export function joinRealmKey(realm: string, key: string): string {
  if (!validRealmKey(realm)) {
    throw new Error(`realm 段不合法（须非空单段、不含 / 与 \\）：${JSON.stringify(realm)}`)
  }
  if (!validRelativeKey(key)) {
    throw new Error(
      `对象键不合法（相对键：无空段、无前导/尾随斜杠、无 . / .. 段）：${JSON.stringify(key)}`,
    )
  }
  return `${realm}/${key}`
}

/** 装配互斥：平台节点的 spill 必须是对象化（跨节点可取回，行 11）；本地 spill 共存=错误装配。 */
export function assertNoLocalSpill(spillAlreadyRegistered: boolean): void {
  if (spillAlreadyRegistered) {
    throw new Error(
      'object-store: 检测到已注册的 spillStore（spill-local）——与平台对象化溢出互斥；'
      + '装配须禁用 spill-local（见 dsh bundle base 的 spill-local 行与 §5.1 行 11）',
    )
  }
}

/** 内容寻址键派生：`content/<sha256-hex>`。字符串与 Buffer 同内容同键。 */
export function contentKeyOf(body: Buffer | string): string {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  return `content/${createSha256Hex(buf)}`
}

function createSha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
