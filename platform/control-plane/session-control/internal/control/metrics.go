// 控制面的进程内指标累积器。
//
// # 为什么是进程内累积而不是抓取时查库
//
// `/metrics` 是被周期性抓取的，在抓取路径上做数据库查询等于让「指标可抓取」依赖
// 数据库可用：库一慢，抓取超时，Prometheus 把整个实例标成 down——一次库抖动升级成
// 「这个实例的所有指标同时消失」。所以计数在裁决路径上顺手累加，后台循环只做发布。
//
// # 为什么用 ReplaceGauges 而不是增量写
//
// 维度（outcome × command）会消失：某个指令再没人用过之后，它的序列必须跟着消失，
// 否则面板上会永远停在最后一次的值上（见 observability.ReplaceGauges）。因此每次
// 发布把**当前完整集合**整体写下去，而不是逐条 SetGauge。
//
// # 标签基数是可控的
//
// outcome 六种、command 八种，乘积上限 48 条序列，都来自代码里的闭集常量，没有
// 任何外部输入进来（尤其**不是**按 session_ref 下钻——那是无界的）。累计值从进程
// 启动起算：重启归零是普罗米修斯计数器的正常语义。
package control

import (
	"sync"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/session-control/internal/state"
)

// 控制面导出的指标名。集中成常量是因为 platform/deploy/alerts-verify.sh 要拿
// 告警表达式里的名字回来核对「这个名字真的有人写」。
const (
	// MetricCommands 按 outcome × command 下钻的控制指令计数。
	MetricCommands = "lumo_session_control_commands"
	// MetricQueueInflight 正在生效中的脉冲数（全部会话求和）。
	MetricQueueInflight = "lumo_session_control_queue_inflight"
	// MetricQueueWaiting 排队等待中的脉冲数（全部会话求和）。
	MetricQueueWaiting = "lumo_session_control_queue_waiting"
	// MetricForcedReleases 被强制接管的脉冲累计数（持有时长超过 MaxHold）。
	//
	// 这是「队列在被堵」的唯一历史证据：当前积压深度只反映此刻，而强制接管是
	// 「有人卡住过」的既成事实。它的值单调递增（进程内累计）。
	MetricForcedReleases = "lumo_session_control_forced_releases_total"
	// MetricDispatchFailures 已记录但下发失败的次数（见 control 包的顺序取舍）。
	//
	// 它对应的是「状态行说 paused，会话还在跑」这一类需要人工对账的现场，
	// 因此必须能告警，而不是只留在日志里。
	MetricDispatchFailures = "lumo_session_control_dispatch_failures_total"
	// MetricRealmMismatch 跨 realm 被拒的次数。这类尝试**不入审计表**
	// （理由见 control.decide），所以它必须在这里与 WARN 日志里各留一份痕迹。
	MetricRealmMismatch = "lumo_session_control_realm_mismatch_total"
)

type outcomeKey struct {
	outcome Outcome
	command state.Command
}

// accumulator 是全局累积器。用包级变量而不是让调用方持有：裁决器与队列回调是
// 两条独立装配路径（main 里分别构造），共用一个累积器比把同一个对象传两遍更难漏。
var accumulator = &metricAccumulator{counts: map[outcomeKey]int64{}}

type metricAccumulator struct {
	mu       sync.Mutex
	counts   map[outcomeKey]int64
	forced   int64
	dispatch int64
	realm    int64
}

// ObserveOutcome 累加一条裁决结论。
func ObserveOutcome(outcome Outcome, command state.Command) {
	accumulator.mu.Lock()
	defer accumulator.mu.Unlock()
	accumulator.counts[outcomeKey{outcome, command}]++
	// 越权尝试的单独计数与上面的分维度计数在**同一把锁**内累加：分两次加锁会让
	// 两次读取之间出现「分维度已加、总数还没加」的窗口，对账时对不上。
	if outcome == OutcomeRealmMismatch {
		accumulator.realm++
	}
}

// ObserveDispatchFailure 累加一次下发失败（已记录、未生效）。
func ObserveDispatchFailure(command state.Command) {
	accumulator.mu.Lock()
	accumulator.dispatch++
	accumulator.mu.Unlock()
}

// ObserveForcedRelease 累加一次强制接管。队列在构造时把它注册成回调
// （queue.Manager.OnForceRelease），因此它不需要控制面额外轮询。
func ObserveForcedRelease(_, _ string, _ time.Duration) {
	accumulator.mu.Lock()
	accumulator.forced++
	accumulator.mu.Unlock()
}

// QueueDepthFunc 返回当前队列的两项聚合深度。由 main 用 queue.Manager 实现：
// 聚合在队列侧做（那里知道有哪些会话），指标层只发布。
type QueueDepthFunc func() (inflight, waiting int)

// PublishMetrics 把累积值写进 /metrics。后台循环调用，抓取路径不碰它。
func PublishMetrics(queueDepth QueueDepthFunc) {
	accumulator.mu.Lock()
	points := make([]observability.GaugePoint, 0, len(accumulator.counts))
	for key, value := range accumulator.counts {
		points = append(points, observability.GaugePoint{
			Labels: map[string]string{
				"outcome": string(key.outcome),
				"command": string(key.command),
			},
			Value: float64(value),
		})
	}
	forced := float64(accumulator.forced)
	dispatch := float64(accumulator.dispatch)
	realm := float64(accumulator.realm)
	accumulator.mu.Unlock()

	observability.ReplaceGauges(MetricCommands, points)
	observability.SetGauge(MetricForcedReleases, forced)
	observability.SetGauge(MetricDispatchFailures, dispatch)
	observability.SetGauge(MetricRealmMismatch, realm)

	if queueDepth != nil {
		inflight, waiting := queueDepth()
		observability.SetGauge(MetricQueueInflight, float64(inflight))
		observability.SetGauge(MetricQueueWaiting, float64(waiting))
	}
}
