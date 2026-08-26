package domain

import (
	"testing"
)

// 判据 7（双实现）：与 TS flows.spec 同矩阵逐格一致。
func TestTransitionFlow(t *testing.T) {
	legal := []struct{ from, event, want string }{
		{StatusDraft, EventSubmit, StatusSubmitted},
		{StatusDraft, EventDeprecate, StatusDeprecated},
		{StatusSubmitted, EventApprove, StatusPublished},
		{StatusSubmitted, EventReject, StatusDraft},
		{StatusPublished, EventTarget, StatusTargeted},
		{StatusPublished, EventDeprecate, StatusDeprecated},
		{StatusTargeted, EventTarget, StatusTargeted}, // 幂等重定 audience
		{StatusTargeted, EventDeprecate, StatusDeprecated},
	}
	for _, c := range legal {
		got, err := TransitionFlow(c.from, c.event)
		if err != nil || got != c.want {
			t.Fatalf("%s --%s--> got %s err %v, want %s", c.from, c.event, got, err, c.want)
		}
	}
	illegal := []struct{ from, event string }{
		{StatusDraft, EventApprove}, {StatusDraft, EventTarget},
		{StatusSubmitted, EventSubmit}, {StatusSubmitted, EventTarget},
		{StatusPublished, EventSubmit}, {StatusPublished, EventApprove}, {StatusPublished, EventReject},
		{StatusTargeted, EventSubmit}, {StatusTargeted, EventApprove}, {StatusTargeted, EventReject},
		{StatusDeprecated, EventSubmit}, {StatusDeprecated, EventTarget}, {StatusDeprecated, EventDeprecate},
	}
	for _, c := range illegal {
		if _, err := TransitionFlow(c.from, c.event); err == nil {
			t.Fatalf("%s --%s--> 应拒绝", c.from, c.event)
		}
	}
	if _, err := TransitionFlow("live", EventSubmit); err == nil {
		t.Fatalf("闭集外状态应报错")
	}
	if _, err := TransitionFlow(StatusDraft, "publish"); err == nil {
		t.Fatalf("闭集外事件应报错")
	}
}

func TestValidateDefinition(t *testing.T) {
	dag := func(nodes []struct {
		ID       string
		Operator string
	}, edges ...[2]string) *Definition {
		d := &Definition{}
		for _, n := range nodes {
			d.Nodes = append(d.Nodes, struct {
				ID       string `json:"id"`
				Operator string `json:"operator"`
			}{n.ID, n.Operator})
		}
		for _, e := range edges {
			d.Edges = append(d.Edges, struct {
				From string `json:"from"`
				To   string `json:"to"`
			}{e[0], e[1]})
		}
		return d
	}
	op := func(ids ...string) []struct{ ID, Operator string } {
		out := []struct{ ID, Operator string }{}
		for _, id := range ids {
			out = append(out, struct{ ID, Operator string }{id, "kb.query"})
		}
		return out
	}

	// 合法 DAG（分叉+汇合）
	if err := ValidateDefinition(dag(op("a", "b", "c", "d"), [2]string{"a", "b"}, [2]string{"a", "c"}, [2]string{"b", "d"}, [2]string{"c", "d"})); err != nil {
		t.Fatalf("合法 DAG 被拒: %v", err)
	}
	// 空节点
	if err := ValidateDefinition(dag(nil)); err == nil {
		t.Fatalf("空节点应拒")
	}
	// 重复 id
	if err := ValidateDefinition(dag(op("a", "a"))); err == nil {
		t.Fatalf("重复 id 应拒")
	}
	// 缺算子
	d := &Definition{}
	d.Nodes = append(d.Nodes, struct {
		ID       string `json:"id"`
		Operator string `json:"operator"`
	}{"a", ""})
	if err := ValidateDefinition(d); err == nil {
		t.Fatalf("缺算子应拒")
	}
	// 悬边
	if err := ValidateDefinition(dag(op("a"), [2]string{"a", "ghost"})); err == nil {
		t.Fatalf("悬边应拒")
	}
	// 自环 / 二元环 / 间接环
	if err := ValidateDefinition(dag(op("a"), [2]string{"a", "a"})); err == nil {
		t.Fatalf("自环应拒")
	}
	if err := ValidateDefinition(dag(op("a", "b"), [2]string{"a", "b"}, [2]string{"b", "a"})); err == nil {
		t.Fatalf("二元环应拒")
	}
	if err := ValidateDefinition(dag(op("a", "b", "c", "d"),
		[2]string{"a", "b"}, [2]string{"b", "c"}, [2]string{"c", "a"}, [2]string{"a", "d"})); err == nil {
		t.Fatalf("间接环应拒")
	}
}

func TestAudienceMatches(t *testing.T) {
	a := &Audience{Roles: []string{"analyst"}, Depts: []string{"d2"}, Users: []string{"carol"}}
	cases := []struct {
		c    Caller
		want bool
	}{
		{Caller{User: "x", Roles: []string{"analyst"}}, true},
		{Caller{User: "carol", Roles: []string{"viewer"}}, true},
		{Caller{User: "y", Roles: []string{}, Depts: []string{"d2"}}, true},
		{Caller{User: "z", Roles: []string{"viewer"}, Depts: []string{"d9"}}, false},
		{Caller{User: "z", Roles: []string{"admin"}, Depts: []string{"d2"}}, true},
	}
	for i, c := range cases {
		if got := AudienceMatches(a, c.c); got != c.want {
			t.Fatalf("case %d: got %v want %v", i, got, c.want)
		}
	}
	if AudienceMatches(nil, Caller{User: "x", Roles: []string{"admin"}}) {
		t.Fatalf("nil audience 恒假")
	}
	if AudienceMatches(&Audience{}, Caller{User: "x", Roles: []string{"admin"}, Depts: []string{"d2"}}) {
		t.Fatalf("空 audience 恒假（配置错误宁可不可见）")
	}
}
