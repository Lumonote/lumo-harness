package audit

import "testing"

// 纯函数判据：无需数据库。SQL 语义（游标不重不漏、过滤真的生效）由
// query_pg_test.go 里的单个 PG 用例承担 —— 用假实现断言 SQL 只是在断言假实现。

func TestParseDecisionAcceptsKnownValues(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want Decision
	}{
		{"", ""},
		{"allowed", Allowed},
		{"denied", Denied},
	} {
		got, err := ParseDecision(tc.raw)
		if err != nil || got != tc.want {
			t.Fatalf("ParseDecision(%q) = %q, %v; want %q, nil", tc.raw, got, err, tc.want)
		}
	}
}

// 未知取值必须报错，不能退化为「不过滤」：`decision=denyed` 若被静默忽略，
// 一次「只看被拒绝的调用」的合规查询会返回全部调用 —— 结果集被悄悄放大。
func TestParseDecisionRejectsUnknownInsteadOfWidening(t *testing.T) {
	for _, raw := range []string{"denyed", "ALLOWED", "true", "1", "denied,allowed", " "} {
		if got, err := ParseDecision(raw); err == nil {
			t.Fatalf("ParseDecision(%q) = %q, nil; want error（未知值不得退化为不过滤）", raw, got)
		}
	}
}

func TestNormalizeLimitConvergesToBounds(t *testing.T) {
	for _, tc := range []struct {
		in, want int
	}{
		{0, DefaultQueryLimit},  // 未指定
		{-5, DefaultQueryLimit}, // 非正 → 缺省
		{1, 1},                  // 下界内
		{50, 50},                // 缺省值本身
		{MaxQueryLimit, MaxQueryLimit},
		{MaxQueryLimit + 1, MaxQueryLimit}, // 超上限 → 收敛，不是报错
		{1 << 30, MaxQueryLimit},
	} {
		if got := NormalizeLimit(tc.in); got != tc.want {
			t.Fatalf("NormalizeLimit(%d) = %d; want %d", tc.in, got, tc.want)
		}
	}
}
