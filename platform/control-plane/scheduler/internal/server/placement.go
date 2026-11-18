// 放置路径上的两个装配件：亲和输入与版本闸门的可观测。
//
// 为什么单独一个文件：它们都不属于任何一个端点——`handlePlace` 与 main 里的
// `drainOnce` 都要用，而放进行放置端点会让 drain 循环依赖一个 HTTP handler 的
// 私有方法。放在这里，两条路径共用同一份实现，「HTTP 与 drain 的取舍口径一致」
// 才是结构上成立的，而不是靠人记得改两处。
package server

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// PreparePlacement 给一批任务批量填上项目亲和输入（会话亲和，§7.4.1）。
//
// 一次查一批项目而不是逐任务查：drain 循环一轮取一批 PENDING 任务（LUMO_DRAIN_BATCH，默认 64），逐任务
// 查会把一轮变成几十次往返，而它们之间本来只需要一条 `= ANY($2)`。
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

const (
	// slotReservationHold 抢占腾出的槽为发起者保留多久（自受害者终态落库起算）。
	//
	// 取默认最大退避（30s）的两倍：即使唤醒没轮到它，等待者也至少自然到期一次。
	// 更长只会让「等待者不来取」时槽位空置更久——那种情况（该节点对它已不再合格）
	// 这里分辨不出来，只能靠期限兜底。
	slotReservationHold = 60 * time.Second
	// preemptionStopGrace 一次已送达的停止请求被视为「在途」多久。期间不为同一个
	// 等待者再挑受害者。
	//
	// 要盖得住节点的收尾上限（部署里 stop_grace_period 是 180s），否则正常的慢停止
	// 会被当成「没停下来」而多杀一个；也不能无限长，否则一个永远不回报终态的受害者
	// 会把等待者永久挡住。
	preemptionStopGrace = 5 * time.Minute
)

// reservedView 给出某个任务做放置决策时应当看到的各节点占用数：真实活跃数，
// 加上它无权动用的预留槽位。
//
// 一条预留对两类任务不生效：发起者本人，以及优先级**严格高于**发起者的任务——
// 后者本来就有权拿这个槽（它自己来也会发起抢占），挡住它只会多杀一个。同优先级
// 不放行：槽是为那个具体的等待者腾的，放行等于受害者白死。
//
// 没有任何预留对它生效时直接返回原 map，不复制——这是绝大多数轮次的情况。
func reservedView(task domain.Task, active map[string]int, reservations []store.SlotReservation, served map[string]struct{}) map[string]int {
	var view map[string]int
	for _, r := range reservations {
		if r.WaiterTaskID == task.TaskID || task.Priority > r.WaiterPriority {
			continue
		}
		if _, done := served[r.WaiterTaskID]; done {
			continue
		}
		if view == nil {
			view = make(map[string]int, len(active)+1)
			for node, n := range active {
				view[node] = n
			}
		}
		view[r.NodeID]++
	}
	if view == nil {
		return active
	}
	return view
}

// DrainOptions 一轮接续放置的参数。
type DrainOptions struct {
	Batch      int
	Backoff    time.Duration
	MaxBackoff time.Duration
}

// slotsReleased 相对上一轮是否有节点腾出了槽位。第一轮（没有上一轮）按「有」
// 处理：领导权刚转移时，新 leader 不知道上一任错过了什么。
func slotsReleased(prev, cur map[string]int) bool {
	if prev == nil {
		return true
	}
	for node, n := range prev {
		if cur[node] < n {
			return true
		}
	}
	return false
}

// Drain 一轮接续：取 PENDING → 规划 → 放置。任何一处失败仅记录并等下一轮。
//
// 放置决策走 PreparePlacement + PickPrepared（与 HTTP 放置路径同一份实现）。
//
// 三件事只在这里发生，HTTP 路径给不了：
//   - **槽位释放即重查**：等容量的任务在退避里，而释放是它唯一在等的事件。终态
//     有多个写入方（任意副本的回报端点、治理服务、承载插件），所以不靠通知，
//     而是比较相邻两轮的活跃数；
//   - **抢占重试**：提交时只试一次，之后出现的低优先级占用者与投递失败的停止
//     命令都靠这里再试；
//   - **抢占腾出的槽留给发起者**：取队列的顺序里公平序先于优先级，不预留的话
//     排在前面的低优先级任务会先拿走这个槽（见 reservedView）；
//   - **治理目录按 worker 记忆**：同一轮里同一 worker 只问一次。
func (s *Server) Drain(ctx context.Context, lease *domain.Lease, opts DrainOptions) {
	active, err := s.store.ActiveCounts(ctx)
	if err != nil {
		s.log.Error("活跃计数失败", "err", err)
		return
	}
	s.drainMu.Lock()
	released := slotsReleased(s.drainActive, active)
	s.drainActive = make(map[string]int, len(active))
	for node, n := range active {
		s.drainActive[node] = n
	}
	s.drainMu.Unlock()
	if released {
		if err := s.store.WakeCapacityWaiters(ctx, opts.Batch); err != nil {
			s.log.Warn("唤醒等容量任务失败", "err", err)
		}
	}
	// 预留读不到时按「没有预留」继续，而不是停掉这一轮：预留防的是白杀一个任务，
	// 为它让整个队列停摆是用更大的代价换更小的。必须留日志——这一轮里腾出的槽
	// 可能被别人拿走。
	reservations, err := s.store.SlotReservations(ctx, slotReservationHold)
	if err != nil {
		s.log.Warn("读取槽位预留失败，本轮不做预留", "err", err)
	}
	if len(reservations) > 0 {
		waiters := make([]string, 0, len(reservations))
		for _, r := range reservations {
			waiters = append(waiters, r.WaiterTaskID)
		}
		if err := s.store.WakePending(ctx, waiters); err != nil {
			s.log.Warn("唤醒预留的等待者失败", "err", err)
		}
	}
	served := make(map[string]struct{})
	pending, err := s.store.TakePending(ctx, lease, opts.Batch, opts.Backoff)
	if err != nil {
		s.log.Error("取排队任务失败", "err", err)
		return
	}
	if len(pending) == 0 {
		return
	}
	deferTask := func(taskID, reason string) {
		_ = s.store.DeferPending(ctx, taskID, reason, opts.Backoff, opts.MaxBackoff)
	}
	nodes, err := s.catalog.List(ctx)
	if err != nil {
		s.log.Error("列节点失败", "err", err)
		for _, task := range pending {
			deferTask(task.TaskID, "catalog-unavailable")
		}
		return
	}
	prepared := make([]*domain.Task, 0, len(pending))
	for i := range pending {
		prepared = append(prepared, &pending[i])
	}
	s.PreparePlacement(ctx, prepared)
	type scope struct {
		nodes []domain.Node
		err   error
	}
	scopes := make(map[[3]string]scope)
	for _, task := range pending {
		eligible := nodes
		if task.WorkerID != "" {
			key := [3]string{task.Realm, task.WorkerID, task.ProjectID}
			sc, ok := scopes[key]
			if !ok {
				sc.nodes, sc.err = s.workers.Filter(ctx, task, nodes)
				scopes[key] = sc
			}
			if sc.err != nil {
				s.log.Warn("Worker 设备目录不可用，保留排队任务", "task_id", task.TaskID, "err", sc.err)
				deferTask(task.TaskID, "worker-directory-unavailable")
				continue
			}
			eligible = sc.nodes
		}
		n := s.PickPrepared(ctx, task, eligible, reservedView(task, active, reservations, served))
		if n == nil {
			reason := "no-capacity"
			if len(planner.EligibleNodes(task, eligible)) == 0 {
				reason = "no-compatible-node"
			}
			if planner.VersionBlockedCandidates(task, eligible) > 0 {
				reason = "version-blocked"
			}
			if reason == "no-capacity" {
				if victim, err := s.requestPreemption(ctx, task, eligible); err != nil {
					s.log.Warn("抢占停止请求未送达", "task_id", task.TaskID, "err", err)
				} else if victim != "" {
					s.log.Info("已请求抢占", "task_id", task.TaskID, "victim", victim)
				}
			}
			deferTask(task.TaskID, reason)
			continue // Other employees/Agents can still have eligible idle devices.
		}
		if err := s.store.SyncNodeSnapshot(ctx, *n); err != nil {
			s.log.Error("同步节点快照失败", "node_id", n.NodeID, "err", err)
			deferTask(task.TaskID, "store-unavailable")
			continue
		}
		placed, err := s.store.PlaceTask(ctx, lease, task, n.NodeID)
		if err != nil {
			var ncap *domain.NoCapacityError
			if errors.As(err, &ncap) {
				deferTask(task.TaskID, "no-capacity")
				continue
			}
			s.log.Error("drain 放置失败", "task_id", task.TaskID, "err", err)
			continue
		}
		if placed.State.Active() {
			active[n.NodeID]++
			s.drainMu.Lock()
			s.drainActive[n.NodeID]++
			s.drainMu.Unlock()
			// 等待者已经落位（不论落在哪个节点），它名下的预留在本轮剩余时间里
			// 不再占数；下一轮查询时它已不在排队，预留自然消失。
			served[task.TaskID] = struct{}{}
		}
	}
}
