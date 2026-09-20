import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DENIED_STREAK_LIMIT,
  DENIED_TOTAL_LIMIT,
  classifyAction,
  fallbackVerdict,
  type ActionFacts,
} from '../coordinator.ts'

/**
 * §14 判据 12「契约双实现」的**实质**：跨语言同矩阵对照。
 *
 * # 为什么需要这份数据文件
 *
 * `classifyAction` 与 `fallbackVerdict` 在两种语言里各有一份实现（TS 权威 +
 * `control-plane/session-control/internal/release/classify.go`）。两份实现的字面量可以
 * 完全一致而**行为**仍然分叉——顺序、`>=` 与 `>`、`undefined` 与空串，任何一处都足以
 * 让同一个输入在两侧得到不同的档位，而症状是「Go 判放行、插件判人审」这种现场无法解释
 * 的组合。逐行读过两侧的代码不算证据：读的是**这一次**的一致性，不是**可回归的**一致性。
 *
 * # 机制：一份由 TS 生成、被 Go 消费的真值文件
 *
 *   1. 本文件用 TS 权威实现算出**整个输入域**上的结论，写成
 *      `__tests__/fixtures/release-matrix.json`（矩阵里带输入、也带 TS 的期望结论）；
 *   2. 本文件的用例断言**磁盘上那份与现场算出来的逐字节相同**——所以提交过的矩阵
 *      永远不会是陈旧的，改一条规则就必须重新生成；
 *   3. Go 侧 `release/classify_test.go` 读**同一个文件**，逐行跑 Go 实现并断言同值，
 *      同时断言这份矩阵覆盖了整个输入域（6 个布尔 × 3 种判定 = 192 行，一行不缺）。
 *
 * 于是「加一条规则」无法只改一侧：
 *
 *   - 只改 TS → 本文件的断言红（矩阵没重新生成）；若重新生成而不改 Go，则 Go 侧红；
 *   - 只改 Go → Go 侧红（与矩阵不一致）。
 *
 * # 为什么是这个方向（TS 生成、Go 消费）
 *
 * 权威判据在 TS（§12），矩阵的**期望值**因此只能由 TS 产生——让 Go 生成一份期望值，
 * 对照就退化成「Go 与自己一致」。反过来，**输入矩阵**由 TS 穷举即可，Go 不需要再实现
 * 一遍生成器：它读到的输入就是 TS 跑过的输入，两侧不存在「各自生成、各自漂移」的空间。
 *
 * # 重新生成
 *
 * ```sh
 * cd platform && UPDATE_RELEASE_MATRIX=1 npx vitest run shared/seam-contracts/__tests__/release-matrix.spec.ts
 * ```
 *
 * 生成之后必须**同时**跑一遍 Go 侧（`go test ./internal/release/`）——只更新矩阵而不改
 * Go 实现，正是这条对照要挡住的那件事。
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, 'fixtures/release-matrix.json')

/** 三种「分类器说了什么」：allow / review / 没说话（缺省）。 */
const VERDICTS = [undefined, 'allow', 'review'] as const

/** 矩阵的一行：输入与 TS 的期望结论并排，Go 侧照这一行复算。 */
interface ClassifyRow {
  facts: {
    sideEffect: boolean
    reversible: boolean
    crossRealm: boolean
    touchesCredentials: boolean
    opaAllowed: boolean
    classifierAvailable: boolean
    classifierVerdict: 'allow' | 'review' | null
  }
  band: string
  reason: string
}

/**
 * 穷举 `classifyAction` 的**全部**输入域：6 个布尔 × 3 种判定 = 192 行。
 *
 * 全组合而不是抽样：抽样矩阵只能证明两侧在抽到的那几行上一致，而规则是**有序**的——
 * 一条新规则插在中间时，变的是「哪一条先命中」，那恰好是抽样最容易漏掉的性质。
 * 穷举则不存在漏掉的可能（这个函数的定义域就是有限的 192 个点）。
 *
 * `mask` 的位序与 `facts` 里各字段的书写顺序一致，`classifierVerdict: null` 表示缺省——
 * 它是 Go 侧解码后 `ClassifierVerdict` 的零值，两侧对「没说话」的理解由这一列对齐。
 */
function classifyRows(): ClassifyRow[] {
  const rows: ClassifyRow[] = []
  for (let mask = 0; mask < 1 << 6; mask += 1) {
    const bits = {
      sideEffect: (mask & 1) !== 0,
      reversible: (mask & 2) !== 0,
      crossRealm: (mask & 4) !== 0,
      touchesCredentials: (mask & 8) !== 0,
      opaAllowed: (mask & 16) !== 0,
      classifierAvailable: (mask & 32) !== 0,
    }
    for (const verdict of VERDICTS) {
      const facts: ActionFacts = verdict === undefined ? bits : { ...bits, classifierVerdict: verdict }
      const decision = classifyAction(facts)
      // 逐字段显式书写（不用展开运算符）：JSON 的键序由这里决定，而字节级比较
      // （第 2 步的断言）要求同一份输入永远序列化成同一串字节。
      rows.push({
        facts: {
          sideEffect: bits.sideEffect,
          reversible: bits.reversible,
          crossRealm: bits.crossRealm,
          touchesCredentials: bits.touchesCredentials,
          opaAllowed: bits.opaAllowed,
          classifierAvailable: bits.classifierAvailable,
          classifierVerdict: verdict ?? null,
        },
        band: decision.band,
        reason: decision.reason,
      })
    }
  }
  return rows
}

/** 兜底矩阵的一行。`error` 为真表示两侧都必须**拒绝**这条输入（负数计数）。 */
interface FallbackRow {
  deniedStreak: number
  deniedTotal: number
  verdict: string | null
  error: boolean
}

/**
 * 兜底判据的矩阵：两个计数的**阈值两侧**各取一格。
 *
 * 与分类器矩阵不同，这里的定义域是无限的（任意非负整数对），所以取的是「行为可能变化
 * 的全部位置」：0 / 1 / 阈值-1 / 阈值 / 阈值+1 的叉积。回落判据是两个 `>=` 的或，
 * 任何阈值或比较符的改动都会在这些格子上现形。
 */
function fallbackRows(): FallbackRow[] {
  const streaks = [0, 1, DENIED_STREAK_LIMIT - 1, DENIED_STREAK_LIMIT, DENIED_STREAK_LIMIT + 1]
  const totals = [0, 1, DENIED_TOTAL_LIMIT - 1, DENIED_TOTAL_LIMIT, DENIED_TOTAL_LIMIT + 1]
  const rows: FallbackRow[] = []
  for (const deniedStreak of streaks) {
    for (const deniedTotal of totals) {
      rows.push({ deniedStreak, deniedTotal, verdict: fallbackVerdict({ deniedStreak, deniedTotal }), error: false })
    }
  }
  // 负数：TS 侧 throw、Go 侧返回 ErrInvalid。两侧的**拒绝**本身也要对照——
  // 「一边拒、一边静默当成 0」是最危险的分叉（另一边会永远不回落），
  // 而它恰好不会在任何一条正常输入上暴露出来。
  for (const [deniedStreak, deniedTotal] of [[-1, 0], [0, -1], [-1, -1]] as const) {
    rows.push({ deniedStreak, deniedTotal, verdict: null, error: true })
  }
  return rows
}

/** 矩阵文件的完整内容。`source` 让读它的人（与 Go 侧用例）知道该去哪里改。 */
function buildMatrix(): object {
  return {
    source: 'platform/shared/seam-contracts/__tests__/release-matrix.spec.ts',
    note:
      '由 TS 权威实现生成、供 Go 双实现逐行对照（§14 判据 12）。不要手工编辑：'
      + '用 UPDATE_RELEASE_MATRIX=1 重新生成。',
    classify: classifyRows(),
    fallback: fallbackRows(),
  }
}

/** 唯一的序列化入口：缩进 2 空格 + 结尾换行，保证磁盘内容与现场计算可比。 */
function serialize(matrix: object): string {
  return `${JSON.stringify(matrix, null, 2)}\n`
}

describe('§14 判据 12 —— Go/TS 同矩阵对照的真值文件', () => {
  it('矩阵覆盖整个输入域（6 布尔 × 3 判定 = 192 行），不是抽样', () => {
    // 生成器自身的完整性检查：矩阵缩水时这条先红，省得「两侧一致」变成
    // 「两侧都没跑几行」——后者在退出码上和前者完全一样。
    expect(classifyRows()).toHaveLength(2 ** 6 * VERDICTS.length)
    expect(classifyRows().length).toBe(192)
    expect(fallbackRows().length).toBeGreaterThanOrEqual(25)
  })

  it('矩阵里的档位与理由都在闭集内（自由文本会让对照失去意义）', () => {
    // 闭集逐个列出而不是用正则近似：这条用例同时是「理由闭集没有被悄悄加值」的守卫——
    // 加一个值必须动这里，而动这里的人会读到下面那段「Go 侧也要加」的提示。
    const reasons = [
      'opa-denied', 'cross-realm', 'credentials', 'irreversible',
      'read-only', 'classifier-unavailable', 'classifier-review', 'classifier-allow',
    ]
    for (const row of classifyRows()) {
      expect(['AUTO', 'REVIEW', 'DENY']).toContain(row.band)
      expect(
        reasons,
        `理由 ${row.reason} 不在闭集内。加值必须两侧同步：`
          + `Go 侧 internal/release/classify.go 的 ReleaseReason 也要加同名同值的常量。`,
      ).toContain(row.reason)
    }
  })

  it('磁盘上的矩阵与现场算出的逐字节相同 —— 改一条规则必须先重新生成它', () => {
    const generated = serialize(buildMatrix())
    const update = process.env['UPDATE_RELEASE_MATRIX'] === '1'

    if (update) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, generated, 'utf8')
      // eslint-disable-next-line no-console
      console.warn(
        `已重新生成 ${FIXTURE}。别忘了跑一遍 Go 侧对照：`
        + `cd platform/control-plane/session-control && go test ./internal/release/`,
      )
    }

    expect(
      existsSync(FIXTURE),
      `${FIXTURE} 不存在。它是跨语言对照的唯一真值源，缺失时 Go 侧无从对照。` +
        `生成：UPDATE_RELEASE_MATRIX=1 npx vitest run shared/seam-contracts/__tests__/release-matrix.spec.ts`,
    ).toBe(true)

    expect(
      readFileSync(FIXTURE, 'utf8'),
      '矩阵与当前 TS 实现不一致：要么改动没同步到矩阵，要么矩阵被手工改过。' +
        '用 UPDATE_RELEASE_MATRIX=1 重新生成，并**同时**跑 Go 侧对照。',
    ).toBe(generated)
  })
})
