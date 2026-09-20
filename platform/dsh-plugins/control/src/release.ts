/**
 * 动作放行闸（§24.5）：把控制面状态与「动作自身的风险事实」合成一个放行结论。
 *
 * # 这一层与 `gate.ts` 的分工
 *
 * `gate.ts` 回答的是**「会话能不能动」**——按状态给出 `allow / read-only / deny`。
 * 本文件回答的是它留下的那个更窄的问题：**会话处于只读档时，这一次副作用调用
 * 能不能不等人就放行。**
 *
 * 分开写而不是塞进 `gate.ts`，是因为判据来源不同：`gate.ts` 的表来自控制面的状态机，
 * 本文件的判据来自「动作是否可逆 / 是否跨 realm / 是否碰凭证」——把两组事实揉进一张表，
 * 就会变成「按了暂停，A 工具放行而 B 工具被拒」这种没人能解释的组合。
 *
 * # 为什么默认行为与接线前**逐字节一致**
 *
 * 分类器是**可选**的。没配分类器时 `classifierAvailable === false`，于是有副作用的调用
 * 落 `REVIEW` 而被拒——与接线前「只读档拒一切副作用工具」完全同一条分支。
 * 这条性质是刻意保住的：本层要能**在不改变任何既有行为的前提下先落地**，
 * 否则一次接线就同时改了安全策略与功能行为，出了问题分不清是哪一边。
 *
 * # 只收窄，不放宽
 *
 * 三处硬边界，各对应 §24.5 的一条不变量：
 *
 *   1. `deny` 档（aborted）**在分类之前就返回**——分类器没有机会对「已中止的会话」发问；
 *   2. `allow` 档（running）**根本不调用分类器**——不为了记录而制造一次判定；
 *   3. 只读工具永远放行，与分类器可用性无关。把只读也推进人审队列，正是文章批评的
 *      97% 批准率场景：**审批一旦退化成反射性点击，它就既不安全也不快**。
 */
import { classifyAction, type ReleaseBand, type ReleaseReason } from '../../../shared/seam-contracts/coordinator.ts'
import { controlGate, type ControlGate } from './gate.ts'

/**
 * 暂停态下一律视为有副作用的工具名前缀（外部写副作用；与 R2 幂等要求同源）。
 *
 * **这是本插件对此问题的唯一判据来源。** 接线前它内联在 `index.ts` 的挂点里；
 * 移到这里是因为现在有两个消费者（挂点与测试），内联会让「测试覆盖的名单」与
 * 「挂点执行的名单」可以漂移。
 */
export const SIDE_EFFECT_TOOL_PREFIXES: readonly string[] = [
  'bash', 'pwsh', 'write', 'edit', 'connector_', 'knowledge_publish',
]

/** 一个调用是否有副作用。前缀匹配——比工具名精确匹配更严（未列出的工具按无副作用处理是错的）。 */
export function isSideEffectTool(toolName: string): boolean {
  return SIDE_EFFECT_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix))
}

/**
 * 单个工具的风险事实。
 *
 * **缺省值是保守的**（不可逆 = 否、跨 realm = 否、碰凭证 = 否 → 即「普通可逆写」），
 * 因为这三项在 `classifyAction` 里都只能把动作推向更严的档：保守缺省等于
 * 「未申报的工具不比已申报的更危险」，而申报一个工具**只会让它更难被放行**。
 */
export interface ToolFacts {
  reversible: boolean
  touchesCredentials: boolean
  crossRealm: boolean
}

export const DEFAULT_TOOL_FACTS: ToolFacts = {
  reversible: true,
  touchesCredentials: false,
  crossRealm: false,
}

/**
 * 分类器。实现形态不在本切片拍板（§24 风险 R2：判定器是可替换件）——
 * 这里只固定它与闸门的**接口**：只能回答 allow / review，**没有 deny**。
 * 拒绝由事实与状态给出，不由判定器给出。
 */
export interface ReleaseClassifier {
  available(): boolean
  /** 判定一个工具调用。可能抛错——抛错按不可用处理，见 {@link toolRelease}。 */
  verdict(toolName: string): Promise<'allow' | 'review'> | 'allow' | 'review'
}

/** 一次工具调用的放行结论。 */
export interface ToolRelease {
  /** 放行即为 true。 */
  allow: boolean
  /** 分类档；`null` 表示本次**没有分类**（闸门本就放行 / 本就全拒 / 只读工具）。 */
  band: ReleaseBand | null
  /** 理由。`band` 为 null 时是闸门理由，否则是 {@link ReleaseReason}。 */
  reason: string
}

/**
 * 合成放行结论。**这是本层唯一写判据的地方**，挂点只消费它的输出。
 */
export async function toolRelease(
  state: string,
  toolName: string,
  classifier: ReleaseClassifier | undefined,
  facts: ToolFacts = DEFAULT_TOOL_FACTS,
): Promise<ToolRelease> {
  const gate: ControlGate = controlGate(state)

  // 不变量 2：running 档直接放行，不为记录而制造一次判定。
  if (gate === 'allow') return { allow: true, band: null, reason: 'state-running' }

  // 不变量 1：全拒档在分类之前返回——分类器没有机会对已中止的会话发问。
  if (gate === 'deny') return { allow: false, band: null, reason: `state-${state}` }

  // 只读工具：与分类器可用性无关（见文件头不变量 3）。
  if (!isSideEffectTool(toolName)) return { allow: true, band: null, reason: 'read-only-tool' }

  // 走到这里才是分类器的判定域：会话只读档 + 有副作用的工具。
  //
  // `available` 与 `verdict` 由同一次 try 得出，**两个都不在 try 之外预设**：
  // 抛错必须同时把可用性打成 false。只把 verdict 退回 'review' 而留着 available=true，
  // 会把一次故障报成 `classifier-review`（「分类器判定需要人审」）——那是一个**判定**，
  // 与「拿不到判定」是完全不同的事实，而现场看到前者只会去查工具。
  let available = false
  let verdict: 'allow' | 'review' = 'review'
  if (classifier) {
    try {
      available = classifier.available()
      if (available) verdict = await classifier.verdict(toolName)
    } catch {
      available = false
      verdict = 'review'
    }
  }

  const decision = classifyAction({
    sideEffect: true,
    reversible: facts.reversible,
    crossRealm: facts.crossRealm,
    touchesCredentials: facts.touchesCredentials,
    // OPA 在**控制指令**那一层已经裁决过，本层没有第二份裁决输入。这里传 true 不是说
    // 「OPA 放行了这个工具」，而是「本层不引入一个它拿不到的权威输入」——把拿不到的
    // 判定伪装成 true 是缺陷，伪装成 false 是另一种缺陷（一切皆拒）。真正的边界由
    // 状态与工具事实给出。
    opaAllowed: true,
    classifierAvailable: available,
    classifierVerdict: verdict,
  })

  return { allow: decision.band === 'AUTO', band: decision.band, reason: decision.reason }
}
