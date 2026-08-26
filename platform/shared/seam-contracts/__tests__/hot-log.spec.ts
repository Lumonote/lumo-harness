import { describe, expect, it } from 'vitest'

import {
  contiguousSeq,
  hotRelativeKey,
  parseHotRecord,
  serializeHotRecord,
  windowCovered,
} from '../hot-log.ts'
import type { LogRecord } from '../session-log.ts'

const rec = (seq: number, over: Partial<LogRecord> = {}): LogRecord => ({
  sessionRef: 's1',
  seq,
  type: over.type ?? 'message',
  payload: over.payload ?? { text: `e${seq}` },
  time: over.time ?? seq * 1000,
})

describe('hotRelativeKey —— 热键派生', () => {
  it('形如 session-log/hot/<realm>/<session>', () => {
    expect(hotRelativeKey('r1', 'sess-1')).toBe('session-log/hot/r1/sess-1')
  })

  it('realm 与 session 含特殊字符时直接拼接；与冷层键不同前缀', () => {
    // realm 是身份段、session 任意字符直接拼——无段穿越面，不做越狱拒绝
    expect(hotRelativeKey('re@1', 'a/b c:中')).toBe('session-log/hot/re@1/a/b c:中')
    // 冷层键形如 session-log/<session>/...：热键多 hot/ 段，永不撞键
    expect(hotRelativeKey('r1', 's1')).not.toBe('session-log/s1')
    expect(hotRelativeKey('r1', 's1').startsWith('session-log/hot/')).toBe(true)
  })

  it('realm 隔离：不同 realm 不同键（跨 realm 共用一个 Redis 时不串数据）', () => {
    expect(hotRelativeKey('r1', 's1')).not.toBe(hotRelativeKey('r2', 's1'))
  })
})

describe('windowCovered —— 闭区间覆盖判定', () => {
  it('< first 不覆盖', () => {
    expect(windowCovered(5, 9, 4)).toBe(false)
  })

  it('== first 覆盖', () => {
    expect(windowCovered(5, 9, 5)).toBe(true)
  })

  it('== last 覆盖', () => {
    expect(windowCovered(5, 9, 9)).toBe(true)
  })

  it('== last+1 不覆盖（缓存写落后于 PG 的瞬时窗口必须回 PG）', () => {
    expect(windowCovered(5, 9, 10)).toBe(false)
  })

  it('fromSeq=0：仅当窗口真的从 0 开始才覆盖', () => {
    expect(windowCovered(1, 9, 0)).toBe(false)
    expect(windowCovered(0, 9, 0)).toBe(true)
  })

  it('区间内部覆盖', () => {
    expect(windowCovered(5, 9, 7)).toBe(true)
  })
})

describe('serializeHotRecord / parseHotRecord —— 单行 JSON 往返', () => {
  it('往返等值（unicode + 嵌套对象）', () => {
    const r = rec(7, {
      type: 'tool_output',
      payload: { stdout: '中文输出', nested: { 键: '值', arr: [1, null, true, { x: 1 }] } },
    })
    expect(parseHotRecord(serializeHotRecord(r), 's1')).toEqual(r)
  })

  it('NUL 字节保真往返（同 PG 端 payload TEXT 的取舍）', () => {
    const r = rec(1, { payload: { text: 'a\0b' } })
    const line = serializeHotRecord(r)
    expect(line).not.toContain('\0') // 已转义成 ASCII
    expect(parseHotRecord(line, 's1').payload).toEqual(r.payload)
  })

  it('单行、无原始换行', () => {
    const line = serializeHotRecord(rec(1, { payload: { text: 'x\ny' } }))
    expect(line).not.toContain('\n')
  })

  it('坏行（非 JSON / 形状非法）必须抛错——读侧按事故处置，不静默跳过', () => {
    expect(() => parseHotRecord('{not json', 's1')).toThrow()
    expect(() => parseHotRecord('42', 's1')).toThrow()
    expect(() => parseHotRecord('null', 's1')).toThrow()
    expect(() => parseHotRecord('[]', 's1')).toThrow()
    expect(() => parseHotRecord(JSON.stringify({ seq: 'x' }), 's1')).toThrow()
    expect(() => parseHotRecord(JSON.stringify({ seq: 1, type: 2, time: 3 }), 's1')).toThrow()
    expect(() => parseHotRecord(JSON.stringify({ seq: 1, type: 't' }), 's1')).toThrow()
  })

  it('sessionRef 以参数为准（键派生身份，行内值不作数）', () => {
    expect(parseHotRecord(serializeHotRecord(rec(1)), 's-from-key').sessionRef).toBe('s-from-key')
  })
})

describe('contiguousSeq —— 窗口完整性断言', () => {
  it('连续升序', () => {
    expect(contiguousSeq([1, 2, 3, 4])).toBe(true)
  })

  it('单元素 / 空窗口视为连续', () => {
    expect(contiguousSeq([7])).toBe(true)
    expect(contiguousSeq([])).toBe(true)
  })

  it('跳号 = 有洞，不可信', () => {
    expect(contiguousSeq([1, 3])).toBe(false)
    expect(contiguousSeq([1, 2, 4])).toBe(false)
  })

  it('重复 = 有洞（重复镜像会让同一 seq 出现两次）', () => {
    expect(contiguousSeq([1, 1, 2])).toBe(false)
  })

  it('乱序视为不可信（窗口序 = append 序，乱序即写入序被破坏）', () => {
    expect(contiguousSeq([2, 1])).toBe(false)
  })

  it('非整数间隔不可信', () => {
    expect(contiguousSeq([1, 1.5])).toBe(false)
  })
})
