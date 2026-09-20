import { describe, expect, it } from 'vitest'

import { acceptanceVerdict, hasAcceptance } from '../src/acceptance.ts'
import type { TeamTask } from '../src/model.ts'

/** 一条待验收的任务。判定只读 `acceptance`，其余字段给它一个合法形状。 */
function task(acceptance?: string): TeamTask {
  return {
    id: 't1',
    subject: '交付一份基准',
    ...acceptance === undefined ? {} : { acceptance },
    status: 'completed',
    dependencies: [],
    attempt: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

const EVIDENCE = ['session/1#42']

describe('验收判据（§24.1）', () => {
  it('有验收条件且有证据才通过', () => {
    expect(acceptanceVerdict(task('三条基准数据，误差 <1%'), EVIDENCE)).toEqual({ accept: true })
  })

  it('没有验收条件即拒收，且理由归到派发方', () => {
    // 缺省、空串、空白串三种写法都是「没有验收条件」：它们在数据上分不开，
    // 而一个只有空格的验收条件判不出任何东西 —— 判据宁可空转，也不给假通过。
    for (const missing of [undefined, '', '   ']) {
      expect(acceptanceVerdict(task(missing), EVIDENCE))
        .toEqual({ accept: false, reason: 'no-criteria' })
    }
  })

  it('没有可用证据即拒收：空数组与整条空白都不算证据', () => {
    for (const empty of [[], [''], ['  '], ['', '   ']]) {
      expect(acceptanceVerdict(task('验收条件'), empty))
        .toEqual({ accept: false, reason: 'no-evidence' })
    }
  })

  it('一条非空白证据足够；空洞的条目被跳过而不是把整段判成无证据', () => {
    expect(acceptanceVerdict(task('验收条件'), ['', '   ', 'session/2#7'])).toEqual({ accept: true })
  })

  it('两条都缺时先判 no-criteria —— 顺序即归因', () => {
    // 责任方不同：没写验收条件是**派发方**的缺陷，没交证据是**执行方**的缺陷。
    // 顺序反过来，一个没写验收条件的派发会被记成「成员没交证据」：
    // 现场会去追问成员，而要修的是派发路径。所以先判前者。
    expect(acceptanceVerdict(task(), [])).toEqual({ accept: false, reason: 'no-criteria' })
    // 判据不看输出措辞：同样的空证据，配上验收条件才轮到 no-evidence。
    expect(acceptanceVerdict(task('验收条件'), [])).toEqual({ accept: false, reason: 'no-evidence' })
  })

  it('取不到证据（不是数组）按没有证据处理，不抛', () => {
    // 证据是外部送进来的，不是本模块构造的：形态未知时 fail-closed，而不是让
    // 一次脏输入把验收路径整个炸掉 —— 拒收是可解释的，抛错不是。
    expect(acceptanceVerdict(task('验收条件'), undefined as unknown as readonly string[]))
      .toEqual({ accept: false, reason: 'no-evidence' })
  })

  it('理由只有两种，可被调用方直接聚合', () => {
    const verdicts = [task(), task('条件')].flatMap((t, index) => [
      acceptanceVerdict(t, []),
      acceptanceVerdict(t, index === 0 ? [] : EVIDENCE),
    ])
    const rejects = verdicts.filter(verdict => !verdict.accept).map(verdict => verdict.reason)
    expect(new Set(rejects)).toEqual(new Set(['no-criteria', 'no-evidence']))
  })
})

/**
 * `hasAcceptance` 是「这条任务有没有有效验收条件」的**唯一口径**，有两个消费者：
 * 收活判据（`acceptanceVerdict`）与派发 prompt（`buildMemberPrompt`）。
 *
 * 这组用例钉的是**两者一致**。它们各自单测都绿、合起来自相矛盾，是这类双消费者判据
 * 最典型的失效形状：prompt 把验收条件印给了成员，收活时却判 `no-criteria`。
 */
describe('hasAcceptance 与 acceptanceVerdict 同口径', () => {
  it('空白串两侧都算「没有」', () => {
    for (const value of ['', '   ', '\t', '\n ']) {
      expect(hasAcceptance(task(value))).toBe(false)
      expect(acceptanceVerdict(task(value), EVIDENCE)).toEqual({ accept: false, reason: 'no-criteria' })
    }
  })

  it('有内容的串两侧都算「有」', () => {
    for (const value of ['条件', ' 条件 ', 'a']) {
      expect(hasAcceptance(task(value))).toBe(true)
      // 有验收条件 + 有证据 = 通过。这一条正是「两侧一致」的落点：
      // 只要 hasAcceptance 与 acceptanceVerdict 对同一输入分叉，这里必红。
      expect(acceptanceVerdict(task(value), EVIDENCE)).toEqual({ accept: true })
    }
  })

  it('缺省字段两侧都算「没有」', () => {
    expect(hasAcceptance(task())).toBe(false)
    expect(acceptanceVerdict(task(), EVIDENCE)).toEqual({ accept: false, reason: 'no-criteria' })
  })
})
