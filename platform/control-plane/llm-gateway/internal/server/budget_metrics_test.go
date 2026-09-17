package server_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
	"github.com/lumo-harness/platform/llm-gateway/internal/store"
)

// budgetRow 一行预算树的原始列。指针用于表达 SQL 的 NULL——旧模式（budget_total
// 为 NULL）与总额模式是两套判据，必须都能造出来。
type budgetRow struct {
	kind         string
	id           string
	budget       int64
	total        *int64
	softLimit    *int64
	overdraft    *int64
	expectDenied bool
}

func i64(v int64) *int64 { return &v }

func (r budgetRow) tree() domain.TreeRow {
	return domain.TreeRow{Budget: &r.budget, BudgetTotal: r.total, SoftLimit: r.softLimit, Overdraft: r.overdraft}
}

// TestBudgetTreeCountsMirrorStateOfTree 是 SQL 条件与 domain 判态之间唯一的护栏。
//
// store.BudgetTreeCounts 把 hard 条件写成了 SQL 聚合（抓取路径上不能把成千上万行
// 拉回 Go），那份 SQL 与 domain.StateOfTree(row, 0) 是同一份语义的两种写法，没有
// 编译期联系。所以这里逐格铺开边界，把两边直接对照——只改一边时这条用例会红。
//
// 边界是重点：budget 恰好为 0 在总额模式下算 hard、在旧模式下算 within；
// overdraft 为 NULL 时按 0 处理；overdraft 为负时 -overdraft 为正。这三处正是
// 「看起来等价、实际不等价」的地方。
func TestBudgetTreeCountsMirrorStateOfTree(t *testing.T) {
	_, pool := setup(t, "http://127.0.0.1:1")
	rows := []budgetRow{
		// 旧模式：判据是剩余 < 0。
		{kind: "user", id: "legacy-positive", budget: 100, softLimit: i64(50), overdraft: i64(10)},
		{kind: "user", id: "legacy-zero", budget: 0, softLimit: i64(50), overdraft: i64(10)},
		{kind: "user", id: "legacy-negative", budget: -1, softLimit: i64(50), overdraft: i64(10), expectDenied: true},
		// 总额模式：判据是 used = total - budget >= total + overdraft。
		{kind: "project", id: "within", budget: 500, total: i64(1000), softLimit: i64(800), overdraft: i64(100)},
		{kind: "project", id: "soft", budget: 300, total: i64(1000), softLimit: i64(800), overdraft: i64(100)},
		{kind: "project", id: "overdraft", budget: 0, total: i64(1000), softLimit: i64(800), overdraft: i64(100)},
		{kind: "project", id: "overdraft-edge", budget: -99, total: i64(1000), softLimit: i64(800), overdraft: i64(100)},
		{kind: "project", id: "hard", budget: -100, total: i64(1000), softLimit: i64(800), overdraft: i64(100), expectDenied: true},
		{kind: "project", id: "hard-beyond", budget: -400, total: i64(1000), softLimit: i64(800), overdraft: i64(100), expectDenied: true},
		// overdraft 为 NULL：按 0 处理，于是 budget 恰好为 0 已经算 hard。
		{kind: "project", id: "null-overdraft-zero", budget: 0, total: i64(1000), expectDenied: true},
		{kind: "project", id: "null-overdraft-one", budget: 1, total: i64(1000)},
		// overdraft 为负：**非法配置**——canonical 的 resolveLimits 对负数抛错，写入侧
		// setBudget/adjustBudget 落库前也调它，所以正常途径进不了库。读取侧按 fail-closed
		// 统一算拦住：domain 与这份 SQL 必须同判，否则会出现「面板说拦住了、网关在放行」。
		{kind: "project", id: "invalid-negative-overdraft", budget: 5, total: i64(1000), softLimit: i64(800), overdraft: i64(-10), expectDenied: true},
	}
	ctx := context.Background()
	for _, row := range rows {
		if _, err := pool.Exec(ctx, `
			INSERT INTO budget_trees (kind, id, budget, budget_total, soft_limit, overdraft)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			row.kind, row.id, row.budget, row.total, row.softLimit, row.overdraft); err != nil {
			t.Fatalf("种子预算树失败: %v", err)
		}
		// 先核一遍用例作者的预期：如果 domain 判态与预期不符，那是用例写错了，
		// 不该被后面的「两边一致」掩盖过去（两边一起错也能一致）。
		if state := domain.StateOfTree(ptrTree(row), 0); (state == domain.StateHard) != row.expectDenied {
			t.Fatalf("用例预期 %s 的 denied=%v，但 domain.StateOfTree 判出 %s", row.id, row.expectDenied, state)
		}
	}

	counts, err := store.New(pool).BudgetTreeCounts(ctx)
	if err != nil {
		t.Fatalf("统计预算树失败: %v", err)
	}
	// 期望值由 domain.StateOfTree 现算，而不是把数字抄一遍：抄一遍的话，
	// SQL 与 domain 同时改错也能通过。
	expected := map[string]store.BudgetTreeCount{}
	for _, row := range rows {
		acc := expected[row.kind]
		acc.Kind = row.kind
		acc.Total++
		if domain.StateOfTree(ptrTree(row), 0) == domain.StateHard {
			acc.Denied++
		}
		expected[row.kind] = acc
	}
	if len(counts) != len(expected) {
		t.Fatalf("kind 数不符：期望 %v，实际 %v", expected, counts)
	}
	for _, got := range counts {
		want := expected[got.Kind]
		if got.Total != want.Total || got.Denied != want.Denied {
			t.Fatalf("kind=%s 计数不符：期望 total=%d denied=%d，实际 total=%d denied=%d"+
				"（SQL 里的 hard 条件与 domain.StateOfTree(row, 0) 已经分叉）",
				got.Kind, want.Total, want.Denied, got.Total, got.Denied)
		}
	}
}

func ptrTree(r budgetRow) *domain.TreeRow {
	tree := r.tree()
	return &tree
}

// TestMetricsEndpointExportsBudgetCounts 把 store 的计数与导出面接起来：前一条用例
// 保证计数是对的，这条保证它真的出现在 /metrics 上——只存在于 store 的查询对告警
// 毫无价值。
func TestMetricsEndpointExportsBudgetCounts(t *testing.T) {
	ts, pool := setup(t, "http://127.0.0.1:1")
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO budget_trees (kind, id, budget, budget_total, soft_limit, overdraft) VALUES
		  ('user', 'u-ok', 500, 1000, 800, 100),
		  ('user', 'u-denied', -100, 1000, 800, 100),
		  ('project', 'p-ok', 500, 1000, 800, 100)`); err != nil {
		t.Fatalf("种子预算树失败: %v", err)
	}

	body := scrapeMetrics(t, ts)
	for _, want := range []string{
		`lumo_budget_trees{kind="user"} 2`,
		`lumo_budget_trees_denied{kind="user"} 1`,
		`lumo_budget_trees{kind="project"} 1`,
		`lumo_budget_trees_denied{kind="project"} 0`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q in:\n%s", want, body)
		}
	}
	// soft / overdraft 不导出：IsAllowed 明确「hard 之外都放行」，把它们做成告警
	// 只会制造「响了但什么都没坏」的噪声，而值班开始忽略告警正是从这类噪声开始的。
	// 这里钉住这个决定，防止将来有人「顺手补上分档」。
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, "lumo_budget_") {
			continue
		}
		if strings.Contains(line, "soft") || strings.Contains(line, "overdraft") || strings.Contains(line, "state=") {
			t.Fatalf("预算指标不应出现分档明细: %s", line)
		}
	}
}

func scrapeMetrics(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	res, err := http.Get(ts.URL + "/metrics")
	if err != nil {
		t.Fatalf("抓取 /metrics 失败: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/metrics 状态码 = %d", res.StatusCode)
	}
	var sb strings.Builder
	if _, err := io.Copy(&sb, res.Body); err != nil {
		t.Fatalf("读取 /metrics 失败: %v", err)
	}
	return sb.String()
}
