// LLM 网关的预算指标（§7.4.2 的 budget_overrun）。
package server

import (
	"context"
	"net/http"
	"time"

	"github.com/lumo-harness/platform/llm-gateway/internal/store"
	"github.com/lumo-harness/platform/observability"
)

// 预算指标名。见 platform/deploy/alerts-verify.sh：告警表达式里引用的名字必须
// 真的有人写，所以名字集中成常量而不是散落的字面量。
const (
	// MetricBudgetTrees 该 kind 的预算树总数，是 Denied 的分母。
	MetricBudgetTrees = "lumo_budget_trees"
	// MetricBudgetTreesDenied 处在 hard 档（新请求会被拒）的预算树数。
	MetricBudgetTreesDenied = "lumo_budget_trees_denied"

	// MetricBatchWaiting 当前在汇聚窗口里等待放行的请求数。
	//
	// 这是批处理**唯一**值得告警的信号：它长期贴在 `MaxBatch` 上，说明上游吃
	// 不下（批已经攒满但放不出去），而这正是「并发越高吞吐越低」的起点。
	MetricBatchWaiting = "lumo_llm_batch_waiting"

	// MetricBatchReleased 已放行的批数（单调递增）。
	//
	// 仓库只暴露 gauge，所以它是「单调 gauge」而不是 counter——按 counter 语义
	// 用 `increase()` 读它在数值上成立，但请优先看 waiting。
	MetricBatchReleased = "lumo_llm_batch_released"

	// MetricBatchWindowSeconds 生效的汇聚窗口（秒）。0 = 关闭。
	//
	// 存在的理由不是「好看」，而是让「配了但没生效」可查：TTFT 回归时第一个要
	// 回答的问题就是「汇聚到底开着没有」。
	MetricBatchWindowSeconds = "lumo_llm_batch_window_seconds"
)

// budgetMetricsTTL 预算计数的缓存时长。
//
// 抓取是 15s 级的，而这是一次全表聚合：不缓存等于把查询频率绑死在抓取频率上，
// 表随租户数增长后这条代价会一直涨。顺带把「metering 表不存在」这类持续失败
// 收敛成每 TTL 一条日志，而不是每个抓取周期刷一条。
const budgetMetricsTTL = 30 * time.Second

// budgetCounts 带 TTL 的预算树计数。失败结果也缓存，理由同上（日志与查询频率）。
func (s *Server) budgetCounts(ctx context.Context) ([]store.BudgetTreeCount, error) {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()
	if !s.budgetAt.IsZero() && time.Since(s.budgetAt) < budgetMetricsTTL {
		return s.budgetCached, s.budgetErr
	}
	counts, err := s.store.BudgetTreeCounts(ctx)
	s.budgetAt, s.budgetCached, s.budgetErr = time.Now(), counts, err
	return counts, err
}

// publishBudgetMetrics 导出预算树的两档计数。
//
// 只导出 hard 档，不导出 soft / overdraft：domain.IsAllowed 明确「hard 之外都放行」，
// 透支是「放行且记账」而不是拒绝。把 soft/overdraft 也做成告警会制造一类
// 「告警响了但什么都没坏」的噪声，而这类噪声正是值班开始忽略告警的起点。
// 分档明细在用量分析接口里按需查，不进指标。
//
// 查询失败时**不发布**，于是上一轮的序列停在原地。这是刻意的：陈旧的值会让
// 告警多响一会儿（噪声），而撤下序列会让告警静默解除（漏报）。对监控来说，
// 噪声可查、漏报不可查。
func (s *Server) publishBudgetMetrics(ctx context.Context) {
	if s.store == nil {
		return
	}
	counts, err := s.budgetCounts(ctx)
	if err != nil {
		// budget_trees 由 TS metering 插件建表，缺表意味着本部署没启用计量，
		// 不是故障——记录后跳过，不让抓取路径失败。
		s.log.Warn("采集预算树指标失败", "err", err)
		return
	}
	total := make([]observability.GaugePoint, 0, len(counts))
	denied := make([]observability.GaugePoint, 0, len(counts))
	for _, row := range counts {
		labels := map[string]string{"kind": row.Kind}
		total = append(total, observability.GaugePoint{Labels: labels, Value: float64(row.Total)})
		denied = append(denied, observability.GaugePoint{Labels: labels, Value: float64(row.Denied)})
	}
	// 整体替换：某个 kind 的树全部被删掉时序列要跟着消失，否则分母会永远停在
	// 一个不存在的数字上。
	observability.ReplaceGauges(MetricBudgetTrees, total)
	observability.ReplaceGauges(MetricBudgetTreesDenied, denied)
}

// publishBatchMetrics 导出批处理汇聚的状态。
//
// 未装配汇聚器（或窗口为 0）时**照样导出**：窗口那条要能被读到 0，否则「关闭」
// 与「指标没接上」在监控上长得一样，而这正是本轮要消除的那类盲区。另外两条在
// 未装配时为零值——它们没有独立的含义，不必造一个「不可用」的第四种表达。
func (s *Server) publishBatchMetrics() {
	if s.coalescer == nil {
		observability.SetGauge(MetricBatchWindowSeconds, 0)
		return
	}
	waiting, released := s.coalescer.Stats()
	observability.SetGauge(MetricBatchWaiting, float64(waiting))
	observability.SetGauge(MetricBatchReleased, float64(released))
	observability.SetGauge(MetricBatchWindowSeconds, s.coalescer.Config().Window.Seconds())
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	s.publishBudgetMetrics(r.Context())
	s.publishBatchMetrics()
	observability.Handler(w, nil)
}
