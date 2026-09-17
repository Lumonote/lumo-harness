// 跨集群任务漂移（§7.4.1：集群进入 down 之后「任务漂回全局 Task Bus 重放置」）。
//
// 与 stall.go 的关系：两者都在做**不可逆**的事，共用同一套闸门形状
// （leader → 证据新鲜 → 证据充分 → 条件写），差别在判据与代价：
//
//   - stall reaper 的判据是「**单个节点**不在目录里 + 静默超过 max_stall(8h)」，
//     动作是**放弃**这个任务（转死信）。
//   - 漂移的判据是「**整个集群**确认 down」，动作是**搬家**——任务还会继续跑，
//     只是换个地方开新 attempt。
//
// 漂移的时间阈值比 stall 短得多（分钟级 vs 小时级），这不是不一致：stall 的 8h
// 宽限是因为它要区分「节点掉线」与「任务本来就在跑很久」；而集群 down 本身
// 已经蕴含了「它至少 90s 没跟中心说过话」，任务被永久挂住才是这里要防的事。
package server

import (
	"context"
	"sync"
	"time"

	"github.com/lumo-harness/platform/observability"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

const (
	// defaultMigrationInterval 漂移循环周期。
	//
	// 判据是分钟级的（down 阈值 90s + 宽限），周期取半分钟即可；更密只会让
	// 「按 down 集群取活跃任务」这条查询白跑。
	defaultMigrationInterval = 30 * time.Second
	// migrationReasonClusterDown 落进台账的原因文本。可读即可，不要在代码里按它做判断。
	migrationReasonClusterDown = "cluster_down: 所属集群超过自报阈值，任务漂回全局队列重放置"
)

// migrationStats 漂移的进程内累积值。
//
// 与 session-control 的控制面指标同样的理由：计数在裁决路径上顺手累加，
// 抓取只读内存。累计值从进程启动起算，重启归零是普罗米修斯计数器的正常语义。
// 标签基数是可控的：outcome 只有 migrated / skipped 两个固定值，且**不按
// cluster_id 下钻**——集群号是外部输入，按它下钻会让基数跟着部署规模长。
var migrationStats = struct {
	mu       sync.Mutex
	migrated int64
	skipped  int64
	voided   int64
}{}

func observeMigration(migrated, skipped, voided int) {
	migrationStats.mu.Lock()
	defer migrationStats.mu.Unlock()
	migrationStats.migrated += int64(migrated)
	migrationStats.skipped += int64(skipped)
	migrationStats.voided += int64(voided)
}

// readMigrationStats 读累积值的快照。返回的是值而不是让调用方持锁读：
// 抓取路径不该把锁持有到写指标为止。
func readMigrationStats() (migrated, skipped, voided int64) {
	migrationStats.mu.Lock()
	defer migrationStats.mu.Unlock()
	return migrationStats.migrated, migrationStats.skipped, migrationStats.voided
}

// publishMigrationMetrics 把漂移累积值写进 /metrics。
//
// 用 ReplaceGauges 而不是逐条 SetGauge：outcome 是一个闭集，整体替换能保证
// 「这一轮写了哪些维度」是明确的（见 observability.ReplaceGauges 的语义）。
func publishMigrationMetrics() {
	migrated, skipped, voided := readMigrationStats()
	observability.ReplaceGauges(MetricTaskMigrations, []observability.GaugePoint{
		{Labels: map[string]string{"outcome": "migrated"}, Value: float64(migrated)},
		{Labels: map[string]string{"outcome": "skipped"}, Value: float64(skipped)},
	})
	// 作废的派发行数单独一条、不带 outcome 维度：它与「搬了几次家」是两个量
	// （一次搬家可能作废多条，也可能一条都没有），塞进同一个维度会让人以为
	// 它们是同一件事的两个结果。
	observability.SetGauge(MetricVoidedDispatches, float64(voided))
}

// RunClusterTaskMigrator 周期性把失联集群上的任务漂回全局队列，直到 ctx 结束。
//
// 只在 leader 上动手，但**每个副本都跑循环**：领导权会转移，在启动期决定「谁跑
// 漂移」会把转移之后的空档永久固化下来。非 leader 的每一轮直接返回。
//
// 刻意不在启动时立刻跑一轮（与 RunStallReaper 同源）：那时目录快照还没填过，
// 判定必然返回空集，跑一次只是制造一条无意义的日志。
//
// interval 为负 = 显式关闭。这是给「先在集群里观察一轮再打开」留的退路，但关闭
// 状态必须**在日志里说出来**：一个静默不工作的漂移循环，会让「没有任务被搬走」
// 被读成「没有集群失联」。关掉它不会让信号消失——LumoClusterStoppedReporting
// 仍在响，只是没有自动兜底了。
//
// grace 是 down 阈值之上的**额外**等待（见 domain.ClusterThresholds.MigrateEligible）。
// 它的默认值刻意非零，理由写在 main 的 flag 说明与设计稿的偏离节里。
func (s *Server) RunClusterTaskMigrator(ctx context.Context, interval, grace time.Duration) {
	if interval < 0 {
		s.log.Warn("集群任务漂移已关闭（migrate 周期为负）：失联集群上的任务不会被自动搬走，只能人工处理")
		return
	}
	// 判定能力没打开时，集群状态压根不存在（`AnnotateClusterStates` 不会被装配），
	// 谈「哪些集群 down」没有意义。这里必须**说出来**而不是静默返回：
	// 「漂移循环在跑但一个集群都没失联」与「它根本没在跑」在日志上必须分得开。
	if s.clusters == nil || !s.clusterEnforced {
		s.log.Warn("集群任务漂移未启动：需要联邦注册表与集群失联判定同时生效",
			"registry_assembled", s.clusters != nil, "enforcement_enabled", s.clusterEnforced)
		return
	}
	if interval == 0 {
		interval = defaultMigrationInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.migrateOnce(ctx, grace)
		}
	}
}

// migrateOnce 跑一轮漂移。五道闸门，任何一道单独成立都不足以搬走一个任务。
func (s *Server) migrateOnce(ctx context.Context, grace time.Duration) {
	if s.elec == nil || !s.elec.IsLeader() {
		return
	}

	// ① 注册表必须可读。读不到就整轮不动手：**没有证据不等于没有失联集群**，
	// 而「读不到 → 当成没有 down 集群 → 什么都不做」与「读不到 → 抛错罢手」
	// 在这里是同一个结果，但前者是静默的，所以必须留日志。
	clusters, err := s.clusters.ClusterAges(ctx)
	if err != nil {
		s.log.Warn("集群注册表不可读，本轮不做任务漂移", "err", err)
		return
	}
	graceMS := grace.Milliseconds()
	var downClusters []string
	ages := make(map[string]int64, len(clusters))
	for _, c := range clusters {
		// 时间线取的是 `down + grace`，不是 `down`（见 domain.MigrateEligible）。
		if !s.clusterThresholds.MigrateEligible(c.AgeMS, graceMS) {
			continue
		}
		downClusters = append(downClusters, c.ClusterID)
		ages[c.ClusterID] = c.AgeMS
	}
	if len(downClusters) == 0 {
		return // 常态：没有集群越过漂移时间线，不打日志
	}

	// ② 目录快照必须新鲜。与 stall.go 共用一个上限（3× 刷新周期）：陈旧快照是
	// 真实节点集合的**子集**，它偏向把仍然活着的节点判成「不存在」，用它做
	// 不可逆操作等于把一次目录抖动放大成批量搬家。
	snap := s.snapshot()
	now := time.Now()
	if !snapshotFresh(snap, now, maxStallSnapshotAge) {
		s.log.Warn("目录快照不新鲜，本轮不做任务漂移",
			"down_clusters", len(downClusters), "catalog_ok", snap.ok,
			"snapshot_age", snapshotAge(snap, now).String(),
			"max_age", maxStallSnapshotAge.String())
		return
	}

	// ③ 取候选：这些集群上的可漂移任务。
	rows, err := s.store.MigratableActiveTasks(ctx, downClusters)
	if err != nil {
		s.log.Warn("查询可漂移任务失败，本轮不做任务漂移", "err", err)
		return
	}
	candidates := migratableBy(rows, snap, now, maxStallSnapshotAge)

	// ④ 条件写。每一条都可能因为「判定与落库之间被推进了」而返回 false，
	// 那不是错误（同 stall.go 的 DeadLetter）。
	migrated, skipped, voided := 0, 0, 0
	for _, c := range candidates {
		res, err := s.store.MigrateTask(ctx, store.MigrationRecord{
			TaskID: c.TaskID, Attempt: c.Attempt, Realm: c.Realm,
			FromClusterID: c.ClusterID, FromNodeID: c.NodeID,
			Reason:       migrationReasonClusterDown,
			ClusterAgeMS: ages[c.ClusterID], SnapshotMS: snapAgeMS(snap, now),
		})
		if err != nil {
			// 单条失败不影响其余：每个任务彼此独立，且失败的那条下一轮还会被看到。
			s.log.Error("任务漂移失败", "task_id", c.TaskID, "attempt", c.Attempt, "err", err)
			skipped++
			continue
		}
		if !res.Applied {
			skipped++
			continue
		}
		migrated++
		voided += int(res.VoidedDispatches)
		// 逐条 Warn：这是**不可逆**动作（任务会在别处开新 attempt），
		// 事后追「这个任务为什么换了集群」时这些字段就是全部证据。
		s.log.Warn("任务已漂回全局队列",
			"task_id", c.TaskID, "attempt", c.Attempt, "state", c.State,
			"from_cluster_id", c.ClusterID, "from_node_id", c.NodeID,
			"cluster_age", time.Duration(ages[c.ClusterID])*time.Millisecond,
			"snapshot_age", snapshotAge(snap, now).String(),
			"voided_dispatches", res.VoidedDispatches,
			"reason", migrationReasonClusterDown)
	}
	observeMigration(migrated, skipped, voided)

	// 候选为 0 也要说一句：集群已经越过漂移时间线而**一个任务都没搬**，
	// 与「没有集群失联」是两件事，前者值得有人看一眼（它可能是 Pg 形态下
	// 判据恒不成立的结构性结果，见 migratableBy 的注释）。
	s.log.Info("集群任务漂移完成",
		"down_clusters", downClusters, "candidates", len(candidates),
		"migrated", migrated, "skipped", skipped, "voided_dispatches", voided)
}

// migratableBy 从观测到的候选里选出应当漂移的那些。
//
// 除了「快照新鲜」之外只有一条判据，但它不可省：
//
// **原节点不能还在目录里。** 这是 §7.4.1「迁移前必须确认 fencing」的落点，
// 与 stall.go 用同一条判据（那边解释了为什么判据取「不在**目录**里」而不是
// 「不在 scheduler_nodes 表里」）。语义上它是「原节点不可能再推进这个任务」的
// 唯一可得代理信号——注意它只是代理：集群没自报 ≠ 原节点已停止执行，
// 而后者无法被证明。物理层面的兜底是 R2 的 turn 级恢复契约（工具幂等分类），
// 记录层面的兜底是新 attempt（见 store.MigrateTask）。
//
// **两种目录形态下这条判据的行为必须说清楚**（否则下一个人会以为它两边都成立）：
//
//   - Nacos 形态：目录只返回健康实例，集群失联时它的节点已经静默消失，所以这条
//     判据**恒满足**——冗余，但无害，且能抓住「Nacos 还认为某节点健康」这种
//     与集群自报矛盾的信号（那时不搬家是对的）。
//   - Pg 形态：`scheduler_nodes` 只增不减（全仓没有任何 DELETE），所以节点永远
//     在目录里 → 这条判据**恒不满足** → 漂移不生效。这是**正确**行为：Pg 形态
//     就是单集群形态（local-lite），没有第二个集群可搬，与 C2/R8 记录的
//     「task_lost / node_down 在 local-lite 下恒为 0」同源。多集群必然用 Nacos。
//
// node_id 为空的行不在此列：PLACED/RUNNING 本应总有绑定节点，真出现空值说明它
// 不在任何节点上跑，那它下一轮会被 drain 正常接续，不需要也不该被「搬家」。
func migratableBy(rows []store.MigratableActive, snap nodeSnapshot, now time.Time, maxSnapAge time.Duration) []store.MigratableActive {
	if !snapshotFresh(snap, now, maxSnapAge) {
		return nil
	}
	out := make([]store.MigratableActive, 0, len(rows))
	for _, row := range rows {
		if row.NodeID == "" {
			continue
		}
		if _, known := snap.ids[row.NodeID]; known {
			continue
		}
		out = append(out, row)
	}
	return out
}

// snapAgeMS 快照年龄的毫秒数，供台账落库。调用方已先判过快照新鲜。
func snapAgeMS(snap nodeSnapshot, now time.Time) int64 {
	if snap.at.IsZero() {
		return 0
	}
	return now.Sub(snap.at).Milliseconds()
}
