package observability

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestMiddlewareExportsRequestAndErrorCounters(t *testing.T) {
	m := &Metrics{}
	h := m.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))

	rec := httptest.NewRecorder()
	m.Write(rec)
	body := rec.Body.String()
	for _, metric := range []string{
		"lumo_http_requests_total 1",
		"lumo_http_errors_total 1",
		"lumo_http_inflight 0",
		"# TYPE lumo_http_request_duration_seconds histogram",
		"lumo_http_request_duration_seconds_count 1",
	} {
		if !strings.Contains(body, metric) {
			t.Fatalf("metrics missing %q in %s", metric, body)
		}
	}
}

func TestMiddlewareUsesConfiguredCORSOrigin(t *testing.T) {
	t.Setenv("LUMO_CORS_ORIGIN", "http://console.example")
	h := (&Metrics{}).Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://console.example" {
		t.Fatalf("origin = %q", got)
	}

	preflight := httptest.NewRecorder()
	h.ServeHTTP(preflight, httptest.NewRequest(http.MethodOptions, "/v1/projects", nil))
	if preflight.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", preflight.Code)
	}
	if got := os.Getenv("LUMO_CORS_ORIGIN"); got != "http://console.example" {
		t.Fatalf("test environment unexpectedly changed: %q", got)
	}
}

// isolatedDefault 把全局 Default 的 gauge 表与基数上限换成干净的一份，并在用例
// 结束时还原。手动采集的 gauge 是进程级状态，测试之间必须隔离，否则「序列被
// 丢弃」这类断言会依赖用例的执行顺序。
func isolatedDefault(t *testing.T) {
	t.Helper()
	Default.gaugeMu.Lock()
	previousGauges := Default.gauges
	Default.gauges = make(map[string]gaugeSeries)
	Default.gaugeMu.Unlock()
	previousDropped := Default.droppedGauges.Swap(0)
	previousLimit := defaultMetricCardinalityLimit.Load()
	t.Cleanup(func() {
		Default.gaugeMu.Lock()
		Default.gauges = previousGauges
		Default.gaugeMu.Unlock()
		Default.droppedGauges.Store(previousDropped)
		defaultMetricCardinalityLimit.Store(previousLimit)
	})
}

func renderDefaultMetrics(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	Default.Write(rec)
	return rec.Body.String()
}

func TestGaugeLabelsAreSortedEscapedAndStable(t *testing.T) {
	isolatedDefault(t)
	SetGaugeWithLabels("lumo_scheduler_pending_tasks", 3, map[string]string{"cluster_id": "cn-north", "state": "pending"})
	// 同一组标签、不同的 map 字面量顺序，必须落成同一个 key，而不是两条序列。
	SetGaugeWithLabels("lumo_scheduler_pending_tasks", 3, map[string]string{"state": "pending", "cluster_id": "cn-north"})
	SetGaugeWithLabels("lumo_scheduler_pending_tasks", 1, map[string]string{"state": "running", "cluster_id": "cn-north"})
	// 连接器 id 是外部数据，含引号与反斜杠时必须转义而不是把响应拼坏。
	SetGaugeWithLabels("lumo_connector_breaker_open", 1, map[string]string{"connector": `a"b\c`})

	first := renderDefaultMetrics(t)
	for _, want := range []string{
		`lumo_scheduler_pending_tasks{cluster_id="cn-north",state="pending"} 3`,
		`lumo_scheduler_pending_tasks{cluster_id="cn-north",state="running"} 1`,
		`lumo_connector_breaker_open{connector="a\"b\\c"} 1`,
	} {
		if !strings.Contains(first, want) {
			t.Fatalf("metrics missing %q in:\n%s", want, first)
		}
	}
	if n := strings.Count(first, `lumo_scheduler_pending_tasks{cluster_id="cn-north",state="pending"} 3`); n != 1 {
		t.Fatalf("同一组标签应落成一条序列，实际出现 %d 次:\n%s", n, first)
	}
	// 一个名字只打一次 TYPE，其下序列相邻——重复 TYPE 行会让抓取端把它当成
	// 两个不同的 metric family。
	if n := strings.Count(first, "# TYPE lumo_scheduler_pending_tasks gauge"); n != 1 {
		t.Fatalf("TYPE 行应只出现一次，实际 %d:\n%s", n, first)
	}
	// map 迭代顺序随机会让每次抓取的行序都不同；渲染必须逐字节稳定，否则
	// 「同一序列是否出现过」无法用文本比对确认。
	for i := 0; i < 20; i++ {
		if got := renderDefaultMetrics(t); got != first {
			t.Fatalf("第 %d 次渲染不稳定:\n--- 首次\n%s\n--- 本次\n%s", i, first, got)
		}
	}
}

func TestGaugeCardinalityCountsSeriesNotNames(t *testing.T) {
	isolatedDefault(t)
	SetMetricCardinalityLimit(3)
	// 同一个名字下的三条标签集就是三条序列，正好占满预算：预算按 Prometheus
	// 实际存储与抓取载荷里的东西扣，而不是按名字扣。
	SetGaugeWithLabels("lumo_scheduler_tasks", 1, map[string]string{"state": "pending"})
	SetGaugeWithLabels("lumo_scheduler_tasks", 2, map[string]string{"state": "running"})
	SetGaugeWithLabels("lumo_scheduler_tasks", 3, map[string]string{"state": "failed"})
	SetGaugeWithLabels("lumo_scheduler_tasks", 4, map[string]string{"state": "completed"})

	body := renderDefaultMetrics(t)
	if !strings.Contains(body, `lumo_scheduler_tasks{state="pending"} 1`) {
		t.Fatalf("已建立的序列不应被后来的超限写挤掉:\n%s", body)
	}
	if strings.Contains(body, `state="completed"`) {
		t.Fatalf("超限序列必须被丢弃:\n%s", body)
	}
	if !strings.Contains(body, "lumo_observability_metric_series_dropped_total 1") {
		t.Fatalf("丢弃必须可观测，否则「告警为什么不响」无从查起:\n%s", body)
	}
	// 已存在的序列仍可更新：预算限制的是新序列，不是更新。
	SetGaugeWithLabels("lumo_scheduler_tasks", 9, map[string]string{"state": "pending"})
	if !strings.Contains(renderDefaultMetrics(t), `lumo_scheduler_tasks{state="pending"} 9`) {
		t.Fatal("已存在的序列必须仍可更新")
	}
}

func TestGaugeLabelsAreCopiedFromTheCallerMap(t *testing.T) {
	isolatedDefault(t)
	// 调用方复用同一个 map 逐个更新多条序列是常态。渲染出的标签片段是当次快照，
	// 但 OTLP 侧的 attrs 若直接存引用，先写入的序列会跟着被改掉——表现为
	// 「cn-north 那条指标带着 cn-south 的属性」。只断言文本输出抓不到它。
	labels := map[string]string{"cluster_id": "cn-north"}
	SetGaugeWithLabels("lumo_scheduler_nodes", 3, labels)
	labels["cluster_id"] = "cn-south"
	SetGaugeWithLabels("lumo_scheduler_nodes", 1, labels)

	body := renderDefaultMetrics(t)
	if !strings.Contains(body, `lumo_scheduler_nodes{cluster_id="cn-north"} 3`) {
		t.Fatalf("先写入的序列被调用方的 map 复用改掉了:\n%s", body)
	}
	if !strings.Contains(body, `lumo_scheduler_nodes{cluster_id="cn-south"} 1`) {
		t.Fatalf("第二条序列丢失:\n%s", body)
	}
	Default.gaugeMu.RLock()
	series := make([]gaugeSeries, 0, len(Default.gauges))
	for _, s := range Default.gauges {
		series = append(series, s)
	}
	Default.gaugeMu.RUnlock()
	if len(series) != 2 {
		t.Fatalf("应落成两条序列，实际 %d", len(series))
	}
	// 不变量：同一条序列在两条导出路径上的维度必须一致。文本侧断言已把两个
	// 取值钉死，这里再钉住 attrs 与它相符，别名污染就无处可藏。
	for _, s := range series {
		if !strings.Contains(s.labels, `cluster_id="`+s.attrs["cluster_id"]+`"`) {
			t.Fatalf("序列 %s 的 OTLP 属性与渲染标签不一致（被调用方后续修改污染）: %v", s.labels, s.attrs)
		}
	}
}

func TestGaugeRejectsInvalidNamesAndCountsThemAsDropped(t *testing.T) {
	isolatedDefault(t)
	SetGaugeWithLabels("lumo bad name", 1, nil)
	SetGaugeWithLabels("lumo_ok", 1, map[string]string{"cluster id": "x"})
	SetGaugeWithLabels("lumo_ok", 1, map[string]string{"cluster_id": "x"})

	body := renderDefaultMetrics(t)
	if !strings.Contains(body, `lumo_ok{cluster_id="x"} 1`) {
		t.Fatalf("合法标签名不应被误拒:\n%s", body)
	}
	if strings.Contains(body, "lumo bad name") || strings.Contains(body, "cluster id") {
		t.Fatalf("非法名字/标签名必须拒收，不能让外部输入拼进响应:\n%s", body)
	}
	// 两类拒收（格式非法、基数超限）在下游看起来完全一样——指标就是不见了，
	// 所以必须计入同一个计数器，不能只对其中一类计数。
	if !strings.Contains(body, "lumo_observability_metric_series_dropped_total 2") {
		t.Fatalf("格式非法的序列也必须计入丢弃:\n%s", body)
	}
}

func TestReplaceGaugesDropsVanishedDimensions(t *testing.T) {
	isolatedDefault(t)
	ReplaceGauges("lumo_scheduler_tasks", []GaugePoint{
		{Labels: map[string]string{"state": "PENDING", "cluster_id": "cn-north"}, Value: 100},
		{Labels: map[string]string{"state": "PENDING", "cluster_id": "cn-south"}, Value: 2},
	})
	if body := renderDefaultMetrics(t); !strings.Contains(body, `cluster_id="cn-south",state="PENDING"} 2`) {
		t.Fatalf("首次发布应写出两条序列:\n%s", body)
	}
	// cn-south 的队列清空了：它的序列必须**消失**。增量写入做不到这件事——
	// 序列会永远停在 100 上，对应的排队告警永不解除。
	ReplaceGauges("lumo_scheduler_tasks", []GaugePoint{
		{Labels: map[string]string{"state": "PENDING", "cluster_id": "cn-north"}, Value: 0},
	})
	body := renderDefaultMetrics(t)
	if strings.Contains(body, "cn-south") {
		t.Fatalf("消失的维度必须从抓取结果里消失:\n%s", body)
	}
	if !strings.Contains(body, `cluster_id="cn-north",state="PENDING"} 0`) {
		t.Fatalf("保留的维度应更新为新值:\n%s", body)
	}
	if strings.Contains(body, "} 100") {
		t.Fatalf("旧值不应残留:\n%s", body)
	}
}

func TestReplaceGaugesOnlyTouchesItsOwnName(t *testing.T) {
	isolatedDefault(t)
	SetGauge("lumo_scheduler_leader", 1)
	ReplaceGauges("lumo_scheduler_tasks", []GaugePoint{{Labels: map[string]string{"state": "PENDING"}, Value: 1}})
	// 空集合 = 该名字下的序列全部撤下，但别人的序列必须原样留着。
	ReplaceGauges("lumo_scheduler_tasks", nil)
	body := renderDefaultMetrics(t)
	if strings.Contains(body, "lumo_scheduler_tasks") {
		t.Fatalf("空集合应撤下该名字的全部序列:\n%s", body)
	}
	if !strings.Contains(body, "lumo_scheduler_leader 1") {
		t.Fatalf("整体替换不能波及其它名字:\n%s", body)
	}
}

func TestReplaceGaugesDoesNotDoubleCountDuplicateLabels(t *testing.T) {
	isolatedDefault(t)
	SetMetricCardinalityLimit(1)
	// 同一批里重复的 (name,labels) 只占一个预算位；先摘后写正是为此。
	ReplaceGauges("lumo_scheduler_tasks", []GaugePoint{
		{Labels: map[string]string{"state": "PENDING"}, Value: 1},
		{Labels: map[string]string{"state": "PENDING"}, Value: 7},
	})
	body := renderDefaultMetrics(t)
	if !strings.Contains(body, `lumo_scheduler_tasks{state="PENDING"} 7`) {
		t.Fatalf("同一标签集应只留一条序列（后者胜）:\n%s", body)
	}
	if !strings.Contains(body, "lumo_observability_metric_series_dropped_total 0") {
		t.Fatalf("重复标签集不该被算作丢弃:\n%s", body)
	}
}

func TestReplaceGaugesDropsOnlyTheInvalidPoint(t *testing.T) {
	isolatedDefault(t)
	ReplaceGauges("lumo_scheduler_tasks", []GaugePoint{
		{Labels: map[string]string{"state": "PENDING"}, Value: 1},
		{Labels: map[string]string{"state bad": "PENDING"}, Value: 2},
	})
	body := renderDefaultMetrics(t)
	if !strings.Contains(body, `lumo_scheduler_tasks{state="PENDING"} 1`) {
		t.Fatalf("一条非法不应拖垮整批:\n%s", body)
	}
	if !strings.Contains(body, "lumo_observability_metric_series_dropped_total 1") {
		t.Fatalf("被拒的那条必须计入丢弃:\n%s", body)
	}
}
