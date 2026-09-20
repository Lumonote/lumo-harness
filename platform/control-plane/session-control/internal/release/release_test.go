// 纯单元用例：闭集与写入判据。**不依赖数据库**，因此它在任何环境下都会真的执行
// （存储层的活库用例没 DSN 就跳过，那批跳过会让「绿」不等于证据）。
package release

import (
	"errors"
	"strings"
	"testing"
)

// TestClosedSetsAreExactlyTheDesignValues 把两个闭集钉死。
//
// 逐个断言而不是断言长度：多一个少一个都是设计漂移——`action_reviews` 的档位是
// **跨语言**的（TS 侧 `ReleaseBand`），单边加值会让另一边读不懂这些行，而症状是
// 「某些行被静默忽略」而不是报错。
func TestClosedSetsAreExactlyTheDesignValues(t *testing.T) {
	wantBands := []string{"AUTO", "REVIEW", "DENY"}
	if len(Bands) != len(wantBands) {
		t.Fatalf("档位闭集应恰好 %d 个，实际 %d：%v", len(wantBands), len(Bands), Bands)
	}
	for i, want := range wantBands {
		if string(Bands[i]) != want {
			t.Fatalf("档位闭集第 %d 个应为 %q，实际 %q", i, want, Bands[i])
		}
	}

	wantDeciders := []string{"classifier", "human", "fallback"}
	if len(Deciders) != len(wantDeciders) {
		t.Fatalf("判定者闭集应恰好 %d 个，实际 %d：%v", len(wantDeciders), len(Deciders), Deciders)
	}
	for i, want := range wantDeciders {
		if string(Deciders[i]) != want {
			t.Fatalf("判定者闭集第 %d 个应为 %q，实际 %q", i, want, Deciders[i])
		}
	}
}

func TestParseBandRoundTripsEveryMember(t *testing.T) {
	for _, b := range Bands {
		got, err := ParseBand(string(b))
		if err != nil {
			t.Fatalf("%q 应被接受：%v", b, err)
		}
		if got != b {
			t.Fatalf("往返不一致：%q → %q", b, got)
		}
	}
}

// TestParseBandRejectsIllegalValues 覆盖三类非法输入，尤其是**大小写变体**。
//
// `auto` 是小写版的合法档位。若放行它，同一档就会以两种拼写落库，按档位聚合的查询
// 得先做一次归一化——而任何一条忘了归一化的查询会把同一档拆成两个数字。闭集的意义
// 正是「只有一种合法拼写」；这里拒绝比落库好，因为表是 append-only 的，写错那一行擦不掉。
func TestParseBandRejectsIllegalValues(t *testing.T) {
	for _, raw := range []string{"auto", "Auto", "ALLOW", "PERMIT", "BAND", "", " AUTO", "AUTO "} {
		if _, err := ParseBand(raw); err == nil {
			t.Fatalf("非法档位 %q 必须被拒绝，不能静默存下来", raw)
		} else if !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q 的错误应可被 errors.Is(ErrInvalid) 识别，实际 %v", raw, err)
		}
	}
}

func TestParseDeciderRejectsIllegalValues(t *testing.T) {
	for _, raw := range []string{"Classifier", "CLASSIFIER", "ai", "model", "ops", "", "自动"} {
		if _, err := ParseDecider(raw); err == nil {
			t.Fatalf("非法判定者 %q 必须被拒绝", raw)
		}
	}
}

// TestParseRejectsEverySiblingValue 防「复制粘贴到隔壁闭集」：AUTO 是合法档位，
// 但作为判定者必须被拒（反之亦然）。两个闭集恰好在同一个函数附近，串了很容易发生。
func TestParseRejectsEverySiblingValue(t *testing.T) {
	for _, b := range Bands {
		if _, err := ParseDecider(string(b)); err == nil {
			t.Fatalf("档位 %q 不是合法的判定者，必须被拒", b)
		}
	}
	for _, d := range Deciders {
		if _, err := ParseBand(string(d)); err == nil {
			t.Fatalf("判定者 %q 不是合法的档位，必须被拒", d)
		}
	}
}

func valid() Record {
	return Record{
		ID: "rev-1", Realm: "dev", SessionRef: "s1", RunID: "run-1",
		Action: "bash", Band: BandAuto, Decider: DeciderClassifier,
		Reason: "classifier-allow", DeniedStreak: 0, DeniedTotal: 0,
	}
}

func TestValidateAcceptsACompleteRecord(t *testing.T) {
	if err := valid().Validate(); err != nil {
		t.Fatalf("完整记录应通过校验：%v", err)
	}
	// 不属于任何 Run 的判定同样合法（§22.3：NULL 是语义，不是缺失）。
	noRun := valid()
	noRun.RunID = ""
	if err := noRun.Validate(); err != nil {
		t.Fatalf("无 Run 的记录应通过校验：%v", err)
	}
}

// TestValidateRejectsMissingFields：每一个必填字段缺了都必须被拒。
//
// 逐字段断言而不是抽查：这行记录的用途就是**可审计**，任意一个字段缺失都会让某一类
// 问题再也问不出来（没有 id 就没有幂等键，没有 reason 就答不出「为什么放行」）。
func TestValidateRejectsMissingFields(t *testing.T) {
	cases := map[string]func(*Record){
		"id":         func(r *Record) { r.ID = "" },
		"id 全空白":     func(r *Record) { r.ID = "   " },
		"realm":      func(r *Record) { r.Realm = "" },
		"sessionRef": func(r *Record) { r.SessionRef = "" },
		"action":     func(r *Record) { r.Action = "" },
		"band":       func(r *Record) { r.Band = "" },
		"decider":    func(r *Record) { r.Decider = "" },
		"reason":     func(r *Record) { r.Reason = "" },
		"reason 全空白": func(r *Record) { r.Reason = "\t " },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			rec := valid()
			mutate(&rec)
			if err := rec.Validate(); err == nil {
				t.Fatalf("缺 %s 必须被拒", name)
			} else if !errors.Is(err, ErrInvalid) {
				t.Fatalf("%s 的错误应可被 errors.Is(ErrInvalid) 识别，实际 %v", name, err)
			}
		})
	}
}

// TestValidateRejectsOutOfSetValuesBeforeInsert 是「非法值绝不静默入库」的单元级证明。
func TestValidateRejectsOutOfSetValuesBeforeInsert(t *testing.T) {
	bad := valid()
	bad.Band = "ALLOW"
	if err := bad.Validate(); err == nil {
		t.Fatal("闭集外的档位必须被拒")
	}

	bad = valid()
	bad.Decider = "robot"
	if err := bad.Validate(); err == nil {
		t.Fatal("闭集外的判定者必须被拒")
	}
}

// TestValidateRejectsNegativeCounters：负数会让兜底**静默失效**（回落判据是 `>= 阈值`，
// 负计数永远达不到阈值），症状是「任务还在跑」而不是「任务失败了」。
func TestValidateRejectsNegativeCounters(t *testing.T) {
	bad := valid()
	bad.DeniedStreak = -1
	if err := bad.Validate(); err == nil {
		t.Fatal("负的连续被拒计数必须被拒")
	}

	bad = valid()
	bad.DeniedTotal = -20
	if err := bad.Validate(); err == nil {
		t.Fatal("负的累计被拒计数必须被拒")
	}
}

// TestValidateDoesNotEnforceStreakTotalNesting 记录一条**刻意不做**的校验。
//
// 「连续 ≤ 累计」看起来很合理，其实不成立：两个计数的窗口不同（连续是当下连续段、
// 跨动作甚至跨 Run；累计是单 Run 的）。把它写成校验会让真实数据被拒——这是坏校验里
// 最难发现的一种（症状是偶发 400，而不是一条明显的错数据）。用例在这里把它写成断言，
// 免得后人「顺手补上」。
func TestValidateDoesNotEnforceStreakTotalNesting(t *testing.T) {
	rec := valid()
	rec.DeniedStreak = 5
	rec.DeniedTotal = 2
	if err := rec.Validate(); err != nil {
		t.Fatalf("连续计数大于累计计数是可能的（窗口不同），不该被拒：%v", err)
	}
}

// TestBandAutoWithClassifierIsLegal 钉住一个语义上容易搞混的组合。
//
// `AUTO + classifier` 是**正常**记录（分类器放行了一个有副作用的可逆动作），不是自相
// 矛盾：分类器只能收窄不能放宽，但它确实能判 `allow`（§24.5 的 `classifier-allow`）。
// 若哪天有人「顺手」加一条禁止它的校验，就等于把分类器放行的能力从库里删掉了。
func TestBandAutoWithClassifierIsLegal(t *testing.T) {
	rec := valid()
	rec.Band, rec.Decider, rec.Reason = BandAuto, DeciderClassifier, "classifier-allow"
	if err := rec.Validate(); err != nil {
		t.Fatalf("AUTO + classifier 是正常记录：%v", err)
	}
}

// TestInvalidErrorNamesTheOffendingValue：错误信息必须带上非法值本身。
// 写入方是另一个节点（dsh 节点 / 控制台），报「未知放行档」而不给值，排查就得去猜
// 是哪个字段串了；带上值则直接指向调用点。
func TestInvalidErrorNamesTheOffendingValue(t *testing.T) {
	_, err := ParseBand("MAYBE")
	if err == nil {
		t.Fatal("非法档位应报错")
	}
	if !strings.Contains(err.Error(), "MAYBE") {
		t.Fatalf("错误信息要带上非法值本身（运维据此定位写入方），实际 %q", err.Error())
	}
}
