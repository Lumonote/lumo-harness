import { describe, expect, it } from 'vitest'

import {
  attachmentObjectKey,
  isSha256Hex,
  parseAttachmentKey,
  sha256HexOf,
} from '../attachment.ts'

const H = 'a'.repeat(64)

/**
 * 附件 seam 契约的**引用形态与键规则**。
 *
 * 保存/读取本体是 IO（Provider 集成测试担），契约层锁的是可纯函数化的部分：sha256
 * 形状校验、引用→对象键派生（引用一律对象键）、对象键→realm/sha256 解析。写明键前后
 * 的语义错配是越权/寻址事故，不是功能 bug。
 */

describe('isSha256Hex / sha256HexOf —— 引用形状校验', () => {
  it('合法 64 位小写十六进制通过；长度/大小写不符皆拒', () => {
    expect(isSha256Hex(H)).toBe(true)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isSha256Hex('A'.repeat(64))).toBe(false)
    expect(isSha256Hex(`${H}z`)).toBe(false)
    expect(isSha256Hex('')).toBe(false)
  })

  it('接受 dsh 规范形 sha256:<hex> 与裸 <hex>；形状不符 undefined', () => {
    expect(sha256HexOf(`sha256:${H}`)).toBe(H)
    expect(sha256HexOf(H)).toBe(H)
    expect(sha256HexOf(`sha256:bad`)).toBeUndefined()
    expect(sha256HexOf('not-a-key')).toBeUndefined()
  })
})

describe('attachmentObjectKey —— 引用一律对象键', () => {
  it('引用 id → <realm>/content/<sha256> 对象键（复用对象存储键规则）', () => {
    expect(attachmentObjectKey('realm-a', `sha256:${H}`)).toBe(`realm-a/content/${H}`)
    expect(attachmentObjectKey('realm-a', H)).toBe(`realm-a/content/${H}`)
  })

  it('非法引用/非法 realm 拒（裸 Error，Provider 负责包错）', () => {
    expect(() => attachmentObjectKey('r', 'nope')).toThrow()
    expect(() => attachmentObjectKey('', H)).toThrow() // 空 realm
    expect(() => attachmentObjectKey('a/b', H)).toThrow() // realm 含分隔符
    expect(() => attachmentObjectKey('..', H)).toThrow() // realm 为 ..
  })
})

describe('parseAttachmentKey —— 对象键解析（读侧定位）', () => {
  it('往返：attachmentObjectKey → parse 得回 realm 与 sha256', () => {
    const objKey = attachmentObjectKey('realm-a', `sha256:${H}`)
    expect(parseAttachmentKey(objKey)).toEqual({ realm: 'realm-a', sha256: H })
  })

  it('非法形状拒', () => {
    expect(() => parseAttachmentKey('no-slash')).toThrow()
    expect(() => parseAttachmentKey(`realm-a/${H}`)).toThrow() // 缺 content/ 段
    expect(() => parseAttachmentKey('realm-a/content/zzzz')).toThrow() // sha256 形状异常
    expect(() => parseAttachmentKey('..//content/' + H)).toThrow() // realm 段越狱
  })
})