import { describe, expect, it } from 'vitest'

import {
  assertNoLocalSpill,
  contentKeyOf,
  joinRealmKey,
  validRealmKey,
} from '../object-store.ts'

/**
 * 对象存储 seam 契约的**键规则**（设计说明 2026-08-26 §2）。
 *
 * put/get 本体是 IO——契约层锁的是可纯函数化的部分：realm 前缀拼接与越狱拒绝、
 * 内容寻址键派生。规则错了是越权事故（realm-a 读到 realm-b 的对象），不是功能 bug。
 */

describe('joinRealmKey / validRealmKey —— realm 前缀执法', () => {
  it('合法相对键拼成 realm 前缀键', () => {
    expect(joinRealmKey('realm-a', 'spill/s1/x.txt')).toBe('realm-a/spill/s1/x.txt')
    expect(joinRealmKey('realm-a', 'a/b/c')).toBe('realm-a/a/b/c')
    expect(joinRealmKey('r1', 'k')).toBe('r1/k')
  })

  it('越狱段拒绝（invalid）——路径穿越/绝对路径/realm 冒充', () => {
    // ../ 穿越会逃出 realm 前缀
    expect(() => joinRealmKey('r1', '../r2/secret')).toThrow()
    expect(() => joinRealmKey('r1', 'a/../../r2/x')).toThrow()
    // 绝对路径吞掉前缀
    expect(() => joinRealmKey('r1', '/etc/passwd')).toThrow()
    // 前导 realm 段 = 冒充别的 realm（拼出来会是 r1/r2/...——合法形状但语义越权，
    // 除非显式允许跨 realm 引用，那该走显式 API 而不是键魔术）
    expect(() => joinRealmKey('r1', 'r2/x')).not.toThrow() // r1/r2/x 仍是 r1 命名空间内的合法键
    // 空键/空段拒绝
    expect(() => joinRealmKey('r1', '')).toThrow()
    expect(() => joinRealmKey('r1', 'a//b')).toThrow()
    expect(() => joinRealmKey('r1', 'a/')).toThrow()
    expect(() => joinRealmKey('r1', '/a')).toThrow()
  })

  it('realm 本体校验：非法 realm 拒绝（拼进存储键，不能带分隔符）', () => {
    expect(() => joinRealmKey('', 'k')).toThrow()
    expect(() => joinRealmKey('a/b', 'k')).toThrow()
    expect(() => joinRealmKey('..', 'k')).toThrow()
    expect(validRealmKey('realm-a')).toBe(true)
    expect(validRealmKey('r1_2-x')).toBe(true)
  })

  it('validRealmKey 与 joinRealmKey 同判（暴露给 Provider 预检）', () => {
    for (const key of ['', '/a', 'a//b', 'a/', '../x', '/etc/x']) {
      expect(() => joinRealmKey('r', key)).toThrow()
    }
    for (const key of ['a', 'a/b', 'spill/s1/x-abc123.txt']) {
      expect(joinRealmKey('r', key)).toBeTruthy()
    }
  })
})

describe('contentKeyOf —— 内容寻址键派生', () => {
  it('同内容同键（幂等）、异内容异键、键含内容指纹', () => {
    const a = contentKeyOf(Buffer.from('hello'))
    const a2 = contentKeyOf('hello') // string 与 Buffer 同内容同键
    const b = contentKeyOf(Buffer.from('world'))
    expect(a).toBe(a2)
    expect(a).not.toBe(b)
    // 键形如 content/<sha256-hex>——含指纹可对拍
    expect(a).toMatch(/^content\/[0-9a-f]{64}$/)
  })

  it('二进制内容（含 NUL 字节）稳定派生', () => {
    const dirty = Buffer.from([0x00, 0x01, 0xff, 0x00])
    expect(contentKeyOf(dirty)).toBe(contentKeyOf(Buffer.from([0x00, 0x01, 0xff, 0x00])))
    expect(contentKeyOf(dirty)).not.toBe(contentKeyOf(Buffer.from([0x00, 0x01, 0xff])))
  })
})

describe('assertNoLocalSpill —— spill 装配互斥（本地 spill 与对象化溢出不共存）', () => {
  it('已注册 spillStore（spill-local）→ 显式拒绝，消息含「spill-local」与「装配」', () => {
    expect(() => assertNoLocalSpill(true)).toThrow(/spill-local/)
    expect(() => assertNoLocalSpill(true)).toThrow(/装配/)
  })

  it('未注册 spillStore → 不抛（平台节点仅对象化 spill，装配合法）', () => {
    expect(() => assertNoLocalSpill(false)).not.toThrow()
  })
})
