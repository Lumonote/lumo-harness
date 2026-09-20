// §24.5 两组判据的纯单元用例：闭集、规则顺序、两条不变量。
//
// 不依赖数据库、不依赖 TS 侧的矩阵文件（跨语言对照在 matrix_test.go），因此这几条
// 在任何环境下都真的会跑。
package release

import (
	"errors"
	"testing"
)

// TestReleaseReasonsAreExactlyTheDesignValues 把理由闭集钉死。
//
// 逐个断言而不是断言长度：这个闭集是**跨语言**的（写进 `action_reviews.reason`，
// 由 TS 侧 `ReleaseReason` 与 Go 侧共同解释），单边加值会让另一边读不懂这些行，
// 而症状是「某些行被静默忽略」而不是报错。顺序也钉住——它同时是文档里那张规则表的
// 阅读顺序，重排会让「第几条规则」这类讨论失去共同指称。
func TestReleaseReasonsAreExactlyTheDesignValues(t *testing.T) {
	want := []string{
		"opa-denied", "cross-realm", "credentials", "irreversible",
		"read-only", "classifier-unavailable", "classifier-review", "classifier-allow",
	}
	if len(Reasons) != len(want) {
		t.Fatalf("理由闭集应恰好 %d 个，实际 %d：%v", len(want), len(Reasons), Reasons)
	}
	for i, expected := range want {
		if string(Reasons[i]) != expected {
			t.Fatalf("理由闭集第 %d 个应为 %q，实际 %q", i, expected, Reasons[i])
		}
	}
}

// TestClassifierVerdictsHaveNoDeny 是「只收窄，不放宽」在类型层面的那一半。
//
// 判定器没有 `deny`：拒绝只由事实与 OPA 给出。这不是风格问题——一旦判定器能说 deny，
// 它就有了一个自己的拒绝域，而那个域的边界不在任何一张规则表里（它的实现是可替换件），
// 于是「分类器认为什么该拒」变成一条无法从设计文档读出来的策略。
//
// 顺带钉住 fail-closed 的方向：**不认识的值按 review 处理**。若有人（或一个旧版本的
// 配置）塞进 `deny`，它落进的是「进人审」而不是「放行」——错的一侧必须是安全的一侧。
func TestClassifierVerdictsHaveNoDeny(t *testing.T) {
	for _, member := range []ClassifierVerdict{ClassifierAllow, ClassifierReview} {
		if member == "deny" {
			t.Fatal("判定闭集里出现了 deny —— 拒绝必须只由事实与 OPA 给出")
		}
	}
	for _, forbidden := range []ClassifierVerdict{"deny", "DENY", "Allow", "block", "pass"} {
		got := ClassifyAction(ActionFacts{
			SideEffect: true, Reversible: true,
			OpaAllowed: true, ClassifierAvailable: true,
			ClassifierVerdict: forbidden,
		})
		if got.Band != BandReview || got.Reason != ReasonClassifierReview {
			t.Fatalf("闭集外的判定 %q 必须 fail-closed 落 REVIEW/classifier-review，实际 %s/%s",
				forbidden, got.Band, got.Reason)
		}
	}
}

// TestClassifyActionRuleOrder 逐对验证「先命中先返回」。
//
// 每一条用例都构造成**两条规则同时成立**，于是它验证的是优先级而不是单条规则本身：
// 单条规则的行为由 matrix_test.go 的全域对照覆盖，这里管的是它们相遇时谁赢。
// 顺序错了的表现恰恰是「单条规则全对，组合起来分叉」——那是最难从代码里读出来的一种错。
func TestClassifyActionRuleOrder(t *testing.T) {
	// 一个「最难判」的基例：有副作用、可逆、同 realm、不碰凭证、OPA 放行、分类器说 allow。
	baseline := ActionFacts{
		SideEffect: true, Reversible: true, CrossRealm: false, TouchesCredentials: false,
		OpaAllowed: true, ClassifierAvailable: true, ClassifierVerdict: ClassifierAllow,
	}
	with := func(mutate func(*ActionFacts)) ActionFacts {
		facts := baseline
		mutate(&facts)
		return facts
	}

	cases := []struct {
		name  string
		facts ActionFacts
		band  Band
		want  ReleaseReason
	}{
		{
			// 1 胜过 2/3/4/5/6/7：所有更宽的判定都同时成立，OPA 仍然终局。
			"OPA 判否压过其余全部规则",
			with(func(f *ActionFacts) {
				f.OpaAllowed = false
				f.CrossRealm, f.TouchesCredentials, f.Reversible = true, true, false
				f.SideEffect, f.ClassifierAvailable = false, false
			}),
			BandDeny, ReasonOPADenied,
		},
		{"跨 realm 压过凭证", with(func(f *ActionFacts) { f.CrossRealm, f.TouchesCredentials = true, true }), BandDeny, ReasonCrossRealm},
		{"凭证压过不可逆", with(func(f *ActionFacts) { f.TouchesCredentials, f.Reversible = true, false }), BandDeny, ReasonCredentials},
		{
			// 4 排在 5 之前：既不可逆又无副作用在概念上不成立，真出现时按更严的那条走。
			"不可逆压过只读",
			with(func(f *ActionFacts) { f.Reversible, f.SideEffect = false, false }),
			BandDeny, ReasonIrreversible,
		},
		{
			// 5 与分类器可用性无关：只读动作不因为分类器挂了而降档（97% 批准率那一课）。
			"只读压过分类器不可用",
			with(func(f *ActionFacts) { f.SideEffect, f.ClassifierAvailable = false, false }),
			BandAuto, ReasonReadOnly,
		},
		{
			// 6 排在 7 之前：分类器不可用时它说什么都不算（它可能压根没被调用）。
			"分类器不可用压过它的 allow 判定",
			with(func(f *ActionFacts) { f.ClassifierAvailable = false }),
			BandReview, ReasonClassifierUnavailable,
		},
		{"分类器放行是唯一能产出 AUTO 的非只读路径", baseline, BandAuto, ReasonClassifierAllow},
		{"分类器说 review 则进人审", with(func(f *ActionFacts) { f.ClassifierVerdict = ClassifierReview }), BandReview, ReasonClassifierReview},
		{
			// 「没意见」不等于「同意」：缺省走 else 分支。
			"分类器没说话按 review 处理",
			with(func(f *ActionFacts) { f.ClassifierVerdict = "" }),
			BandReview, ReasonClassifierReview,
		},
	}

	// 理由闭集里的每一个值都该在这张表里出现——少一个就说明**有条规则没人验证**，
	// 而「没验证」与「验证通过」在退出码上完全一样，所以这条覆盖检查是必需的。
	covered := map[ReleaseReason]bool{}
	for _, tc := range cases {
		covered[tc.want] = true
	}
	for _, reason := range Reasons {
		if !covered[reason] {
			t.Fatalf("规则表缺少理由 %q 的用例：闭集里的每个值都必须有一条规则产出它", reason)
		}
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyAction(tc.facts)
			if got.Band != tc.band || got.Reason != tc.want {
				t.Fatalf("应为 %s/%s，实际 %s/%s（facts=%+v）", tc.band, tc.want, got.Band, got.Reason, tc.facts)
			}
		})
	}
}

// TestClassifyActionInvariantsOverTheWholeDomain 是 §14 判据 1/2 在 Go 侧的本地复述。
//
// 矩阵对照（matrix_test.go）证明两侧相同，本用例证明**这一侧自己**满足两条硬约束：
// 它们与「两侧是否一致」是两件事——两侧可以一同违反同一条不变量。
// 全域穷举（6 个布尔 × 3 种判定）而不是抽样，因为这两条不变量都以「绝不」开头。
func TestClassifyActionInvariantsOverTheWholeDomain(t *testing.T) {
	for mask := 0; mask < 1<<6; mask++ {
		for _, verdict := range []ClassifierVerdict{ClassifierAllow, ClassifierReview, ""} {
			facts := ActionFacts{
				SideEffect:          mask&1 != 0,
				Reversible:          mask&2 != 0,
				CrossRealm:          mask&4 != 0,
				TouchesCredentials:  mask&8 != 0,
				OpaAllowed:          mask&16 != 0,
				ClassifierAvailable: mask&32 != 0,
				ClassifierVerdict:   verdict,
			}
			got := ClassifyAction(facts)

			// 判据 1：OPA 判否即否，分类器无权放宽。
			if !facts.OpaAllowed && (got.Band != BandDeny || got.Reason != ReasonOPADenied) {
				t.Fatalf("判据 1 被违反：facts=%+v → %s/%s", facts, got.Band, got.Reason)
			}
			// 判据 2：分类器不可用时，有副作用的动作绝不 AUTO。
			if !facts.ClassifierAvailable && facts.SideEffect && got.Band == BandAuto {
				t.Fatalf("判据 2 被违反：facts=%+v → %s/%s", facts, got.Band, got.Reason)
			}
			// 不变量：AUTO 只有两条来源（只读 / 分类器放行），不存在第三条。
			if got.Band == BandAuto && got.Reason != ReasonReadOnly && got.Reason != ReasonClassifierAllow {
				t.Fatalf("AUTO 的第三条路径：facts=%+v → %s", facts, got.Reason)
			}
		}
	}
}

// TestFallbackVerdictBoundaries 覆盖 §14 判据 3 要求的三点：2/19 不触发、3/20 触发。
func TestFallbackVerdictBoundaries(t *testing.T) {
	cases := []struct {
		streak, total int
		want          FallbackDecision
	}{
		{0, 0, FallbackKeep},
		{2, 19, FallbackKeep},
		{DeniedStreakLimit - 1, 1, FallbackKeep},
		{1, DeniedTotalLimit - 1, FallbackKeep},
		{DeniedStreakLimit, 0, FallbackToManual},
		{0, DeniedTotalLimit, FallbackToManual},
		{DeniedStreakLimit, 1, FallbackToManual},
		{1, DeniedTotalLimit, FallbackToManual},
	}
	for _, tc := range cases {
		got, err := FallbackVerdict(tc.streak, tc.total)
		if err != nil {
			t.Fatalf("%d/%d 不该报错：%v", tc.streak, tc.total, err)
		}
		if got != tc.want {
			t.Fatalf("%d/%d 应为 %s，实际 %s", tc.streak, tc.total, tc.want, got)
		}
	}
}

// TestFallbackVerdictRejectsNegativeCounters 钉住「负计数返回错误而不是当成 0」。
//
// 当成 0 会让兜底**静默失效**：回落判据是 `>= 阈值`，负值永远达不到阈值，于是
// 「分类器连续被拒」再也不会触发回落——症状是「任务还在跑」而不是「任务失败了」。
// 错误必须是 `ErrInvalid`（调用方按请求错误处置，不是按基础设施故障重试）。
func TestFallbackVerdictRejectsNegativeCounters(t *testing.T) {
	for _, tc := range [][2]int{{-1, 0}, {0, -1}, {-1, -1}, {-100, 20}} {
		got, err := FallbackVerdict(tc[0], tc[1])
		if err == nil {
			t.Fatalf("负计数 %v 必须被拒，实际给出 %q", tc, got)
		}
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("负计数的错误应可被 errors.Is(ErrInvalid) 识别，实际 %v", err)
		}
		if got != "" {
			t.Fatalf("被拒的输入不该同时给出一个判定，实际 %q", got)
		}
	}
}
