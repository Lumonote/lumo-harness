import { describe, expect, it } from 'vitest'

import {
  MAX_SEGMENT_ITEMS,
  parseSegment,
  SegmentCorruptError,
  segmentInfoKey,
  segmentObjectKey,
  segmentRanges,
  retentionOf,
  serializeSegment,
  sha256Of,
} from '../cold-log.ts'
import type { LogRecord } from '../session-log.ts'

const rec = (seq: number, type = 'message', time = seq * 1000): LogRecord => ({
  sessionRef: 's1', seq, type, payload: { text: `e${seq}` }, time,
})

describe('segmentRanges —— 段边界划分', () => {
  it('无缝、不重叠、封顶', () => {
    const seqs = [1, 2, 3, 4, 5, 6, 7]
    expect(segmentRanges(seqs, 3)).toEqual([
      { startSeq: 1, endSeq: 3 },
      { startSeq: 4, endSeq: 6 },
      { startSeq: 7, endSeq: 7 },
    ])
  })

  it('单段、全长', () => {
    expect(segmentRanges([5, 9], 100)).toEqual([{ startSeq: 5, endSeq: 9 }])
    expect(segmentRanges([7], 1)).toEqual([{ startSeq: 7, endSeq: 7 }])
  })

  it('允许序号有缝（键只依赖真实首尾，不臆造）', () => {
    expect(segmentRanges([1, 5, 9], 2)).toEqual([
      { startSeq: 1, endSeq: 5 },
      { startSeq: 9, endSeq: 9 },
    ])
  })

  it('空集 / 非法段长拒绝', () => {
    expect(() => segmentRanges([], 3)).toThrow()
    expect(() => segmentRanges([1], 0)).toThrow()
    expect(() => segmentRanges([1], -1)).toThrow()
    expect(() => segmentRanges([1], 1.5)).toThrow()
  })
})

describe('键派生', () => {
  it('段键与侧车键', () => {
    expect(segmentObjectKey('r1', 'sess-1', { startSeq: 1, endSeq: 3 }))
      .toBe('r1/session-log/sess-1/1-3.jsonl')
    expect(segmentInfoKey('r1', 'sess-1', { startSeq: 1, endSeq: 3 }))
      .toBe('r1/session-log/sess-1/1-3.info')
  })
})

describe('serializeSegment / parseSegment —— 往返与损坏检测', () => {
  it('往返等值、按 seq 有序、JSONL 逐行', () => {
    const records = [rec(3), rec(1), rec(2)].sort((a, b) => a.seq - b.seq)
    const buf = serializeSegment(records)
    const text = buf.toString('utf8')
    expect(text.split('\n').filter(Boolean)).toHaveLength(3)
    const back = parseSegment('s1', buf)
    expect(back.length).toBe(3)
    expect(back.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(back[0]!.payload).toEqual({ text: 'e1' })
  })

  it('sha256 与字节可对拍（返回全 64 hex）', () => {
    const buf = serializeSegment([rec(1)])
    expect(sha256Of(buf)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('携带侧车校验：篡改字节 → CORRUPT', () => {
    const buf = serializeSegment([rec(1), rec(2)])
    const meta = { sessionRef: 's1', startSeq: 1, endSeq: 2, sha256: sha256Of(buf), bytes: buf.byteLength, items: 2, archivedAt: 0 }
    const tampered = Buffer.concat([buf.subarray(0, 5), Buffer.from('XXXX'), buf.subarray(9)])
    expect(() => parseSegment('s1', tampered, meta)).toThrow(SegmentCorruptError)
  })

  it('坏行 / 形状非法的行 → CORRUPT', () => {
    const bad = Buffer.from('{not json}\n', 'utf8')
    expect(() => parseSegment('s1', bad)).toThrow(SegmentCorruptError)
    const badShape = Buffer.from(JSON.stringify({ nope: 1 }) + '\n', 'utf8')
    expect(() => parseSegment('s1', badShape)).toThrow(SegmentCorruptError)
  })

  it('NUL 字节保真往返（同 PG 端 payload 取舍）', () => {
    const r = rec(1)
    r.payload = { text: 'a\u0000b' }
    const back = parseSegment('s1', serializeSegment([r]))
    expect(back[0]!.payload).toEqual(r.payload)
  })
})

describe('retentionOf —— 保留期三分', () => {
  it('cold / expired 边界', () => {
    // archivedAt=1000, retention=5000: <6000 cold，>=6000 expired
    expect(retentionOf(1_000, 1_000, 5_000)).toBe('cold')
    expect(retentionOf(1_000, 5_999, 5_000)).toBe('cold')
    expect(retentionOf(1_000, 6_000, 5_000)).toBe('expired')
    expect(retentionOf(1_000, 10_000, 5_000)).toBe('expired')
  })

  it('0 保留期：立即可过期', () => {
    expect(retentionOf(1_000, 1_000, 0)).toBe('expired')
  })

  it('负数 / NaN 保留期拒绝', () => {
    expect(() => retentionOf(1, 1, -1)).toThrow()
    expect(() => retentionOf(1, 1, NaN)).toThrow()
  })
})