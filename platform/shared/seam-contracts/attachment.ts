/**
 * 附件 seam 契约（§5.1：MinIO → ctx.datastore.object；P2b 项 10）。
 *
 * 定位（seam 远程形态设计 §1 第 10 行）：附件归属是对象存储——「引用 = 对象键」，
 * 正文按需取，禁止逐次代理到某节点（第二条真相源）。本文件锁**引用形态与键派生**：
 *   - 附件引用（`ImageAttachmentRef.attachmentId`）一律是**对象键**
 *     `<realm>/content/<sha256-hex>`，自描述（自带 realm，跨节点任意取回）；
 *   - 键派生复用对象存储键规则（joinRealmKey）——realm 前缀即越权防线；
 *   - 读侧先 `parseAttachmentKey` 解析出 realm + sha256，直接对象读，不经 Proxy。
 *
 * 与对象存储契约同约定：形状非法抛**裸 Error**（Provider 负责映射成
 * `ATTACHMENT_INVALID_REF` 等封印错误码；IO/能力缺失由 Provider 承担）。
 */
import { joinRealmKey, validRealmKey } from './object-store.ts'

const SHA256_HEX = /^[0-9a-f]{64}$/

/** 是否合法的 sha256 十六进制（`<64hex>`）。 */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value)
}

/**
 * 从附件引用 id 提取 sha256 十六进制。接受 dsh 规范形 `sha256:<64hex>` 或裸
 * `<64hex>`；形状不符返回 undefined（由 Provider 映射成 ATTACHMENT_INVALID_REF）。
 */
export function sha256HexOf(refId: string): string | undefined {
  const bare = refId.startsWith('sha256:') ? refId.slice('sha256:'.length) : refId
  return isSha256Hex(bare) ? bare : undefined
}

/**
 * 附件对象键派生：`<realm>/content/<sha256-hex>`。引用一律对象键，禁止代理。
 * @param realm - 附件归属 realm（身份语义，拼进存储键第一段）。
 * @param refId - dsh 规范引用 id（`sha256:<64hex>`）或裸 `<64hex>`。
 * @throws realm 或引用形状非法——裸 Error（复用对象存储键规则）。
 */
export function attachmentObjectKey(realm: string, refId: string): string {
  const hex = sha256HexOf(refId)
  if (hex === undefined) {
    throw new Error(`附件引用 id 不合法（须 sha256:<64hex> 或 <64hex>）：${JSON.stringify(refId)}`)
  }
  return joinRealmKey(realm, `content/${hex}`)
}

/** 解析出的附件对象键结构性事实。 */
export interface ParsedAttachmentKey {
  /** 附件归属 realm（对象键第一段）。 */
  realm: string
  /** 内容寻址 sha256 十六进制（`<64hex>`）。 */
  sha256: string
}

/**
 * 解析附件引用（对象键）：`<realm>/content/<64hex>` → `{ realm, sha256 }`。
 * 读侧据此直接对象读——附件对象键自带 realm，跨节点任意取回，不经 Proxy。
 * @throws 形状非法（非 `<realm>/content/<64hex>`）——裸 Error。
 */
export function parseAttachmentKey(objectKey: string): ParsedAttachmentKey {
  const slash = objectKey.indexOf('/')
  if (slash <= 0) {
    throw new Error(`附件对象键不合法（缺 realm/content 段）：${JSON.stringify(objectKey)}`)
  }
  const realm = objectKey.slice(0, slash)
  const rest = objectKey.slice(slash + 1)
  if (!validRealmKey(realm)) {
    throw new Error(`附件对象键 realm 段不合法：${JSON.stringify(realm)}`)
  }
  if (!rest.startsWith('content/')) {
    throw new Error(`附件对象键缺 content/ 段：${JSON.stringify(objectKey)}`)
  }
  const sha256 = rest.slice('content/'.length)
  if (!isSha256Hex(sha256)) {
    throw new Error(`附件对象键 sha256 段形状异常：${JSON.stringify(objectKey)}`)
  }
  return { realm, sha256 }
}