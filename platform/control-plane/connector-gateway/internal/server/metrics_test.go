package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/observability"
)

// openBreaker 把某个 key 的熔断器驱动到 open。
func openBreaker(t *testing.T, group *breaker.Group, key string) {
	t.Helper()
	b := group.Get(key)
	for i := 0; i < 2; i++ {
		allowed, done, _ := b.Allow()
		if !allowed {
			t.Fatalf("第 %d 次调用不应被熔断拦截（窗口尚未判定）", i)
		}
		done(false)
	}
	if state := b.State(); state != breaker.StateOpen {
		t.Fatalf("连续失败后应打开，实际 %s", state)
	}
}

func testBreakerConfig(now func() time.Time) breaker.Config {
	return breaker.Config{
		Window: time.Minute, MinRequests: 2, FailureRatio: 0.5,
		OpenFor: 30 * time.Second, HalfOpenProbes: 1, Now: now,
	}
}

// renderMetrics 读一次全局 /metrics 响应。熔断指标与进程内计数器同源
// （observability.Default），所以直接从导出面断言。
func renderMetrics(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	observability.Handler(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	return rec.Body.String()
}

// TestPublishBreakerMetricsOnlyExportsNonClosed 钉住的是基数：序列数必须与
// 「有问题的熔断器数」成正比，而不是与连接器总数成正比。指标层有 128 条序列的
// 上限，按连接器全量导出会在连接器多的部署上把预算吃光，而一旦「打开的那条
// 序列」被基数上限丢掉，告警就静默失效了。
func TestPublishBreakerMetricsOnlyExportsNonClosed(t *testing.T) {
	group := breaker.NewGroup(testBreakerConfig(nil))
	openBreaker(t, group, "r1/broken")
	group.Get("r1/healthy") // 存在但从未失败 → closed，不该产生序列

	publishBreakerMetrics(group)
	body := renderMetrics(t)

	if !strings.Contains(body, `lumo_connector_breaker_open{breaker="r1/broken"} 1`) {
		t.Fatalf("打开的熔断器必须导出:\n%s", body)
	}
	if strings.Contains(body, `breaker="r1/healthy"`) {
		t.Fatalf("闭合的熔断器不该占用基数预算:\n%s", body)
	}
	if !strings.Contains(body, "lumo_connector_breakers_total 2") {
		t.Fatalf("总数是「没有序列」这个结论的分母，必须导出:\n%s", body)
	}
}

func TestPublishBreakerMetricsExportsHalfOpenSeparately(t *testing.T) {
	now := time.Now()
	group := breaker.NewGroup(testBreakerConfig(func() time.Time { return now }))
	openBreaker(t, group, "r1/recovering")

	// 过了 OpenFor 之后状态转为 half-open（试探放行）。半开是「上游还没好」的
	// 持续状态，与 open 的处置不同，必须能分开看。
	now = now.Add(31 * time.Second)
	publishBreakerMetrics(group)
	body := renderMetrics(t)

	if !strings.Contains(body, `lumo_connector_breaker_half_open{breaker="r1/recovering"} 1`) {
		t.Fatalf("半开状态必须单独导出:\n%s", body)
	}
	if strings.Contains(body, `lumo_connector_breaker_open{breaker="r1/recovering"}`) {
		t.Fatalf("半开时不应同时留在 open 序列上:\n%s", body)
	}
}

// TestPublishBreakerMetricsClearsSeriesWhenHealthy 是整体替换而非增量写入的理由：
// 熔断器恢复后序列必须**消失**。增量写入会让它永远停在 1 上，seam_circuit_open
// 告警因此永不解除——一次上游抖动会留下一个永久告警。
func TestPublishBreakerMetricsClearsSeriesWhenHealthy(t *testing.T) {
	group := breaker.NewGroup(testBreakerConfig(nil))
	openBreaker(t, group, "r1/broken")
	publishBreakerMetrics(group)
	if body := renderMetrics(t); !strings.Contains(body, "lumo_connector_breaker_open") {
		t.Fatalf("前置条件不成立，打开态未导出:\n%s", body)
	}

	// 换一个干净的组：等价于全部熔断器恢复闭合。
	publishBreakerMetrics(breaker.NewGroup(testBreakerConfig(nil)))
	body := renderMetrics(t)
	if strings.Contains(body, "lumo_connector_breaker_open{") {
		t.Fatalf("恢复后序列必须消失，否则告警永不解除:\n%s", body)
	}
	if !strings.Contains(body, "lumo_connector_breakers_total 0") {
		t.Fatalf("总数应落回 0:\n%s", body)
	}
}

func TestPublishBreakerMetricsToleratesMissingGroup(t *testing.T) {
	// 网关可以在没有熔断器的情况下装配（Options.Breakers 可选）；指标路径不能
	// 因此 panic，也不该凭空造出序列。
	publishBreakerMetrics(nil)
	if body := renderMetrics(t); strings.Contains(body, "lumo_connector_breaker_open{") {
		t.Fatalf("没有熔断器组时不该有 per-breaker 序列:\n%s", body)
	}
}
