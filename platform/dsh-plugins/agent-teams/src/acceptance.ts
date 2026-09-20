/**
 * 验收判据 —— §24.1「协调者必须自己持有验收判据」的落点。
 *
 * ## 为什么判据单独成模块、且是纯函数
 *
 * 「这条任务能不能验收」只有**一个**判据来源。若把它摊进派发、写回、汇总三处，
 * 三处迟早漂移成三种口径 —— 而验收恰恰是最不能有第二种口径的地方（同一个交付，
 * `status` 说通过、汇总说没通过，现场无从判断谁对）。与 `shared/seam-contracts/
 * coordinator.ts` 同训：挂点只消费纯函数的输出。
 *
 * 附带的好处是它能在 `environment: 'node'` 下直接单测，不必把整个装配拉起来。
 *
 * ## 与 §23.4 / §24.8 的关系
 *
 * 证据就是六段式 `report` 的 `evidence[]`。§24.8 的「同源审查发现不了同源盲区」
 * 之所以成立，前提是**报告自带证据** —— 少了它，验收就只剩评判作者的措辞，
 * 那正是 rubber-stamp 的入口。所以没有证据一律拒收，不看输出写得多漂亮。
 */

import type { TeamTask } from './model.ts'

/**
 * 验收结论。
 *
 * `reason` 是**闭集**而不是自由文本：调用方要能按理由聚合（「多少条派发根本没写
 * 验收条件」是一个必须算得出来的数）。理由一旦是自由文本，聚合就只能靠字符串
 * 匹配，等于没有。同 `coordinator.ts` 的 `ReleaseReason`。
 */
export type AcceptanceVerdict =
  | { accept: true }
  | { accept: false; reason: 'no-criteria' | 'no-evidence' }

/**
 * 判定一条任务能否被验收。
 *
 * 规则**先命中先返回**，顺序即优先级，不要重排：
 *
 * 1. 任务没有验收条件 → `no-criteria`
 * 2. 报告没有可用证据 → `no-evidence`
 * 3. 否则通过
 *
 * ### 为什么 `no-criteria` 排在 `no-evidence` 前面
 *
 * 两条的**责任方不同**：前者是派发方的缺陷（协调者没写死验收条件），后者是执行方的
 * 缺陷（成员没交证据）。若让证据先判，一个没写验收条件的派发会被记成「成员没交
 * 证据」—— 现场会去追问成员，而真正要修的是派发路径。**顺序即归因。**
 *
 * ### 两条从严的判法
 *
 * - **空白串按缺省算**（`''` 与 `'   '`）。两者在数据上分不开，而一个只有空格的
 *   验收条件判不出任何东西 —— 判据宁可空转（拒收），也不给一个「看起来通过」的假结论。
 * - **证据只要有一条非空白就算有**，空白条目被跳过而不是把整段判成无证据：
 *   证据是外部送进来的，多一条空的（拼接产生的空行）不该把一次真有证据的报告否掉。
 *   反过来，一条非空白的都没有（`[]` / `['']`）就是没有 —— `['']` 不是证据。
 *
 * 取不到证据（不是数组）按「没有证据」处理：fail-closed，与全模块同训。
 */
export function acceptanceVerdict(task: TeamTask, evidence: readonly string[]): AcceptanceVerdict {
  if (!hasAcceptance(task)) {
    return { accept: false, reason: 'no-criteria' }
  }
  if (!hasEvidence(evidence)) {
    return { accept: false, reason: 'no-evidence' }
  }
  return { accept: true }
}

/**
 * 这条任务有没有**有效**的验收条件。空白串按缺省算，理由见上。
 *
 * 导出而不是留在模块内，是因为它有两个消费者：收活时的判据（{@link acceptanceVerdict}）
 * 与派发时的 prompt 构造（`service.ts` 的 `buildMemberPrompt`）。**两处必须用同一个
 * 口径**——否则会出现「prompt 里把验收条件印给了成员，收活时却判它没有验收条件」
 * 这种自相矛盾的现场，而两边各自的测试都是绿的。
 */
export function hasAcceptance(task: TeamTask): boolean {
  return task.acceptance !== undefined && task.acceptance.trim() !== ''
}

/** 至少一条非空白证据才算有证据。`['']` 不是证据，`[' ', 'ok']` 是。 */
function hasEvidence(evidence: readonly string[]): boolean {
  return Array.isArray(evidence)
    && evidence.some(entry => typeof entry === 'string' && entry.trim() !== '')
}
