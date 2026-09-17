// 放置路径上的两个装配件：亲和输入与版本闸门的可观测。
//
// 为什么单独一个文件：它们都不属于任何一个端点——`handlePlace` 与 main 里的
// `drainOnce` 都要用，而放进行放置端点会让 drain 循环依赖一个 HTTP handler 的
// 私有方法。放在这里，两条路径共用同一份实现，「HTTP 与 drain 的取舍口径一致」
// 才是结构上成立的，而不是靠人记得改两处。
package server

import (
	"context"
	"log/slog"
	"sync"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
)

// PreparePlacement 给一批任务批量填上项目亲和输入（会话亲和，§7.4.1）。
//
// 一次查一批项目而不是逐任务查：drain 循环一轮最多取 32 个 PENDING 任务，逐任务
// 查会把一轮变成 32 次往返，而它们之间本来只需要一条 `= ANY($2)`。
//
// 失败时**不填**（亲和分恒为 0）而不是让放置失败：亲和是**软偏好**，它读不到
// 只会让排序退回纯负载最小——那是完全合法的放置。把一次统计查询的抖动升级成
// 「放置请求 500」，等于让一个优化项获得否决权。
//
// 没有 project_id 的任务直接跳过：它没有会话归属，亲和无从谈起。
// 按 realm 分组后逐组查询：隔离维度只信身份（E7），不能为了少一次往返把
// 别的 realm 的同名项目算进来。
func (s *Server) PreparePlacement(ctx context.Context, tasks []*domain.Task) {
	byRealm := make(map[string][]string)
	seen := make(map[[2]string]struct{})
	for _, t := range tasks {
		if t == nil || t.ProjectID == "" || t.Realm == "" {
			continue
		}
		key := [2]string{t.Realm, t.ProjectID}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		byRealm[t.Realm] = append(byRealm[t.Realm], t.ProjectID)
	}
	if len(byRealm) == 0 {
		return
	}
	counts := make(map[[2]string]map[string]int, len(seen))
	for realm, ids := range byRealm {
		byProject, err := s.store.ActiveClusterCountsByProjects(ctx, realm, ids)
		if err != nil {
			s.log.Warn("采集项目集群分布失败，本轮放置退回纯负载排序", "realm", realm, "err", err)
			continue
		}
		for _, id := range ids {
			counts[[2]string{realm, id}] = byProject[id]
		}
	}
	for _, t := range tasks {
		if t == nil || t.ProjectID == "" {
			continue
		}
		t.ProjectActiveByCluster = counts[[2]string{t.Realm, t.ProjectID}]
	}
}

// PickPrepared 对一个**已经填过亲和输入**的任务做放置决策。
//
// HTTP 放置路径与 main 的 drain 循环**共用**这一个入口，而不是各自拼一遍
// `planner.PickWeighted(...)`。两处各拼一遍的后果是它们会漂移——而漂移的方向恰恰是
// 「drain 里漏掉了亲和输入」，症状是「同一批任务走 HTTP 有偏好、被 drain 接续时没有」，
// 任何测试都很难发现。
func (s *Server) PickPrepared(ctx context.Context, task domain.Task, nodes []domain.Node, active map[string]int) *domain.Node {
	n := planner.PickWeighted(task, nodes, active, s.Weights())
	if n == nil {
		s.reportVersionBlock(ctx, task, nodes)
	}
	return n
}

// Weights 生效的偏好打分权重。零值（没装配过）时用默认值——与 main 里
// 「非法配置拒绝启动」不冲突：那条守的是**配错了的值**，这条守的是**没配**。
func (s *Server) Weights() domain.PlacementWeights {
	if s.placementWeights.Load <= 0 {
		return domain.DefaultPlacementWeights()
	}
	return s.placementWeights
}

// VersionGateEnabled 版本闸门是否生效。
func (s *Server) VersionGateEnabled() bool { return s.versionGate }

// placementStats 放置路径的进程内累积值（同 migrationStats 的理由与形状：
// 计数在裁决路径上顺手累加，抓取只读内存，重启归零是计数器的正常语义）。
//
// 只有一个维度，且**无标签**：cluster_id 是外部输入，按它下钻会让基数跟着部署
// 规模长（同 MetricTaskMigrations 的理由）。
var placementStats = struct {
	mu             sync.Mutex
	versionBlocked int64
}{}

// versionBlockLogged 只在状态**跃迁**时打日志（首次被拦一条 Warn，恢复后再被拦
// 再打一条）。理由同 RunClusterReporter：放置路径是请求驱动的，逐次打日志会让
// 真正要看的那条被刷屏埋掉，而这条恰恰是「滚动升级没做完」的现场证据。
var versionBlockLogged struct {
	mu    sync.Mutex
	state bool
}

// reportVersionBlock 在 Pick 未命中时区分「因为版本分叉在排队」与「因为没容量在排队」。
//
// 为什么必须区分：两者的响应**完全一样**（202 + PENDING），而处置相反——前者去把
// 滚动升级做完（或把闸门关掉），后者去扩容。只看响应分不开，只能靠这里补一条
// 计数与一条日志。这正是本仓库反复强调的那类「两个不同的原因在观测面上长得一样」。
//
// 只在未命中路径上调用，且判据是**上界**（见 planner.VersionBlockedCandidates）。
func (s *Server) reportVersionBlock(ctx context.Context, task domain.Task, nodes []domain.Node) {
	if !s.versionGate {
		return
	}
	blocked := planner.VersionBlockedCandidates(task, nodes)
	if blocked == 0 {
		return
	}
	placementStats.mu.Lock()
	placementStats.versionBlocked++
	placementStats.mu.Unlock()

	versionBlockLogged.mu.Lock()
	first := !versionBlockLogged.state
	versionBlockLogged.state = true
	versionBlockLogged.mu.Unlock()
	if !first {
		return
	}
	vc := domain.VersionConsistency{}
	if s.clusters != nil {
		if clusters, err := s.clusters.ClusterAges(ctx); err == nil {
			vc = domain.EvaluateVersionConsistency(clusters, s.clusterThresholds, s.clusterEnforced)
		}
	}
	s.log.Warn("全局任务因集群版本不一致被版本闸门拦住（已转排队，不是没有容量）",
		"task_id", task.TaskID, "blocked_candidates", blocked,
		"fleet_version", vc.FleetVersion, "declared_clusters", vc.Declared,
		"consistent", vc.Consistent,
		"hint", "把滚动升级做完，或对本次放置显式指定 cluster_id，或关掉 LUMO_CLUSTER_VERSION_GATE")
}

// clearVersionBlock 放置成功时清掉跃迁标记，让下一次被拦重新打一条日志。
func clearVersionBlock() {
	versionBlockLogged.mu.Lock()
	versionBlockLogged.state = false
	versionBlockLogged.mu.Unlock()
}

// publishPlacementMetrics 发布放置路径的累积计数。
//
// **无条件发布**（不依赖任何查询成功）：它是进程内计数，注册表读不到时也依然成立。
// 与 publishMigrationMetrics 同样的位置约定——放在注册表那一块之前，否则
// 「注册表读不到」会顺带把这个数也一起撤下。
func publishPlacementMetrics() {
	placementStats.mu.Lock()
	blocked := placementStats.versionBlocked
	placementStats.mu.Unlock()
	observability.SetGauge(MetricVersionBlocked, float64(blocked))
}

// LogPlacementWeights 把生效的权重与那条不变量打进启动日志。
//
// 权重是可配的，而它的作用只有「候选排序」这一个可观察后果——不写日志的话，
// 「我配了 0.5 但看起来没生效」与「根本没读到我的配置」分不开。边界值一并打出来，
// 因为那才是调参时要看的那个数（见 domain.PlacementWeights.AffinityBound）。
func LogPlacementWeights(log *slog.Logger, w domain.PlacementWeights) {
	log.Info("放置偏好打分权重",
		"load_weight", w.Load, "affinity_weight", w.Affinity,
		"affinity_bound", w.AffinityBound(),
		"meaning", "亲和分最多能翻转这么多负载比差；设为 0 即退回纯负载最小")
}
