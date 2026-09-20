import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STALLED_AFTER_MS,
  DEFAULT_WAIT_TTL_MS,
  deriveThreadBoard,
  type ThreadBoard,
  type ThreadCellId,
  type ThreadFacts,
} from '../src/client/thread-board.ts'

const NOW = Date.parse('2026-09-20T10:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const thread = (id: string, over: Partial<ThreadFacts> = {}): ThreadFacts => ({ id, title: id, ...over })

const column = (board: ThreadBoard, id: ThreadCellId) => board.columns.find(item => item.id === id)!

describe('deriveThreadBoard', () => {
  it('把「待深度审」与「待轻量答」分成两格——这一刀本身就是这个看板存在的理由', () => {
    const board = deriveThreadBoard([
      thread('t-review', { business_state: 'IN_REVIEW', state: 'RUNNING' }),
      thread('t-answer', { business_state: 'EXECUTING', state: 'RUNNING', control_state: 'awaiting-approval' }),
    ], { now: NOW, controlState: true })

    // 合成一个「待处理」列表就等于没做这件事：审要进入心流，答只是一次点击。
    expect(column(board, 'deep-review').entries.map(entry => entry.id)).toEqual(['t-review'])
    expect(column(board, 'light-answer').entries.map(entry => entry.id)).toEqual(['t-answer'])
  })

  it('控制态没接线时，「待轻量答」说明读不到，而不是空着或写 0 条', () => {
    const board = deriveThreadBoard([thread('t-1', { business_state: 'EXECUTING', state: 'RUNNING' })], { now: NOW })
    const answer = column(board, 'light-answer')
    // 空是一个结论（没有人在等）；缺读面只是缺读面。两者在屏幕上长得一样是最贵的错。
    expect(answer.entries).toEqual([])
    expect(answer.unreadable).toContain('读不到')
    expect(answer.unreadable).toContain('awaiting-approval')
  })

  it('接线了但有行没带控制态，这一格同样不能声称「没有人在等」', () => {
    const board = deriveThreadBoard([
      thread('t-1', { business_state: 'EXECUTING', state: 'RUNNING', control_state: null }),
      thread('t-2', { business_state: 'EXECUTING', state: 'RUNNING' }),
    ], { now: NOW, controlState: true })
    expect(column(board, 'light-answer').unreadable).toContain('1 行')
  })

  it('执行中三档都进同一格，且只有 RUNNING 才算「在跑」', () => {
    const board = deriveThreadBoard([
      thread('t-assigned', { business_state: 'ASSIGNED', state: 'QUEUED', updated_at: ago(DEFAULT_STALLED_AFTER_MS * 3) }),
      thread('t-executing', { business_state: 'EXECUTING', state: 'RUNNING' }),
      thread('t-verifying', { business_state: 'VERIFYING', state: 'COMPLETED' }),
    ], { now: NOW })
    expect(column(board, 'executing').entries.map(entry => entry.id).sort()).toEqual(['t-assigned', 't-executing', 't-verifying'])
    // 还没开跑的不会静默：它只是还没轮到，标成静默会招来多余介入。
    expect(column(board, 'executing').entries.find(entry => entry.id === 't-assigned')!.silent).toBe(false)
  })

  it('有活跃 Run 但超过静默阈值：留在「执行中」格，标出静默时长', () => {
    const board = deriveThreadBoard([
      thread('t-quiet', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: ago(12 * 60_000) }),
      thread('t-fresh', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: ago(60_000) }),
    ], { now: NOW })
    const entries = column(board, 'executing').entries
    // 静默的行不换格——它确实在跑；换格会让看板说谎。
    expect(entries.map(entry => entry.id)).toEqual(['t-quiet', 't-fresh'])
    expect(entries[0]).toMatchObject({ silent: true, ageMs: 12 * 60_000 })
    expect(entries[1]!.silent).toBe(false)
  })

  it('静默阈值是严格大于：刚好到阈值不算静默', () => {
    const board = deriveThreadBoard([
      thread('t-edge', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: ago(DEFAULT_STALLED_AFTER_MS) }),
    ], { now: NOW })
    expect(column(board, 'executing').entries[0]!.silent).toBe(false)
  })

  it('时间戳缺失或不可解析时不猜：既不静默，也没有时长', () => {
    const board = deriveThreadBoard([
      thread('t-none', { business_state: 'EXECUTING', state: 'RUNNING' }),
      thread('t-bad', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: 'not-a-date' }),
    ], { now: NOW })
    for (const entry of column(board, 'executing').entries) {
      expect(entry.silent).toBe(false)
      expect(entry.ageMs).toBeUndefined()
    }
  })

  it('等待超过上限进「已停」：注意力类型从心流/点击变成分类', () => {
    const board = deriveThreadBoard([
      thread('t-stale', { business_state: 'IN_REVIEW', updated_at: ago(DEFAULT_WAIT_TTL_MS + 60_000) }),
      thread('t-waiting', { business_state: 'IN_REVIEW', updated_at: ago(DEFAULT_WAIT_TTL_MS - 60_000) }),
    ], { now: NOW })
    expect(column(board, 'deep-review').entries.map(entry => entry.id)).toEqual(['t-waiting'])
    const expired = column(board, 'stopped').entries[0]!
    expect(expired.id).toBe('t-stale')
    expect(expired.waitExpired).toBe(true)
    expect(expired.reason).toContain('等待超过上限')
  })

  it('执行中的线程不因静默而「超时」——它不是等待', () => {
    const board = deriveThreadBoard([
      thread('t-long', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: ago(DEFAULT_WAIT_TTL_MS * 5) }),
    ], { now: NOW })
    expect(column(board, 'executing').entries[0]!.waitExpired).toBe(false)
    expect(column(board, 'stopped').entries).toEqual([])
  })

  it('已停与已完成各归各格，且已停带得出处置理由', () => {
    const board = deriveThreadBoard([
      thread('t-failed', { business_state: 'EXECUTING', state: 'FAILED', last_error: '节点失联' }),
      thread('t-cancelled', { business_state: 'ASSIGNED', state: 'CANCELLED' }),
      thread('t-rejected', { business_state: 'REJECTED', state: 'COMPLETED' }),
      thread('t-done', { business_state: 'DONE', state: 'COMPLETED' }),
      thread('t-archived', { business_state: 'ARCHIVED', state: 'COMPLETED' }),
    ], { now: NOW })
    expect(column(board, 'stopped').entries.map(entry => entry.id).sort()).toEqual(['t-cancelled', 't-failed', 't-rejected'])
    expect(column(board, 'stopped').entries.find(entry => entry.id === 't-failed')!.reason).toBe('Run 失败，等处置')
    expect(column(board, 'done').entries.map(entry => entry.id).sort()).toEqual(['t-archived', 't-done'])
  })

  it('落在五格之外的行不消失，带着理由进「格外」', () => {
    const board = deriveThreadBoard([
      thread('t-draft', { business_state: 'DRAFT', state: 'QUEUED' }),
      thread('t-routing', { business_state: 'ROUTING', state: 'QUEUED' }),
      thread('t-legacy', { state: 'QUEUED' }),
      thread('t-alien', { business_state: 'PAUSED', state: 'RUNNING' }),
    ], { now: NOW })
    expect(board.placed).toBe(0)
    expect(board.outside.map(item => item.id)).toEqual(['t-draft', 't-routing', 't-legacy', 't-alien'])
    for (const item of board.outside) expect(item.reason).not.toBe('')
  })

  it('每一行最多落一格：五格合计等于落格行数', () => {
    const board = deriveThreadBoard([
      thread('t-1', { business_state: 'IN_REVIEW' }),
      thread('t-2', { business_state: 'EXECUTING', state: 'RUNNING' }),
      thread('t-3', { business_state: 'DONE', state: 'COMPLETED' }),
      thread('t-4', { business_state: 'ROUTING' }),
    ], { now: NOW })
    expect(board.columns.flatMap(item => item.entries).map(entry => entry.id).sort()).toEqual(['t-1', 't-2', 't-3'])
    expect(board.placed).toBe(3)
  })

  it('顺序由处置紧迫度定，不由到达顺序定', () => {
    const board = deriveThreadBoard([
      thread('t-new', { business_state: 'IN_REVIEW', updated_at: ago(60_000) }),
      thread('t-old', { business_state: 'IN_REVIEW', updated_at: ago(20 * 60_000) }),
      thread('t-no-time', { business_state: 'IN_REVIEW' }),
      thread('z-noisy', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: ago(60_000) }),
      thread('a-quiet', { business_state: 'EXECUTING', state: 'RUNNING', updated_at: ago(30 * 60_000) }),
    ], { now: NOW })
    // 等得最久的排最前；时长未知的排最后。
    expect(column(board, 'deep-review').entries.map(entry => entry.id)).toEqual(['t-old', 't-new', 't-no-time'])
    // 执行中把静默的顶到前面，它们才是需要看一眼的那些。
    expect(column(board, 'executing').entries.map(entry => entry.id)).toEqual(['a-quiet', 'z-noisy'])
  })

  it('缺承担者写「未分派」，不写空白', () => {
    const board = deriveThreadBoard([thread('t-1', { business_state: 'IN_REVIEW' })], { now: NOW })
    expect(column(board, 'deep-review').entries[0]!.owner).toBe('未分派')
  })
})
