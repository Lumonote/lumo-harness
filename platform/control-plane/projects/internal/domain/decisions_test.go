package domain

import (
	"errors"
	"strings"
	"testing"
)

// §24.4 判据：kind 是闭集，闭集外一律拒绝且错误里带上合法取值。
func TestValidDecisionKindClosedSet(t *testing.T) {
	for _, kind := range DecisionKinds {
		if err := ValidDecisionKind(kind); err != nil {
			t.Fatalf("%s 应合法: %v", kind, err)
		}
	}
	for _, bad := range []string{"", "note", "DECISION", "trap ", "决策"} {
		err := ValidDecisionKind(bad)
		if err == nil {
			t.Fatalf("闭集外的 %q 应被拒绝", bad)
		}
		if !strings.Contains(err.Error(), "合法取值") || !strings.Contains(err.Error(), DecisionKindTrap) {
			t.Fatalf("错误信息要列出合法取值（否则调用方无从修正）: %v", err)
		}
	}
	// 闭集快照必须与常量一致——两处漂移等于闭集有两个定义。
	if len(DecisionKinds) != 4 {
		t.Fatalf("闭集大小 %d，want 4", len(DecisionKinds))
	}
}

// §24.4 判据：索引必须有界，且**默认值本身就是上限**（调用方不传也要被限住）。
func TestResolveDecisionIndexLimitIsBounded(t *testing.T) {
	if DecisionIndexDefaultLimit >= DecisionIndexMaxLimit {
		t.Fatalf("默认上限 %d 不得大于等于最大上限 %d", DecisionIndexDefaultLimit, DecisionIndexMaxLimit)
	}
	cases := []struct{ in, want int }{
		{0, DecisionIndexDefaultLimit},
		{-1, DecisionIndexDefaultLimit},
		{1, 1},
		{DecisionIndexMaxLimit, DecisionIndexMaxLimit},
		{DecisionIndexMaxLimit + 1, DecisionIndexMaxLimit},
		{1 << 20, DecisionIndexMaxLimit},
	}
	for _, c := range cases {
		if got := ResolveDecisionIndexLimit(c.in); got != c.want {
			t.Fatalf("ResolveDecisionIndexLimit(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestValidateDecisionAppend(t *testing.T) {
	valid := Decision{
		ID: "dec_1", Realm: "r1", ProjectID: "proj_1",
		Kind: DecisionKindDecision, Summary: "发布日期改到周五", Body: "因为账单结算在周四跑完。",
	}
	if err := ValidateDecisionAppend(valid); err != nil {
		t.Fatalf("合法条目被拒: %v", err)
	}

	// 取代别人是合法的（这是唯一的「改」）
	superseding := valid
	superseding.ID = "dec_2"
	superseding.Supersedes = "dec_1"
	if err := ValidateDecisionAppend(superseding); err != nil {
		t.Fatalf("显式取代应合法: %v", err)
	}

	withEvidence := valid
	withEvidence.Evidence = []ReportEvidence{{SessionRef: "s1", Seq: 7}}
	if err := ValidateDecisionAppend(withEvidence); err != nil {
		t.Fatalf("带可解析证据应合法: %v", err)
	}

	bad := []struct {
		name string
		mut  func(d Decision) Decision
	}{
		{"缺 id", func(d Decision) Decision { d.ID = ""; return d }},
		{"缺 realm", func(d Decision) Decision { d.Realm = ""; return d }},
		{"缺 project_id", func(d Decision) Decision { d.ProjectID = ""; return d }},
		{"闭集外 kind", func(d Decision) Decision { d.Kind = "note"; return d }},
		{"空 summary", func(d Decision) Decision { d.Summary = "   "; return d }},
		{"空 body", func(d Decision) Decision { d.Body = "\n\t"; return d }},
		{"取代自身", func(d Decision) Decision { d.Supersedes = d.ID; return d }},
		{"新增行已带 superseded_by", func(d Decision) Decision { d.SupersededBy = "dec_9"; return d }},
		{"证据缺 session_ref", func(d Decision) Decision {
			d.Evidence = []ReportEvidence{{Seq: 3}}
			return d
		}},
		{"证据 seq 为负", func(d Decision) Decision {
			d.Evidence = []ReportEvidence{{SessionRef: "s1", Seq: -1}}
			return d
		}},
	}
	for _, c := range bad {
		err := ValidateDecisionAppend(c.mut(valid))
		if err == nil {
			t.Fatalf("%s 应被拒绝", c.name)
		}
		// server 层靠 errors.Is 映射 400：错误身份必须是 ErrInvalidDecision，
		// 而不是「恰好也报了个错」。
		if !errors.Is(err, ErrInvalidDecision) {
			t.Fatalf("%s 的错误应可被 errors.Is(ErrInvalidDecision) 识别: %v", c.name, err)
		}
	}
}
