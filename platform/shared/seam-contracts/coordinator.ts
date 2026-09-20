/**
 * §24 集群模式多智能体协同的**判据源**：动作放行三档、兜底回落、组合验证、异构审查。
 *
 * # 为什么这四组判据住在一起，而且是纯函数
 *
 * 它们回答的是同一个问题的四个切面——**「这件事该不该在无人确认的情况下往下走」**：
 * 单个动作（{@link classifyAction}）、一个会话的连续被拒（{@link fallbackVerdict}）、
 * 一批产出物（{@link integrationVerdict}）、一个审查者（{@link reviewerEligibility}）。
 * 散在四个挂点里会漂移；`control/src/gate.ts` 已经为这件事付过一次学费
 * （「它是这一层唯一的判据来源，挂点只消费它的输出」）。
 *
 * 纯函数、零 dsh 依赖，另有一个当下就成立的理由：它们能在 `environment: 'node'` 下
 * 直接被测试覆盖，不必把整个 cordis 装配拉起来。
 *
 * # 三条不变量（§24.5，全部偏向拒绝侧）
 *
 * 1. **分类器只收窄，不放宽。** `opaAllowed === false` 时无论分类器怎么判，恒 `DENY`。
 *    OPA 是权威裁决（`control/src/policy.ts` 的 `OpaControlPolicy` 已写明「中心策略只能
 *    收窄本地授权」），分类器再插一层放宽就等于给权威裁决开后门。
 * 2. **拿不到判定时绝不自动放行。** 分类器不可用时，**有副作用**的动作最多到 `REVIEW`。
 *    与 `OpaControlPolicy` 的「`result` 缺失不能当成 `allow=false`… 但更不能当成放行」
 *    同一条判据。
 * 3. **不可逆的动作不进入「谁来判」的问题。** 它直接 `DENY`——不可逆动作没有「判错了再改」
 *    这个选项，因此不交给任何判定器，包括分类器。**这一条比文章更严**：文章允许分类器
 *    拦截「不可逆、破坏性」的动作，本模块把不可逆从判定域里直接摘出去。理由是可测性：
 *    「分类器会不会放行一个不可逆动作」是一条无法在单元测试里穷尽的命题，而
 *    「不可逆动作恒 DENY」是一条可枚举的命题。
 *
 * # 只读动作与分类器无关（一个容易被写错的边界）
 *
 * `sideEffect === false` 时恒 `AUTO`，**不因为分类器不可用而降档**。理由不是「只读安全」，
 * 而是经济学：把只读动作也推进人审队列，正是文章批评的那个 97% 批准率场景——
 * **审批一旦退化成反射性点击，它就既不安全也不快**。分类器的职责边界是**副作用动作**，
 * 这条边界写在这里，而不是留给挂点各自解释。
 */
import { invalid } from './errors.ts'

/**
 * 动作放行三档（§24.5）。
 *
 * 三档而不是布尔，与 `control/src/gate.ts` 的 `ControlGate` 同理：`REFUSE` 与
 * `只拒副作用` 对操作者的意义不同。这里的第三档是「进人审队列」而不是「拒绝」——
 * `DENY` 才是拒绝。
 */
export type ReleaseBand = 'AUTO' | 'REVIEW' | 'DENY'

/** 分档理由。闭集，且要写进审计行——自由文本会让这个字段失去聚合能力。 */
export type ReleaseReason =
  | 'opa-denied'
  | 'cross-realm'
  | 'credentials'
  | 'irreversible'
  | 'read-only'
  | 'classifier-unavailable'
  | 'classifier-review'
  | 'classifier-allow'

export interface ActionFacts {
  /** 工具的副作用判定。由工具档案给出，不由名字猜——`bash` 可以是只读的，`connector_x` 也可能只读。 */
  sideEffect: boolean
  /** 动作可逆（可回滚 / 可撤销）。不可逆直接 `DENY`，见文件头不变量 3。 */
  reversible: boolean
  /** 跨 realm。realm 是租户边界，跨出去就不是本项目能自行决定的事。 */
  crossRealm: boolean
  /** 触达凭证（Vault 内的值，§10）。凭证不出边界的既有义务。 */
  touchesCredentials: boolean
  /** OPA 的裁决。`false` 即终局。 */
  opaAllowed: boolean
  /** 分类器是否可用。不可用即 fail-closed（不变量 2）。 */
  classifierAvailable: boolean
  /**
   * 分类器的判定。**只能是 `allow` / `review`，没有 `deny`**——
   * 拒绝由事实（不可逆 / 跨 realm / 凭证）与 OPA 给出，不由判定器给出。
   * 分类器不可用时忽略此字段。
   */
  classifierVerdict?: 'allow' | 'review'
}

export interface ReleaseDecision {
  band: ReleaseBand
  reason: ReleaseReason
}

/**
 * 判定一个动作的放行档。
 *
 * 规则**有序**，先命中先返回；顺序本身就是优先级，不要重排。每一条都对应下面
 * 「为什么是这个顺序」的一段理由。
 */
export function classifyAction(facts: ActionFacts): ReleaseDecision {
  // 1. OPA 判否即否。**必须是第一条**：它在语义上是终局的，排在任何「技术性」判定
  //    之前，才能保证后面所有分支都不可能覆盖它。
  if (!facts.opaAllowed) return { band: 'DENY', reason: 'opa-denied' }

  // 2 / 3. 租户边界与凭证边界。排在分类器之前，理由同 1：分类器不该有机会对
  //        「跨租户」「碰凭证」这两类发问。
  if (facts.crossRealm) return { band: 'DENY', reason: 'cross-realm' }
  if (facts.touchesCredentials) return { band: 'DENY', reason: 'credentials' }

  // 4. 不可逆：摘下判定域（不变量 3）。注意它排在只读之前——一个既不可逆又无副作用的
  //    动作在概念上不成立，但真出现时按更严的那条走。
  if (!facts.reversible) return { band: 'DENY', reason: 'irreversible' }

  // 5. 只读：恒 AUTO，与分类器可用性无关（见文件头最后一段）。
  if (!facts.sideEffect) return { band: 'AUTO', reason: 'read-only' }

  // 6. 到此只剩「有副作用、可逆、同 realm、不碰凭证」的动作——**这才是分类器的判定域**。
  if (!facts.classifierAvailable) return { band: 'REVIEW', reason: 'classifier-unavailable' }

  // 7. 分类器只说 allow / review；没说话（undefined）按 review 处理——
  //    「没意见」不等于「同意」。
  return facts.classifierVerdict === 'allow'
    ? { band: 'AUTO', reason: 'classifier-allow' }
    : { band: 'REVIEW', reason: 'classifier-review' }
}

/** 连续被拒达到此数即回落（§24.5 第 3 条）。 */
export const DENIED_STREAK_LIMIT = 3
/** 单 Run 累计被拒达到此数即回落（§24.5 第 3 条）。 */
export const DENIED_TOTAL_LIMIT = 20

export type FallbackVerdict = 'keep' | 'fallback-to-manual'

/**
 * 兜底防自旋：判定器连续被拒到阈值就整体回落人工档。
 *
 * **为什么这条必须有**：没有它，分类器的误判会变成「被拒 → agent 换个说法重试 → 再被拒」
 * 的无限循环，而循环的表现是「任务还在跑」而不是「任务失败了」——监控上看不出异常。
 * 与 §8.1 那条「每个等待强制带 TTL，没有『永远等下去』这个选项」是同一类保护。
 *
 * 两个计数**任一**达标即回落。两个都要，因为它们捕获不同的形状：连续的表示卡在同一个
 * 动作上，累计的表示在广泛地撞墙——后者的单次间隔里插着成功，连续计数会归零。
 */
export function fallbackVerdict(input: {
  deniedStreak: number
  deniedTotal: number
}): FallbackVerdict {
  const streak = counter('deniedStreak', input.deniedStreak)
  const total = counter('deniedTotal', input.deniedTotal)
  return streak >= DENIED_STREAK_LIMIT || total >= DENIED_TOTAL_LIMIT
    ? 'fallback-to-manual'
    : 'keep'
}

/**
 * 计数必须是**非负安全整数**。
 *
 * 负数或小数不是「边界情况」，是调用方把别的字段传错了。放行它等于让兜底静默失效：
 * `NaN >= 3` 是 false，于是永远不回落。与 `subagent-host.ts` 对 childDepth 的判据同训。
 */
function counter(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`coordinator: ${name} 必须是非负安全整数，收到 ${String(value)}`)
  }
  return value
}

export type IntegrationVerdict = 'pass' | 'reject-batch'

/**
 * 组合验证闸门（§24.7）：批级判定，**不是**逐 Run 判定。
 *
 * 文章的核心警告是「每条线程的局部正确性不保证组合正确性」——各自 CI 全绿，合起来
 * 跑不起来，且冲突是**滞后的**。因此这道闸门必须在**批次**上问一次，而不是在单个 Run 上
 * 问 N 次：逐个打回会让协调者陷入「A 改好、B 又坏」的循环，永远收敛不了。
 *
 * 返回 `reject-batch` 时调用方把业务态整体回退（§23.3 已有的 `IN_REVIEW → ROUTING`），
 * **不产生逐 Run 打回**。
 */
export function integrationVerdict(input: {
  contractTestsPass: boolean
  smokePass: boolean
}): IntegrationVerdict {
  return input.contractTestsPass && input.smokePass ? 'pass' : 'reject-batch'
}

/** 达到此产出物数即要求**模型级**异构，仅「换了节点」不算（§24.8）。 */
export const HIGH_IMPACT_ARTIFACTS = 3

export type ReviewerEligibility =
  | { eligible: true }
  | { eligible: false; reason: ReviewerIneligibility }

export type ReviewerIneligibility =
  | 'self-review'
  | 'homogeneous'
  | 'high-impact-needs-model-diversity'
  | 'invalid-input'

export interface ReviewerFacts {
  /** 派发该 Run 的主体（协调者 / agent 标识）。 */
  dispatcher: string
  /** 候选审查者。 */
  reviewer: string
  /** 三组可证异构的维度，全部可选——缺省不视为「不同」。 */
  dispatcherPreset?: string
  reviewerPreset?: string
  dispatcherModel?: string
  reviewerModel?: string
  dispatcherNode?: string
  reviewerNode?: string
  /** 本批受影响的产出物数。 */
  affectedArtifacts: number
}

/**
 * 异构审查者（§24.8）。
 *
 * 文章的判断是原则性的：**同源审查无法发现同源盲区**，不是调参能解决的。Anthropic 的
 * 对抗机制（单会话 Verification Agent、多代理 implementer-reviewer、项目级 PR + 人审）
 * 三处都是同源模型做的审查。Lumo 不重复那个错误——但也不新建机制：
 * `control-plane/flows` 的 FlowReview 早有同型的职责分离（「审核人不得是作者」），
 * 本函数把它从流程扩展到 Run，并且多加一条文章给的经验阈值。
 *
 * **缺省即同源**：某一维度两侧都没给值时，**不认为它们不同**。这与
 * `remotability.ts` 的「未定级 = 拒绝」同一条纪律——判不出差别时按没差别处理，
 * 而「没差别」在这里是拒绝侧。
 */
export function reviewerEligibility(facts: ReviewerFacts): ReviewerEligibility {
  if (!Number.isSafeInteger(facts.affectedArtifacts) || facts.affectedArtifacts < 0) {
    return { eligible: false, reason: 'invalid-input' }
  }

  // 1. 派发者不验收自己的活。这一条与异构无关，是职责分离本身。
  if (facts.dispatcher === facts.reviewer) {
    return { eligible: false, reason: 'self-review' }
  }

  const differs = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a !== b
  const presetDiffers = differs(facts.dispatcherPreset, facts.reviewerPreset)
  const modelDiffers = differs(facts.dispatcherModel, facts.reviewerModel)
  const nodeDiffers = differs(facts.dispatcherNode, facts.reviewerNode)

  // 2. 三个维度都不可证不同 → 同源。判不出来不等于判为合格。
  if (!presetDiffers && !modelDiffers && !nodeDiffers) {
    return { eligible: false, reason: 'homogeneous' }
  }

  // 3. 影响面大时，「换了个节点」不构成多样性——同一份权重、同一套盲区在两台机器上
  //    跑出来的判断是一样的。只有模型（或等价物：preset）不同才算。
  if (facts.affectedArtifacts >= HIGH_IMPACT_ARTIFACTS && !modelDiffers && !presetDiffers) {
    return { eligible: false, reason: 'high-impact-needs-model-diversity' }
  }

  return { eligible: true }
}
