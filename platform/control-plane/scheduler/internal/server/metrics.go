// 调度面的集群维度指标（§7.4.2 全局执行监控面）。
//
// 两条设计约束决定了这里的形状：
//
// ① **抓取路径不做网络 I/O。** 节点存活来自目录（Nacos），而 /metrics 是被
// 周期性抓取的。在 handler 里查目录，等于让「指标可抓取」依赖另一个服务可用；
// 目录慢下来时抓取超时，Prometheus 会把整个实例标成 down——一次目录抖动
// 升级成「所有指标同时消失」。所以节点信息由后台循环刷成快照，抓取只读内存，
// 并把快照年龄一并导出：数据是旧的必须能看出来。
//
// ② **计数类指标一律整体替换。** 增量写入表达不了「某个维度已经消失」，序列会
// 永远停在最后一次写入的值上（见 observability.ReplaceGauges）。凡是指标值来自
// 「对当前状态做一次快照」的地方都走 ReplaceGauges。
package server

import (
	"context"
	"sort"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// 调度面导出的指标名。集中成常量是因为 platform/deploy/alerts-verify.sh 要拿
// 告警表达式里的名字回来核对「这个名字真的有人写」——散在各处的字面量会让那条
// 核对退化成字符串碰运气。
const (
	// MetricPendingTotal 无标签的排队总数。外部 autoscaler 按这个名字扩容，
	// 是既有契约：新增按集群下钻的序列不能把它撤掉。
	MetricPendingTotal = "lumo_scheduler_pending_tasks"
	// MetricTasks 非终态任务数，按 state × cluster_id 下钻。
	MetricTasks = "lumo_scheduler_tasks"
	// MetricOldestPending 各集群最久排队任务已等待的秒数（queue_backlog 的来源）。
	MetricOldestPending = "lumo_scheduler_oldest_pending_seconds"
	// MetricNodes 目录里健康节点数，按 cluster_id 下钻（node_down 的来源）。
	MetricNodes = "lumo_scheduler_nodes"
	// MetricOrphanedActive 挂在「目录中已不存在」的节点上的活跃任务数
	// （task_lost 的来源，也是死信迁移的前置条件）。
	MetricOrphanedActive = "lumo_scheduler_orphaned_active_tasks"
	// MetricLeader 本副本是否持有租约。每副本各报一个值，Prometheus 用 instance
	// 区分；无 leader 时没有任何副本在排空队列。
	MetricLeader = "lumo_scheduler_leader"
	// MetricCatalogOK 最近一次目录读取是否成功。0 表示节点数是旧值。
	MetricCatalogOK = "lumo_scheduler_catalog_ok"
	// MetricCatalogAge 距最近一次**成功**读取目录的秒数。
	MetricCatalogAge = "lumo_scheduler_catalog_snapshot_age_seconds"
	// MetricClusterAge 各集群距最后一次**自报**的秒数（§7.4.1 两段式判定的输入）。
	//
	// 这是注册表侧的存活信号，与 MetricNodes（目录侧）刻意分开：Nacos 目录只返回
	// 健康实例，一个失联集群与一个从未部署的集群在目录里长得一样，存活与否只能由
	// 自报回答。本集群里「有节点」而「很久没自报」是完全可以同时出现的两件事。
	MetricClusterAge = "lumo_scheduler_cluster_age_seconds"
	// MetricClusterState 各集群的判定结果：每个集群按状态展开成三条序列，当前状态
	// 那条为 1、其余为 0。
	//
	// 为什么导出的是**判定结果**而不是让告警拿年龄去比阈值：阈值是可配置的
	// （LUMO_CLUSTER_SUSPECT_MS / DOWN_MS），告警里再写一遍 30/90 就会与该实例真正
	// 在用的阈值漂移——那时告警与闸门的口径不一致，而两边看起来都对。
	MetricClusterState = "lumo_scheduler_cluster_state"
	// MetricClusterRegistryOK 最近一次读取集群注册表是否成功。
	//
	// 存在的理由与 MetricCatalogOK 同源：读取失败时本轮**不替换**状态序列（沿用上
	// 一轮的值），所以一条已经响起的 down 告警不会因为「读不到」而自动解除。这是
	// 刻意的方向——读不到更该有人去看——但必须让「读不到」与「真的 down」分得开。
	MetricClusterRegistryOK = "lumo_scheduler_cluster_registry_ok"
	// MetricTaskMigrations 漂移动作的累计次数，按 outcome（migrated / skipped）下钻。
	//
	// 这是一个**动作计数**而不是状态量：`lumo_scheduler_tasks` 报的是「此刻有多少
	// 任务在失联集群上」，而一次失联过后那批任务会被搬走，于是那个数**回落**了
	// ——只看它无法区分「任务被搬走了」与「集群自己恢复了」。搬家是不可逆动作，
	// 必须有自己单调的证据。
	//
	// 不按 cluster_id 下钻：集群号是外部输入，按它下钻会让基数跟着部署规模长
	// （与 session-control 不按 session_ref 下钻同一条理由）。
	MetricTaskMigrations = "lumo_scheduler_task_migrations_total"
	// MetricVoidedDispatches 被漂移顺带作废的未认领派发行累计数。
	//
	// 单独一个名字而不是给上面那个加一维：它是**另一件事**——「有多少条本该投给
	// 原节点的执行请求被拦下来了」。这个数大于 0 说明 fencing 曾经只差一步就被
	// 从 outbox 后门绕过去（见 store.MigrateTask 的注释）。
	MetricVoidedDispatches = "lumo_scheduler_voided_dispatches_total"
	// MetricClusterVersionDeclared 判定集合里**声明过**版本的集群数。
	//
	// 与下面那条分开导出，是为了让「闸门开着但没人声明版本」这个组合能被看见：
	// 那时闸门恒放行（无信息），而它看起来与「版本一致、闸门正常工作」一模一样。
	// declared=0 而闸门开着 = 这个闸门一分钱的作用都没起。
	MetricClusterVersionDeclared = "lumo_scheduler_cluster_version_declared"
	// MetricClusterVersionConsistent 版本是否可证明一致（1/0）。
	//
	// **只在 declared > 0 时导出**：declared=0 时「一致」是一个空洞的真，导出 1
	// 会让人以为闸门在正常工作。序列缺席 + declared=0 才是那一档的准确表达
	// （同 MetricClusterState 只在本实例参与判定时导出的理由）。
	MetricClusterVersionConsistent = "lumo_scheduler_cluster_version_consistent"
	// MetricVersionBlocked 因版本一致性前置而被拦下的全局放置累计数。
	//
	// 存在理由是**可区分性**：被版本闸门拦住的任务走的是与「没有容量」完全相同
	// 的排队路径（202 + PENDING），只看响应分不开，而两者的处置相反——前者去把
	// 滚动升级做完，后者去扩容。与 MetricTaskMigrations 同一种东西（动作计数
	// 而不是状态量）。
	MetricVersionBlocked = "lumo_scheduler_placement_version_blocked_total"
	// MetricDegradedPlacements 全局调度缺席期间、由**集群本地租约**成功放行的放置累计数。
	//
	// 它必须存在，因为降级运行时的服务看起来完全正常：放置成功、201、没有错误日志。
	// 而「此刻没有全局决策者」正是读监控的人最需要知道的一件事——**降级不该只活在
	// 一条启动日志里**。与 MetricTaskMigrations 同一种东西（动作计数而非状态量）。
	//
	// 不按 cluster_id 下钻：一个实例只有一个本地集群身份，标签基数恒为 1，
	// 加了只是让每个查询多写一个 matcher（与 MetricTaskMigrations 不按集群下钻同一条理由）。
	MetricDegradedPlacements = "lumo_scheduler_degraded_placements_total"
)

// defaultMetricsRefreshInterval 节点快照刷新周期。目录心跳是 5s 级
// （dsh-node 每 5s 续报一次 Nacos 租约），刷新周期取它的数倍即可，
// 不必跟着心跳走：抓取本身是 15s 级，刷新更快只会增加目录压力。
const defaultMetricsRefreshInterval = 30 * time.Second

// nonTerminalStates 任务状态机里的非终态。
//
// 终态（COMPLETED / FAILED / ABORTED）刻意不导出：终态行只增不减，导出它们
// 会让抓取路径去扫全表历史，而「上周完成了多少任务」没有任何可告警性。
// 完整理由见 store.NonTerminalStateCounts。
var nonTerminalStates = []string{
	string(domain.StatePending), string(domain.StatePlaced),
	string(domain.StateRunning), string(domain.StateCancelling),
}

// nodeSnapshot 目录里健康节点的一份快照。
type nodeSnapshot struct {
	// at 是最近一次**成功**读取的时刻，不是最近一次尝试。目录挂掉时它不前进，
	// 于是 age 一直涨——「节点数没变」与「根本没读到」必须在图上分得开。
	at     time.Time
	ok     bool
	counts map[string]int
	ids    map[string]struct{}
}

// RefreshNodeSnapshot 从目录刷新节点快照。
//
// 读取失败时**保留上一份节点集合**，只把 ok 翻成 0 并冻结 at。理由不是「省事」：
// 节点集合同时是孤儿任务的判定依据。若读不到目录就当成「一个节点都没有」，
// 一次目录抖动会把全部活跃任务判成孤儿，进而触发大规模死信迁移——那正是
// spec §7.4.1 要求「迁移前必须确认 fencing」要挡住的事。失败只暴露 staleness，
// 让下游自己决定要不要信这份数据。
//
// 代价要写清楚：陈旧的节点集合是真实集合的**子集**，所以它偏向**误报**孤儿
// （刚注册的节点不在旧集合里），而不是漏报。因此告警与死信迁移都必须额外要求
// 「快照新鲜」，不能只看孤儿数。
func (s *Server) RefreshNodeSnapshot(ctx context.Context) {
	nodes, err := s.catalog.List(ctx)
	if err != nil {
		s.nodeMu.Lock()
		s.nodeSnap.ok = false
		s.nodeMu.Unlock()
		s.log.Warn("刷新节点快照失败，沿用上一份目录快照", "err", err)
		return
	}
	counts := make(map[string]int, len(nodes))
	ids := make(map[string]struct{}, len(nodes))
	for _, node := range nodes {
		counts[node.ClusterID]++
		ids[node.NodeID] = struct{}{}
	}
	// 每次整体换一份新 map，已发布出去的那份不会再被改：读取方不需要加锁
	// 就能安全遍历，也不会看到刷新到一半的中间状态。
	s.nodeMu.Lock()
	s.nodeSnap = nodeSnapshot{at: time.Now(), ok: true, counts: counts, ids: ids}
	s.nodeMu.Unlock()
}

// RunMetricsRefresh 周期性刷新节点快照，直到 ctx 结束。
//
// 每个副本都跑，不只在 leader 上：/metrics 是被逐个副本抓取的，只让 leader
// 刷新会让非 leader 副本报出一份空节点集，而「谁在报什么」就变成随机的。
func (s *Server) RunMetricsRefresh(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultMetricsRefreshInterval
	}
	s.RefreshNodeSnapshot(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.RefreshNodeSnapshot(ctx)
		}
	}
}

func (s *Server) snapshot() nodeSnapshot {
	s.nodeMu.RLock()
	defer s.nodeMu.RUnlock()
	return s.nodeSnap
}

// publishSchedulerMetrics 把当前调度状态写成指标。
//
// 任何一步失败只记录并跳过，不返回错误：抓取路径不该因为一条统计查询失败而整个
// 失败，那会把「少几个指标」升级成「这个实例不可抓取」，反而丢掉本来还能用的
// 信号。缺失的部分由「序列不存在」表达。
func (s *Server) publishSchedulerMetrics(ctx context.Context) {
	if pending, err := s.store.PendingCount(ctx); err == nil {
		observability.SetGauge(MetricPendingTotal, float64(pending))
	} else {
		s.log.Warn("采集排队任务指标失败", "err", err)
	}

	counts, countsErr := s.store.NonTerminalStateCounts(ctx)
	if countsErr != nil {
		s.log.Warn("采集非终态任务数失败", "err", countsErr)
	}
	waits, waitsErr := s.store.OldestPendingByCluster(ctx)
	if waitsErr != nil {
		s.log.Warn("采集排队时长失败", "err", waitsErr)
	}

	snap := s.snapshot()
	clusters := knownClusters(counts, waits, snap)

	// 查询失败时不发布：整体替换会把该名字下的序列**全部撤下**，用一份空集合
	// 去替换等于声称「所有集群的任务数都是 0」。宁可让上一轮的值留在原地，
	// 也不要写一个错的 0 进去。
	if countsErr == nil {
		observability.ReplaceGauges(MetricTasks, deriveTaskSeries(counts, clusters))
	}
	if waitsErr == nil {
		observability.ReplaceGauges(MetricOldestPending, deriveOldestPending(waits, clusters))
	}

	nodes := make([]observability.GaugePoint, 0, len(snap.counts))
	for cluster, count := range snap.counts {
		nodes = append(nodes, observability.GaugePoint{
			Labels: map[string]string{"cluster_id": cluster},
			Value:  float64(count),
		})
	}
	observability.ReplaceGauges(MetricNodes, nodes)

	// 只在**本实例有集群身份**（即降级路径确实存在）时导出：没有本地身份时
	// 「降级过 0 次」是一个空洞的真——那条路径压根走不到，而 0 会让人以为它在工作
	// （同 MetricClusterVersionConsistent 只在 declared>0 时导出）。这个数不来自库，
	// 所以不受下面「查询失败不发布」那条规则的约束。
	if s.localClusterID != "" {
		observability.ReplaceGauges(MetricDegradedPlacements, []observability.GaugePoint{{Value: float64(s.DegradedPlacements())}})
	}

	// ok 与 age 跟节点数同批导出：只看节点数分不清「目录里就是 0 个节点」与
	// 「目录根本没读到」，而这两者的处置完全相反。
	observability.SetGauge(MetricCatalogOK, boolGauge(snap.ok))
	if !snap.at.IsZero() {
		observability.SetGauge(MetricCatalogAge, time.Since(snap.at).Seconds())
	}

	// 孤儿数只在拿到过至少一份目录快照后才谈得上。没有快照时节点集合是
	// **未知**而不是**空**，把未知当空会让所有活跃任务都变成孤儿。
	if !snap.at.IsZero() {
		if active, err := s.store.ActiveCounts(ctx); err == nil {
			observability.SetGauge(MetricOrphanedActive, float64(orphanedActive(active, snap.ids)))
		} else {
			s.log.Warn("采集活跃任务失败", "err", err)
		}
	}

	observability.SetGauge(MetricLeader, boolGauge(s.elec != nil && s.elec.IsLeader()))

	// 漂移累积值**无条件发布**，且放在注册表那一块**之前**：它是进程内计数，
	// 不依赖任何一次查询成功；而下面那个块在读注册表失败时会 return，把它放在
	// 后面会让「注册表读不到」顺带把搬家计数也一起撤下——那正好是最需要看到
	// 「之前搬过多少次家」的时刻。
	publishMigrationMetrics()
	// 同理：版本闸门拦下的次数也是进程内计数，注册表读不到时它照样成立。
	publishPlacementMetrics()

	// 联邦注册表：本实例参与存活判定、或开着版本闸门时导出。两者都关时这几条序列
	// **整体不存在**，而不是报 0——「没有这个能力」与「集群都健康 / 注册表读不到」
	// 在图上必须分得开。
	//
	// 取两个开关的并集而不是 clusterEnforced 单独：版本闸门可以单独打开（它消费的是
	// 版本声明而不是存活年龄），只按 clusterEnforced 判会让「只开版本闸门」的部署
	// 一条版本指标都看不到——闸门生效而完全不可观测。
	if (s.clusterEnforced || s.versionGate) && s.clusters != nil {
		clusters, err := s.clusters.ClusterAges(ctx)
		if err != nil {
			s.log.Warn("采集集群注册表失败", "err", err)
			if s.clusterEnforced {
				observability.SetGauge(MetricClusterRegistryOK, 0)
			}
			return
		}
		if s.clusterEnforced {
			observability.SetGauge(MetricClusterRegistryOK, 1)
			observability.ReplaceGauges(MetricClusterAge, deriveClusterAges(clusters))
			observability.ReplaceGauges(MetricClusterState, deriveClusterStates(clusters, s.clusterThresholds))
		}
		if s.versionGate {
			publishVersionMetrics(clusters, s.clusterThresholds, s.clusterEnforced)
		}
	}
}

// publishVersionMetrics 导出版本一致性前置的输入与结论。
//
// 只在闸门打开时调用：关掉时这几条序列**整体不存在**，而不是报 0——
// 「没有这个能力」与「有信息且一致」在图上必须分得开（同上面那个块的理由）。
//
// consistent 只在 declared > 0 时导出，见 MetricClusterVersionConsistent 的注释。
//
// 两条都用 ReplaceGauges 而不是 SetGauge：它们的值来自「对当前注册表做一次快照」，
// 而 declared 会从非零掉回 0（集群被清空）。增量写入表达不了这个回落——上一轮的
// consistent=1 会留在原地，把「闸门没有信息」继续显示成「版本一致」。
func publishVersionMetrics(clusters []domain.Cluster, t domain.ClusterThresholds, healthGate bool) {
	vc := domain.EvaluateVersionConsistency(clusters, t, healthGate)
	observability.ReplaceGauges(MetricClusterVersionDeclared, []observability.GaugePoint{
		{Value: float64(vc.Declared)},
	})
	if vc.Declared == 0 {
		observability.ReplaceGauges(MetricClusterVersionConsistent, nil)
		return
	}
	observability.ReplaceGauges(MetricClusterVersionConsistent, []observability.GaugePoint{
		{Value: boolGauge(vc.Consistent)},
	})
}

// deriveClusterAges 每个集群一条序列：距最后一次自报的秒数。
//
// 与状态一并导出，而不是二选一：状态是给人看结论的，年龄是给人看趋势的
// （「一直在 29 秒附近徘徊」与「稳定在 2 秒」在只看状态时一样健康，但前者离
// 掉进 suspect 只差一次抖动）。
func deriveClusterAges(clusters []domain.Cluster) []observability.GaugePoint {
	points := make([]observability.GaugePoint, 0, len(clusters))
	for _, c := range clusters {
		points = append(points, observability.GaugePoint{
			Labels: map[string]string{"cluster_id": c.ClusterID},
			Value:  float64(c.AgeMS) / 1000,
		})
	}
	return points
}

// deriveClusterStates 每个集群按状态展开成三条序列（当前状态为 1，其余为 0）。
//
// 一簇一维而不是把状态编码成数值：数值枚举在 PromQL 里没法读、没法告警
// （写 `> 0.5` 的人在猜哪一档是几），而一簇一维可以直接
// `lumo_scheduler_cluster_state{state="down"} == 1`。
//
// 状态集合取自 domain.JudgedStates() 而不是在这里再列一遍：判定侧将来加一档时，
// 指标会自动多一维；手写列表会让新增的那一档**连一条序列都不产生**，
// 而「某集群卡在一个我们没在看的档上」恰恰最该被看见（同 deriveTaskSeries 的理由）。
func deriveClusterStates(clusters []domain.Cluster, t domain.ClusterThresholds) []observability.GaugePoint {
	states := domain.JudgedStates()
	points := make([]observability.GaugePoint, 0, len(clusters)*len(states))
	for _, c := range clusters {
		current := t.Evaluate(c.AgeMS)
		for _, state := range states {
			value := float64(0)
			if state == current {
				value = 1
			}
			points = append(points, observability.GaugePoint{
				Labels: map[string]string{"cluster_id": c.ClusterID, "state": string(state)},
				Value:  value,
			})
		}
	}
	return points
}

// deriveTaskSeries 把 (state, cluster) 计数展开成完整序列集合：已知集群 × 状态
// 全集，SQL 没返回的组合补 0。
//
// 状态维度必须补 0，不能只导出 SQL 返回过的行：某集群 PENDING 归零而 RUNNING
// 还有 3 个时，PENDING 行会从结果里消失；若跟着撤掉序列，Prometheus 侧
// 「序列消失」与「值为 0」在 rate/increase 上的语义并不相同，rate 会断档。
// 集群维度相反——集群整个消失时就该撤掉序列，那由 ReplaceGauges 收尾。
func deriveTaskSeries(counts []store.TaskStateCount, clusters []string) []observability.GaugePoint {
	states := append([]string(nil), nonTerminalStates...)
	registered := make(map[string]struct{}, len(nonTerminalStates))
	for _, state := range nonTerminalStates {
		registered[state] = struct{}{}
	}
	index := make(map[[2]string]float64, len(counts))
	for _, row := range counts {
		index[[2]string{row.State, row.ClusterID}] = float64(row.Count)
		if _, ok := registered[row.State]; !ok {
			// 库里出现了一个本层没登记的状态。宁可多导一条序列，也不要让它
			// 静默消失——「任务卡在一个我们没在看的 state」恰恰最该被看见，
			// 而按已知列表展开会让它连一条序列都不产生。
			registered[row.State] = struct{}{}
			states = append(states, row.State)
		}
	}
	points := make([]observability.GaugePoint, 0, len(clusters)*len(states))
	for _, cluster := range clusters {
		for _, state := range states {
			points = append(points, observability.GaugePoint{
				Labels: map[string]string{"state": state, "cluster_id": cluster},
				Value:  index[[2]string{state, cluster}],
			})
		}
	}
	return points
}

// deriveOldestPending 每个已知集群一条序列，没有排队任务的集群为 0。
//
// 0 而不是缺失：队列被清空时指标必须落回 0，否则队列告警永远不会解除。
func deriveOldestPending(waits []store.PendingWait, clusters []string) []observability.GaugePoint {
	index := make(map[string]float64, len(waits))
	for _, row := range waits {
		index[row.ClusterID] = row.Seconds
	}
	points := make([]observability.GaugePoint, 0, len(clusters))
	for _, cluster := range clusters {
		points = append(points, observability.GaugePoint{
			Labels: map[string]string{"cluster_id": cluster},
			Value:  index[cluster],
		})
	}
	return points
}

// knownClusters 集群维度取「目录里的集群 ∪ 任务里出现过的集群」，两侧缺一不可：
// 只取目录会漏掉「节点全没了但还有排队任务」的集群（正是 node_down 要抓的那一态），
// 只取任务会漏掉「有节点但当前没有任何任务」的集群。
//
// 排序只是为了输出稳定，便于测试与文本比对。
func knownClusters(counts []store.TaskStateCount, waits []store.PendingWait, snap nodeSnapshot) []string {
	set := make(map[string]struct{}, len(snap.counts))
	for cluster := range snap.counts {
		set[cluster] = struct{}{}
	}
	for _, row := range counts {
		set[row.ClusterID] = struct{}{}
	}
	for _, row := range waits {
		set[row.ClusterID] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for cluster := range set {
		out = append(out, cluster)
	}
	sort.Strings(out)
	return out
}

// orphanedActive 活跃任务里挂在「目录中不存在」的节点上的数量。
//
// 这是 task_lost 的数据来源，也是死信迁移的前置条件（spec §7.4.1：迁移前必须
// 确认 fencing，即原节点不可能仍在执行）。它的可用性完全取决于目录有没有存活
// 信号，这一点必须写在这里，否则「本机跑出来永远是 0」会被读成「没有孤儿」：
//
//   - Nacos 目录：实例按心跳判活，停止续报的实例被标 unhealthy 并在 List 里被
//     过滤掉 → 孤儿可被发现；
//   - Pg 目录（local-lite）：行只增不减，没有任何存活信号 → 孤儿恒为 0，
//     即 node_down / task_lost 两类告警在本机形态下结构性不成立。
func orphanedActive(active map[string]int, ids map[string]struct{}) int {
	orphaned := 0
	for nodeID, count := range active {
		if _, known := ids[nodeID]; !known {
			orphaned += count
		}
	}
	return orphaned
}

func boolGauge(v bool) float64 {
	if v {
		return 1
	}
	return 0
}
