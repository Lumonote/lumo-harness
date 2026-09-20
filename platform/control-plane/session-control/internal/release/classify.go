package release

import "fmt"

// 动作放行三档的**判定**（§24.5）：`ClassifyAction` 与 `FallbackVerdict`。
//
// # 它与 release.go 的关系
//
// release.go 是这条判定的**落库形态**（闭集词表 + 写入校验）；本文件是它的**上游**——
// 「这一次工具调用该判 AUTO / REVIEW / DENY」的判据本身。两者同包，因为它们共用同一套
// 词表：`Band` 三档与 `ReleaseReason` 八值。若分成两个包，「判定出来的档位」与「落库的
// 档位」就会成为两个可以各自演化的类型——而它们必须是同一个概念。
//
// 本文件**不**复制 `Band`：档位闭集只有一处（release.go 的 `BandAuto/BandReview/BandDeny`），
// 判定函数直接返回它。加第二份 `ReleaseBand` 只会让「哪一份才是落库的那一份」变成问题。
//
// # 权威判据在 TS，本文件是它的 Go 双实现
//
// 权威实现是 `platform/shared/seam-contracts/coordinator.ts` 的 `classifyAction`。§24.5 的
// 两组的 Go 侧此前**缺席**（Go 侧只落了 §24.7/§24.8 两组，见
// `control-plane/governance/internal/domain/coordinator.go`），于是 §14 判据 12「契约双实现」
// 在这两组上只成立一半：TS 判 `DENY` 而 Go 侧没有第二个声音可对账。本文件补的就是那一半。
//
// # 判据与 TS `coordinator.ts` 逐条对齐
//
//	| TS `coordinator.ts`                       | 本文件                          |
//	| ---                                       | ---                             |
//	| `ReleaseBand` 三值（第 45 行）             | release.go 的 `Band` 三常量      |
//	| `ReleaseReason` 八值（第 47–56 行）        | `ReleaseReason` 八常量           |
//	| `ActionFacts`（第 58–77 行）               | `ActionFacts`                   |
//	| `ReleaseDecision`（第 79–82 行）           | `ReleaseDecision`               |
//	| `classifyAction`（第 90–115 行）           | `ClassifyAction`                |
//	| `DENIED_STREAK_LIMIT = 3`（第 118 行）     | `DeniedStreakLimit`             |
//	| `DENIED_TOTAL_LIMIT = 20`（第 120 行）     | `DeniedTotalLimit`              |
//	| `FallbackVerdict` 两值（第 122 行）        | `FallbackDecision` 两常量        |
//	| `fallbackVerdict`（第 134–143 行）         | `FallbackVerdict`               |
//	| `counter()` 的输入校验（第 151–156 行）    | `FallbackVerdict` 内的负数拒绝    |
//
// 逐条判据（**有序**，先命中先返回；顺序本身就是优先级，两侧不得各自重排）：
//
//	| # | 条件                     | TS 结论                          | Go 结论                          |
//	| --- | ---                    | ---                             | ---                             |
//	| 1 | `!opaAllowed`           | `DENY` / `opa-denied`           | 同                              |
//	| 2 | `crossRealm`            | `DENY` / `cross-realm`          | 同                              |
//	| 3 | `touchesCredentials`    | `DENY` / `credentials`          | 同                              |
//	| 4 | `!reversible`           | `DENY` / `irreversible`         | 同                              |
//	| 5 | `!sideEffect`           | `AUTO` / `read-only`            | 同                              |
//	| 6 | `!classifierAvailable`  | `REVIEW` / `classifier-unavailable` | 同                          |
//	| 7 | `verdict == 'allow'`    | `AUTO` / `classifier-allow`     | 同                              |
//	| 7 | 否则（含缺省）           | `REVIEW` / `classifier-review`  | 同                              |
//
// 第 1 条必须排在最前：OPA 是权威裁决，它在语义上终局，只有排在任何技术性判定之前，
// 后面所有分支才**不可能**覆盖它。第 2/3 条同理排在分类器之前——分类器不该有机会对
// 「跨租户」「碰凭证」发问。第 4 条把不可逆动作**摘下判定域**：不可逆没有「判错了再改」
// 这个选项，因此不交给任何判定器，包括分类器（比文章更严，理由是「不可逆恒 DENY」是
// 一条可枚举的命题，「分类器会不会放行不可逆动作」不是）。
//
// 第 5 条与分类器可用性**无关**：把只读动作也推进人审队列，正是文章批评的 97% 批准率
// 场景——审批一旦退化成反射性点击，它就既不安全也不快。分类器的职责边界是**副作用动作**。
//
// # 三处有意的表面差异（行为等价，写在这里免得被当成漂移）
//
//  1. TS 用 `undefined` 表示「分类器没说话」，Go 用空串（`ClassifierVerdict` 的零值）。
//     两者都落到第 7 条的 else 分支：「没意见」不等于「同意」。
//  2. TS 的 `classifierVerdict` 是可选字段，Go 的 `ClassifierVerdict` 是闭集类型的零值——
//     同一件事的两种写法，缺省都不产生 `AUTO`。
//  3. TS 的 `counter()` 会抛 `invalid` 的有三种：负数、非整数、超出安全整数范围。Go 的
//     `int` 从类型上就构造不出后两种，故只留负数拒绝（与 governance 侧
//     `ReviewerEligibility` 同一条差异，也同一条理由）。
//
// # 为什么 FallbackVerdict 用 error，而 §24.8 的判据不抛异常
//
// 判据形状由**调用方的处置**决定，不由风格决定。§24.8 判的是「这个审查者合不合格」——
// 返回值本身就是那个判定，抛异常会让「数据坏了」与「审查者不合格」混成一件事。
// 这里的负数计数不是判定，是**调用方把字段传错了**：它的处置是改调用点（fail-closed），
// 不是「回落 / 不回落」二选一。放行它更糟——回落判据是 `>= 阈值`，负计数永远达不到阈值，
// 于是兜底**静默失效**，症状是「任务还在跑」而不是「任务失败了」，监控上看不出异常。
// 与 release.go 的 `Record.Validate` 拒绝负计数是同一条判据（那里返回 `ErrInvalid`）。

// ReleaseReason 是分档理由的闭集，与 TS 的 `ReleaseReason` 同集、同值。
//
// 闭集而不是自由文本：这个值要写进审计行（`action_reviews.reason`），自由文本会让它
// 失去聚合能力——「本月有多少次放行来自分类器」必须是一次 GROUP BY，而不是一次人工阅读。
// 八个值一个都不能少：缺 `classifier-unavailable` 或 `classifier-review` 里的任何一个，
// 「分类器挂了」与「分类器判定要人审」就会表现成同一个数字。
type ReleaseReason string

const (
	// ReasonOPADenied OPA 判否。终局。
	ReasonOPADenied ReleaseReason = "opa-denied"
	// ReasonCrossRealm 跨 realm（租户边界），不是本项目能自行决定的事。
	ReasonCrossRealm ReleaseReason = "cross-realm"
	// ReasonCredentials 触达凭证（Vault 内的值，§10）；凭证不出边界。
	ReasonCredentials ReleaseReason = "credentials"
	// ReasonIrreversible 不可逆：没有「判错了再改」这个选项，直接摘下判定域。
	ReasonIrreversible ReleaseReason = "irreversible"
	// ReasonReadOnly 只读动作恒放行，与分类器可用性无关。
	ReasonReadOnly ReleaseReason = "read-only"
	// ReasonClassifierUnavailable 分类器**不可用**（故障），最多到 REVIEW。
	ReasonClassifierUnavailable ReleaseReason = "classifier-unavailable"
	// ReasonClassifierReview 分类器**判定**要人审——与上一条是两个不同的事实。
	ReasonClassifierReview ReleaseReason = "classifier-review"
	// ReasonClassifierAllow 分类器放行：唯一能产出 AUTO 的非只读路径。
	ReasonClassifierAllow ReleaseReason = "classifier-allow"
)

// Reasons 是理由闭集的成员，供穷举（测试与将来的读面筛选用）。
var Reasons = []ReleaseReason{
	ReasonOPADenied,
	ReasonCrossRealm,
	ReasonCredentials,
	ReasonIrreversible,
	ReasonReadOnly,
	ReasonClassifierUnavailable,
	ReasonClassifierReview,
	ReasonClassifierAllow,
}

// ClassifierVerdict 是分类器能给的判定，与 TS 的 `'allow' | 'review'` 同集。
//
// **没有 `deny`**：拒绝由事实（不可逆 / 跨 realm / 凭证）与 OPA 给出，不由判定器给出。
// 少一个值，判定器就少一条放宽的路——这是接口层面的「只收窄，不放宽」。
//
// 零值（空串）表示**缺省**：分类器没说话。它与 `ClassifierReview` 走同一条分支，
// 但刻意不合并成一个值——「分类器说 review」与「分类器没说」在排查时是两件事。
type ClassifierVerdict string

const (
	// ClassifierAllow 放行（仍要过前面六条规则的关）。
	ClassifierAllow ClassifierVerdict = "allow"
	// ClassifierReview 进人审队列。
	ClassifierReview ClassifierVerdict = "review"
)

// ActionFacts 是判定一个动作所需的全部风险事实（§24.5），与 TS 的 `ActionFacts` 同形。
//
// 七个字段都是**事实**而不是结论：`sideEffect` 由工具档案给出（不由名字猜——`bash` 可以
// 是只读的，`connector_x` 也可能只读），`opaAllowed` 来自 OPA，其余来自工具/动作的申报。
//
// JSON 标签与 TS 侧的字段名逐字相同：跨语言对照测试（`matrix_test.go`）直接用它解码
// TS 生成的矩阵文件。字段名对不上的话，那份矩阵会解出一堆零值布尔——**每个零值都对应
// 一个合法的判定**，于是对照会因为「读错了」而变成「全绿」。标签写在这里，是这个风险的
// 唯一防线。
type ActionFacts struct {
	// SideEffect 工具的副作用判定。false 即只读，恒 AUTO（不因分类器不可用而降档）。
	SideEffect bool `json:"sideEffect"`
	// Reversible 动作可逆（可回滚 / 可撤销）。false 直接 DENY。
	Reversible bool `json:"reversible"`
	// CrossRealm 跨 realm。realm 是租户边界。
	CrossRealm bool `json:"crossRealm"`
	// TouchesCredentials 触达凭证（Vault 内的值，§10）。
	TouchesCredentials bool `json:"touchesCredentials"`
	// OpaAllowed OPA 的裁决。false 即终局。
	OpaAllowed bool `json:"opaAllowed"`
	// ClassifierAvailable 分类器是否可用。不可用即 fail-closed：有副作用的动作最多 REVIEW。
	ClassifierAvailable bool `json:"classifierAvailable"`
	// ClassifierVerdict 分类器的判定。缺省（零值）按 review 处理——「没意见」不等于「同意」。
	ClassifierVerdict ClassifierVerdict `json:"classifierVerdict"`
}

// ReleaseDecision 是一次分档的结论，与 TS 的 `ReleaseDecision` 同形。
//
// `Band` 用的是 release.go 的 `Band`（不是新类型）：判定结果与落库档位必须是同一个闭集，
// 否则「判出来是 AUTO、存下去是别的」这种组合在类型上就是可能的。
type ReleaseDecision struct {
	Band   Band          `json:"band"`
	Reason ReleaseReason `json:"reason"`
}

// ClassifyAction 判定一个动作的放行档（§24.5）。
//
// 规则**有序**，先命中先返回；顺序即优先级（理由见文件头那张表）。它是纯函数：不读
// 时钟、不碰库、不调分类器——分类器的结论由调用方作为 `ClassifierVerdict` 传进来。
// 判据与判定器分离，是为了让「分类器错了」与「规则错了」成为两个可以分别定位的故障。
func ClassifyAction(facts ActionFacts) ReleaseDecision {
	// 1. OPA 判否即否。**必须是第一条**：它在语义上是终局的，排在任何「技术性」判定之前，
	//    才能保证后面所有分支都不可能覆盖它。
	if !facts.OpaAllowed {
		return ReleaseDecision{Band: BandDeny, Reason: ReasonOPADenied}
	}

	// 2 / 3. 租户边界与凭证边界。排在分类器之前，理由同 1：分类器不该有机会对
	//        「跨租户」「碰凭证」这两类发问。
	if facts.CrossRealm {
		return ReleaseDecision{Band: BandDeny, Reason: ReasonCrossRealm}
	}
	if facts.TouchesCredentials {
		return ReleaseDecision{Band: BandDeny, Reason: ReasonCredentials}
	}

	// 4. 不可逆：摘下判定域。注意它排在只读之前——一个既不可逆又无副作用的动作在概念上
	//    不成立，但真出现时按更严的那条走。
	if !facts.Reversible {
		return ReleaseDecision{Band: BandDeny, Reason: ReasonIrreversible}
	}

	// 5. 只读：恒 AUTO，与分类器可用性无关。
	if !facts.SideEffect {
		return ReleaseDecision{Band: BandAuto, Reason: ReasonReadOnly}
	}

	// 6. 到此只剩「有副作用、可逆、同 realm、不碰凭证」的动作——**这才是分类器的判定域**。
	if !facts.ClassifierAvailable {
		return ReleaseDecision{Band: BandReview, Reason: ReasonClassifierUnavailable}
	}

	// 7. 分类器只说 allow / review；没说话（零值）按 review 处理。
	//    不认识的值（比如有人塞了个 "deny"）也走这里：fail-closed 的方向是 review，
	//    而不是「不认识就当没意见地放行」。
	if facts.ClassifierVerdict == ClassifierAllow {
		return ReleaseDecision{Band: BandAuto, Reason: ReasonClassifierAllow}
	}
	return ReleaseDecision{Band: BandReview, Reason: ReasonClassifierReview}
}

// 兜底回落的两个阈值（§24.5 第 3 条），与 TS 同名常量同值。
const (
	// DeniedStreakLimit 连续被拒达到此数即回落：它捕获「卡在同一个动作上」。
	DeniedStreakLimit = 3
	// DeniedTotalLimit 单 Run 累计被拒达到此数即回落：它捕获「在广泛地撞墙」——
	// 后者的单次间隔里插着成功，连续计数会归零。
	DeniedTotalLimit = 20
)

// FallbackDecision 是兜底结论的闭集，与 TS 的 `FallbackVerdict` 同集。
type FallbackDecision string

const (
	// FallbackKeep 不回落，照常按分类器判定走。
	FallbackKeep FallbackDecision = "keep"
	// FallbackToManual 整体回落全人工档（§24.5 第 3 条）。它不是 classifier 的同义词：
	// 回落之后判定者已经不再是分类器了，落在 `action_reviews.decider` 上必须是 `fallback`，
	// 否则「分类器撞墙多少次」这个运营问题会失去证据。
	FallbackToManual FallbackDecision = "fallback-to-manual"
)

// FallbackDecisions 是兜底结论闭集的成员，供穷举。
var FallbackDecisions = []FallbackDecision{FallbackKeep, FallbackToManual}

// FallbackVerdict 是兜底防自旋（§24.5 第 3 条）：判定器连续被拒到阈值就整体回落人工档。
//
// **为什么这条必须有**：没有它，分类器的误判会变成「被拒 → agent 换个说法重试 → 再被拒」
// 的无限循环，而循环的表现是「任务还在跑」而不是「任务失败了」——监控上看不出异常。
// 与 §8.1 那条「每个等待强制带 TTL，没有『永远等下去』这个选项」是同一类保护。
//
// 两个计数**任一**达标即回落，两个都要：它们捕获不同的形状（见两个阈值的注释）。
//
// 负数计数返回 `ErrInvalid` 而不是「当作 0」：静默当成 0 会让兜底失效
// （`-1 >= 3` 是 false，于是永远不回落），而失效的表现恰好是「一切照常」——
// 这是最难被发现的故障形状。
func FallbackVerdict(deniedStreak, deniedTotal int) (FallbackDecision, error) {
	if deniedStreak < 0 || deniedTotal < 0 {
		return "", fmt.Errorf("%w: deniedStreak / deniedTotal 必须非负（收到 %d / %d）",
			ErrInvalid, deniedStreak, deniedTotal)
	}
	if deniedStreak >= DeniedStreakLimit || deniedTotal >= DeniedTotalLimit {
		return FallbackToManual, nil
	}
	return FallbackKeep, nil
}
