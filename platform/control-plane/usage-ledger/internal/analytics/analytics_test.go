package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeSource 是查询面的测试替身。
//
// 存在的理由不是「解耦」，而是本机与 CI 都没有 PG（见仓库惯例）：
// 有了这个注入点，参数校验、排序、合计、HTTP 状态码这些**与数据库无关**的行为
// 才能被真正断言，而不是被 skip 掉。
type fakeSource struct {
	rows []Row
	err  error

	// 调用留痕：用来断言「非法区间根本没有触达数据库」。
	calls int
	from  string
	to    string
	proj  string
}

func (f *fakeSource) Aggregate(_ context.Context, fromDay, toDay, projectID string) ([]Row, error) {
	f.calls++
	f.from, f.to, f.proj = fromDay, toDay, projectID
	if f.err != nil {
		return nil, f.err
	}
	// 返回副本：Service 会就地排序，替身不该被调用方改写。
	out := make([]Row, len(f.rows))
	copy(out, f.rows)
	return out, nil
}

func mustService(t *testing.T, src Source) *Service {
	t.Helper()
	svc, err := NewService(src)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return svc
}

func TestNewServiceRejectsNilSource(t *testing.T) {
	// nil source 会在第一次查询时 panic；宁可在装配期就响亮地失败。
	if _, err := NewService(nil); err == nil {
		t.Fatal("nil source 应当报错，实际通过了")
	}
}

// --- 日界 ---

func TestDayBoundsIsHalfOpenAndUTC(t *testing.T) {
	start, end, err := DayBounds("2026-03-01")
	if err != nil {
		t.Fatalf("DayBounds: %v", err)
	}
	if start.Location() != time.UTC {
		t.Errorf("起始时刻时区 = %v，期望 UTC", start.Location())
	}
	if got := start.Format(time.RFC3339); got != "2026-03-01T00:00:00Z" {
		t.Errorf("起始时刻 = %s", got)
	}
	if got := end.Format(time.RFC3339); got != "2026-03-02T00:00:00Z" {
		t.Errorf("结束时刻 = %s，期望次日零点（半开区间上界）", got)
	}
	// 半开区间：恰好等于上界的行属于**下一天**，不属于今天。
	if !start.Before(end) {
		t.Error("起始不早于结束")
	}
}

func TestDayBoundsRejectsBadFormat(t *testing.T) {
	for _, day := range []string{"", "2026-3-1", "2026/03/01", "20260301", "2026-13-01", "2026-02-30"} {
		if _, _, err := DayBounds(day); err == nil {
			t.Errorf("DayBounds(%q) 应当报错，实际通过", day)
		}
	}
}

// ReportingLocation 是 SQL 侧 timezone($1, ts) 与 Go 侧区间过滤的**唯一**共同来源。
// 它一旦不是 UTC，两边的「这条记录属于哪一天」就会分叉，而分叉的表现只是「某些分组偏小」。
func TestReportingLocationIsUTC(t *testing.T) {
	if ReportingLocation != time.UTC {
		t.Fatalf("ReportingLocation = %v，期望 UTC（SQL 与 Go 必须同源）", ReportingLocation)
	}
}

// --- 区间校验 ---

func TestValidateRange(t *testing.T) {
	cases := []struct {
		name    string
		from    string
		to      string
		wantErr bool
	}{
		{"单日", "2026-03-01", "2026-03-01", false},
		{"跨月", "2026-01-31", "2026-02-01", false},
		{"恰好上限 366 天", "2021-01-01", "2022-01-01", false},
		{"超过上限 367 天", "2020-01-01", "2021-01-01", true},
		{"from 格式错", "2026-3-1", "2026-03-02", true},
		{"to 格式错", "2026-03-01", "20260302", true},
		{"to 早于 from", "2026-03-05", "2026-03-01", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateRange(tc.from, tc.to)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("期望报错，实际通过")
				}
				// 必须可判定为「调用方的问题」，否则 HTTP 层会把它报成 500。
				if !errors.Is(err, ErrInvalidRange) {
					t.Fatalf("错误未包裹 ErrInvalidRange: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("期望通过，实际 %v", err)
			}
		})
	}
}

// 非法区间必须在触达数据源**之前**就被拒绝：否则一次手抖的 from/to 会变成一次全表扫描。
func TestInvalidRangeDoesNotReachSource(t *testing.T) {
	src := &fakeSource{}
	svc := mustService(t, src)
	if _, err := svc.Aggregate(context.Background(), "2026-03-05", "2026-03-01", ""); err == nil {
		t.Fatal("期望报错")
	}
	if src.calls != 0 {
		t.Fatalf("非法区间仍调用了数据源 %d 次", src.calls)
	}
}

// --- 聚合 ---

func TestAggregateSortsAndTotals(t *testing.T) {
	src := &fakeSource{rows: []Row{
		{Day: "2026-03-02", UserID: "u1", ProjectID: "p1", CostType: "llm.tokens", Qty: 3, CostUSD: 0.3, Tokens: 30},
		{Day: "2026-03-01", UserID: "u2", ProjectID: "p1", CostType: "llm.tokens", Qty: 1, CostUSD: 0.1, Tokens: 10},
		{Day: "2026-03-01", UserID: "u1", ProjectID: "p1", CostType: "connector.call", Qty: 2, CostUSD: 0.2, Tokens: 0},
	}}
	svc := mustService(t, src)

	got, err := svc.Aggregate(context.Background(), "2026-03-01", "2026-03-02", "p1")
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}

	wantOrder := []string{"2026-03-01/connector.call", "2026-03-01/llm.tokens", "2026-03-02/llm.tokens"}
	var gotOrder []string
	for _, r := range got.Rows {
		gotOrder = append(gotOrder, r.Day+"/"+r.CostType)
	}
	if strings.Join(gotOrder, ",") != strings.Join(wantOrder, ",") {
		t.Errorf("顺序 = %v，期望 %v", gotOrder, wantOrder)
	}

	if got.Totals.Qty != 6 || got.Totals.Tokens != 40 {
		t.Errorf("合计 qty/tokens = %v/%v，期望 6/40", got.Totals.Qty, got.Totals.Tokens)
	}
	if diff := got.Totals.CostUSD - 0.6; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("合计 cost_usd = %v，期望 0.6", got.Totals.CostUSD)
	}
	if got.From != "2026-03-01" || got.To != "2026-03-02" || got.ProjectID != "p1" {
		t.Errorf("回显区间 = %s..%s project=%s", got.From, got.To, got.ProjectID)
	}
}

// 空区间必须序列化成 []，不是 null：调用方少一个分支，也少一次无意义的争论。
func TestEmptyResultSerialisesAsArray(t *testing.T) {
	svc := mustService(t, &fakeSource{})
	got, err := svc.Aggregate(context.Background(), "2026-03-01", "2026-03-01", "")
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if got.Rows == nil {
		t.Fatal("Rows 是 nil，期望空切片")
	}
	blob, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(blob), `"rows":[]`) {
		t.Errorf("JSON 未包含 \"rows\":[]：%s", blob)
	}
}

func TestAggregatePropagatesSourceError(t *testing.T) {
	sentinel := errors.New("connection refused")
	svc := mustService(t, &fakeSource{err: sentinel})
	_, err := svc.Aggregate(context.Background(), "2026-03-01", "2026-03-01", "")
	if !errors.Is(err, sentinel) {
		t.Fatalf("错误未透传: %v", err)
	}
	// 数据源故障绝不能伪装成区间非法 —— 否则 HTTP 层会报 400。
	if errors.Is(err, ErrInvalidRange) {
		t.Fatal("数据源故障被错误地判定为 ErrInvalidRange")
	}
}

func TestSortRowsIsStableOnFullKey(t *testing.T) {
	rows := []Row{
		{Day: "2026-03-01", ProjectID: "p2", UserID: "u1", CostType: "a"},
		{Day: "2026-03-01", ProjectID: "p1", UserID: "u2", CostType: "a"},
		{Day: "2026-03-01", ProjectID: "p1", UserID: "u1", CostType: "b"},
		{Day: "2026-03-01", ProjectID: "p1", UserID: "u1", CostType: "a"},
	}
	SortRows(rows)
	var got []string
	for _, r := range rows {
		got = append(got, fmt.Sprintf("%s/%s/%s", r.Day, r.ProjectID, r.UserID))
	}
	want := "2026-03-01/p1/u1,2026-03-01/p1/u1,2026-03-01/p1/u2,2026-03-01/p2/u1"
	if strings.Join(got, ",") != want {
		t.Errorf("顺序 = %v，期望 %s", got, want)
	}
}

// --- HTTP ---

func TestAggregateHandler(t *testing.T) {
	sentinel := errors.New("pg: 连接池耗尽")
	cases := []struct {
		name       string
		query      string
		srcErr     error
		wantStatus int
		wantBody   string // 非空时要求响应体包含该片段
	}{
		{"正常", "?from=2026-03-01&to=2026-03-02&project_id=p1", nil, http.StatusOK, `"totals"`},
		{"缺少 from", "?to=2026-03-02", nil, http.StatusBadRequest, "from 与 to 必填"},
		{"缺少 to", "?from=2026-03-01", nil, http.StatusBadRequest, "from 与 to 必填"},
		{"格式错", "?from=2026-3-1&to=2026-03-02", nil, http.StatusBadRequest, "YYYY-MM-DD"},
		{"to 早于 from", "?from=2026-03-05&to=2026-03-01", nil, http.StatusBadRequest, "早于"},
		{"跨度超限", "?from=2020-01-01&to=2021-01-01", nil, http.StatusBadRequest, "上限"},
		// 数据库故障必须是 500：报成 400 会让调用方以为是自己参数写错了，于是不看告警。
		{"数据源故障", "?from=2026-03-01&to=2026-03-02", sentinel, http.StatusInternalServerError, "用量查询失败"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := &fakeSource{err: tc.srcErr, rows: []Row{
				{Day: "2026-03-01", UserID: "u1", ProjectID: "p1", CostType: "llm.tokens", Qty: 1, CostUSD: 0.1, Tokens: 10},
			}}
			svc := mustService(t, src)
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/v1/usage/aggregate"+tc.query, nil)
			svc.AggregateHandler()(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("状态码 = %d，期望 %d，响应体 %s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
			if tc.wantBody != "" && !strings.Contains(rec.Body.String(), tc.wantBody) {
				t.Errorf("响应体 %s 不含 %q", rec.Body.String(), tc.wantBody)
			}
			// 参数非法时不该触达数据源。
			if tc.wantStatus == http.StatusBadRequest && src.calls != 0 {
				t.Errorf("400 响应仍调用了数据源 %d 次", src.calls)
			}
		})
	}
}

func TestAggregateHandlerPassesProjectID(t *testing.T) {
	src := &fakeSource{}
	svc := mustService(t, src)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/usage/aggregate?from=2026-03-01&to=2026-03-01&project_id=p9", nil)
	svc.AggregateHandler()(rec, req)

	if src.proj != "p9" {
		t.Errorf("透传的 project_id = %q，期望 p9", src.proj)
	}
	if src.from != "2026-03-01" || src.to != "2026-03-01" {
		t.Errorf("透传区间 = %s..%s", src.from, src.to)
	}
}

// 不带 project_id 表示「全部项目」，而不是「项目名为空」。
func TestAggregateHandlerOmitsProjectID(t *testing.T) {
	src := &fakeSource{}
	svc := mustService(t, src)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/usage/aggregate?from=2026-03-01&to=2026-03-01", nil)
	svc.AggregateHandler()(rec, req)

	if src.proj != "" {
		t.Errorf("未指定 project_id 时透传了 %q，期望空串（全部项目）", src.proj)
	}
}
