// 连接器网关的熔断指标（§7.4.2 的 seam_circuit_open）。
package server

import (
	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/observability"
)

// 熔断指标名。见 platform/deploy/alerts-verify.sh：告警表达式里引用的名字必须
// 真的有人写，所以名字集中成常量而不是散落的字面量。
const (
	// MetricBreakerOpen 处于 open 的熔断器，按 breaker 下钻。
	MetricBreakerOpen = "lumo_connector_breaker_open"
	// MetricBreakerHalfOpen 处于 half-open 的熔断器，按 breaker 下钻。
	MetricBreakerHalfOpen = "lumo_connector_breaker_half_open"
	// MetricBreakersTotal 本实例跟踪的熔断器总数。它是前两个指标的分母。
	MetricBreakersTotal = "lumo_connector_breakers_total"
)

// publishBreakerMetrics 导出本实例的熔断状态。
//
// 熔断状态是**本实例本地**的（见 breaker 包注释：它保护的是本网关自己的
// goroutine 与连接，不需要跨实例共识），所以这里只报本实例看到的，不做跨副本
// 聚合——按副本区分恰好是对的，某个副本的上游链路坏了不该让别的副本一起告警。
//
// **只导出非闭合的熔断器**，这不是省事而是必要的：序列数因此与「有问题的连接器
// 数」成正比，而不是与连接器总数成正比。指标层有 128 条序列的基数上限
// （observability.defaultMetricCardinalityMax），按连接器全量导出会在连接器多的
// 部署上把预算吃光；而一旦「打开的那条序列」恰好被基数上限丢掉，告警就静默
// 失效了——这正是最不能出错的地方。
//
// 代价是「没有序列」同时表示「全部健康」与「这个连接器还没被调用过」，
// 所以额外导出 lumo_connector_breakers_total 当分母：分母为 0 时说明网关根本
// 还没放过流量，此时「没有打开的熔断器」不构成任何证据。
//
// 整体替换而非增量写入：熔断器闭合后序列必须**消失**，否则它会永远停在 1 上，
// 告警永不解除。
func publishBreakerMetrics(group *breaker.Group) {
	if group == nil {
		return
	}
	snapshot := group.Snapshot()
	open := make([]observability.GaugePoint, 0, len(snapshot))
	halfOpen := make([]observability.GaugePoint, 0, len(snapshot))
	for key, state := range snapshot {
		switch state {
		case breaker.StateOpen.String():
			open = append(open, observability.GaugePoint{Labels: map[string]string{"breaker": key}, Value: 1})
		case breaker.StateHalfOpen.String():
			halfOpen = append(halfOpen, observability.GaugePoint{Labels: map[string]string{"breaker": key}, Value: 1})
		}
	}
	observability.ReplaceGauges(MetricBreakerOpen, open)
	observability.ReplaceGauges(MetricBreakerHalfOpen, halfOpen)
	observability.SetGauge(MetricBreakersTotal, float64(len(snapshot)))
}
