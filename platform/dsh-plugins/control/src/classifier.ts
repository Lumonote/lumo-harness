/**
 * §24.5 分类器的**一次落地**：命中前缀名单即 `allow`，其余一律 `review`。
 *
 * # 这是 §15「形态未拍板」那一项的一次落地，不是它的取消
 *
 * 设计文档 §6.3 的收尾与 §15 的显式外清单都写着同一句话：**判定器是可替换件**
 * （风险 R2）——三档闭集与三条不变量才是设计的内容。于是这里落地的是一份**明确不够聪明**
 * 的判定器：一张名单，没有学习、没有模型、没有第二个数据源。
 *
 * 这一形态是刻意的：在名单之外的判定上它不给任何保证，也**不假装自己给**。一个看起来
 * 更聪明的判定器（比如「按工具名猜风险」）会把「名单没覆盖到」这种缺口藏进一次 `allow`
 * 里，而名单缺口的正确表现是 `review`——多一次人审，不是少一次。
 *
 * # 换掉它不需要改闸门
 *
 * 闸门（`release.ts` 的 `toolRelease`）只认识 {@link ReleaseClassifier} 这个**接口**：
 * `available()` 与 `verdict()`，后者只回答 `allow` / `review`。因此换成 OPA 转发、
 * 换成模型判定、换成集群里另一个服务，都只需要在本文件之外再写一个实现，并在装配处
 * `ctx.provide('releaseClassifier', …)` 换掉——**闸门与它的用例一行都不用动**。
 * 本文件之所以不把名单写进 `release.ts`，就是为了让这条性质在文件边界上看得见。
 *
 * # 三条硬边界（§24.5 的三条不变量，逐条对应）
 *
 *   1. **只收窄，不放宽。** 判定器没有 `deny`（接口层面就没有），也**不能翻 OPA 的否**：
 *      在 `classifyAction` 里 OPA 那条规则排在最前，判定器的结论根本到不了那里。
 *   2. **不改变既有行为。** 本模块**不被默认装配**：没配就 `ctx.provide` 不出去，
 *      闸门走它的 fail-closed 分支（只读档下副作用工具一律人审），与接线前逐字节一致。
 *      装配它，是一次**显式**的取舍：承认名单内的动作可以不等人的。
 *   3. **不可用即 fail-closed。** 名单是静态的，所以 `available()` 恒 true；真正的
 *      故障面是「抛错」（装配坏了、服务查找炸了），而 `toolRelease` 用同一次 try 兜住
 *      它并把可用性打成 false——理由见那边的注释：故障与判定必须是两个理由。
 */
import type { ReleaseClassifier } from './release.ts'

/**
 * 分类器的装配参数：一张**已知「可逆、同 realm、不碰凭证」**的副作用工具前缀名单。
 *
 * 是前缀而不是精确工具名：工具名在 dsh 里带命名空间与后缀（`connector_github`、
 * `knowledge_publish`），逐名枚举既列不全也随时会过期；而前缀多匹配的那一侧是**安全侧**
 * （多要一次人审，不会漏放）。与 `release.ts` 的 `isSideEffectTool` 同一条判据。
 */
export interface ClassifierRules {
  allowPrefixes: readonly string[]
}

/**
 * 名单判据本身（纯函数）。**判定只此一处**，类与测试都消费它的输出。
 *
 * 未命中即 `review`：拿不准就进人审队列，这与人审的代价不对称是同一条判据
 * （§16 风险 R2：放行一个不该放行的动作，代价远大于拒绝一个本该放行的动作）。
 */
export function classifyByAllowlist(
  toolName: string,
  allowPrefixes: readonly string[],
): 'allow' | 'review' {
  return allowPrefixes.some(prefix => toolName.startsWith(prefix)) ? 'allow' : 'review'
}

/**
 * 前缀名单判定器。**可替换件的一个实现**，不是唯一实现。
 *
 * 构造时就校验名单，理由是这两类名单错误都会**静默放宽**（比静默收紧危险得多）：
 *
 *   - **空名单**：一个永远说 `review` 的分类器毫无用处，却让现场看到的是
 *     `classifier-review`（一个判定）而不是 `classifier-unavailable`（一次故障）——
 *     排查方向被引到工具上，而真正的问题在配置。宁可在装配时就炸掉。
 *   - **空前缀**：`''.startsWith` 对任何工具名都成立，于是名单里一个手滑的空串
 *     就放行了**全部**副作用工具。这是本文件里唯一能造成「放宽」的输入形状。
 */
export class AllowlistClassifier implements ReleaseClassifier {
  private readonly prefixes: readonly string[]

  constructor(rules: ClassifierRules) {
    if (rules.allowPrefixes.length === 0) {
      throw new Error(
        'lumo/control: 分类器名单为空——空名单只会回答 review，' +
        '却把「拿不到判定」伪装成「判定为需要人审」。要么给出名单，要么别装配分类器。',
      )
    }
    const blank = rules.allowPrefixes.filter(prefix => prefix.trim() === '')
    if (blank.length > 0) {
      throw new Error(
        'lumo/control: 分类器名单里有空前缀——空前缀匹配一切工具名，会静默放行全部副作用工具',
      )
    }
    this.prefixes = [...rules.allowPrefixes]
  }

  /**
   * 恒 true：名单是静态的，能构造出来就一定能判。
   *
   * 这个返回值不是「我很好」的声明，而是「**没有**拿不到判定的情形」——故障面（抛错）
   * 由闸门统一归到 `classifier-unavailable`，见文件头第 3 条。
   */
  available(): boolean {
    return true
  }

  verdict(toolName: string): 'allow' | 'review' {
    return classifyByAllowlist(toolName, this.prefixes)
  }
}

/**
 * 装配判据：**没配就没有分类器**。
 *
 * 这一个函数就是「默认装配下不改变既有行为」的全部实现——它返回 `undefined` 时，
 * 调用方不 `provide`，于是 `ctx.get('releaseClassifier')` 是 `undefined`，
 * 闸门走 fail-closed 分支。把它单独写出来（而不是内联在 `apply` 里）是为了让这条性质
 * 可被测试直接钉住：判据在纯函数里，装配只做接线。
 */
export function releaseClassifierOf(rules: ClassifierRules | undefined): ReleaseClassifier | undefined {
  return rules === undefined ? undefined : new AllowlistClassifier(rules)
}
