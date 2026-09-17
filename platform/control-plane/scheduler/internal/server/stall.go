// 停滞任务收割（spec §7.4.2：跨集群的卡死任务必须能告警，等待超过
// max_stall(默认 8h) 则自动进入死信，交由 Scheduler 重试或标记失败）。
//
// 这个循环做的是**不可逆**的动作：把一个任务标成 FAILED。所以它的判据必须比
// 「看起来卡住了」硬得多——误判的代价是丢掉一个还在跑的任务，而且状态机不允许
// 终态回退（CompleteTaskAttempt 只在活跃态上生效），节点事后回报的真实结果会被
// 直接丢掉。下面三道闸门都是为此存在，缺一不可。
package server

import (
	"context"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

const (
	// defaultMaxStall 判定停滞的宽限期（spec §7.4.2 的 max_stall 默认值）。
	defaultMaxStall = 8 * time.Hour
	// defaultStallReapInterval 收割周期。判据是小时级的，周期取分钟级即可；
	// 更密只会让「读活跃任务」这条查询白跑。
	defaultStallReapInterval = 5 * time.Minute
	// maxStallSnapshotAge 判定可用的目录快照最大年龄。
	//
	// 快照由 RunMetricsRefresh 每 30s 刷一次，这里取它的 3 倍：允许连续两次失败，
	// 再多就说明刷新循环本身已经不转了，那时任何「节点不存在」的结论都不成立。
	maxStallSnapshotAge = 3 * defaultMetricsRefreshInterval
	// stallReasonOrphaned 落进台账的原因文本。可读即可，不要在代码里按它做判断。
	stallReasonOrphaned = "max_stall: 所属节点已不在目录中，任务无法再被推进"
)

// stallCandidate 一个通过全部闸门、应当转死信的任务。
type stallCandidate struct {
	row     store.StalledActive
	stalled time.Duration
	snapAge time.Duration
}

// snapshotFresh 目录快照是否新鲜到足以支撑不可逆判定。
//
// 单独抽出来是因为它有两个调用方：判定本身，以及「为什么这一轮什么都没做」的
// 日志。两处各写一遍迟早会分叉，而分叉之后日志会声称「快照新鲜」而判定已经
// 拒绝动手——那时日志比没有更坏。
func snapshotFresh(snap nodeSnapshot, now time.Time, maxAge time.Duration) bool {
	if !snap.ok || snap.at.IsZero() {
		return false
	}
	age := now.Sub(snap.at)
	// age < 0 是时钟回拨。回拨之后「快照有多旧」这件事本身就不可知，
	// 宁可拒绝动手。
	return age >= 0 && age <= maxAge
}

// stalledBy 从观测到的活跃任务里选出应当死信的那些。
//
// 三道闸门，任何一道单独成立都不足以放弃一个任务：
//
//	① **快照必须新鲜。** 陈旧快照是真实节点集合的**子集**（目录读失败时保留上一份），
//	   所以它偏向把仍然活着的节点判成「不存在」。用陈旧快照做不可逆操作，等于把
//	   一次目录抖动放大成批量误杀。不新鲜时返回空集，而不是「拿旧的凑合一下」。
//
//	② **节点必须不在快照里。** 这是 spec §7.4.1「迁移前必须确认 fencing」的落点：
//	   只有目录认为该节点已不存在，才谈得上原节点不可能再推进它。判据是「不在
//	   目录里」，**不是**「不在 scheduler_nodes 表里」——那张表只增不减（全仓没有
//	   任何 DELETE），用它做判据会得到一条永远不成立的规则。
//
//	③ **该 attempt 静默超过 maxStall。** 这是**宽限**而不是主判据：它给「节点刚
//	   掉线、目录还没更新」留出时间。仅凭时长判断会误杀长任务——控制面的
//	   updated_at 只在状态跃迁时前进，正常跑 9 小时和卡死 9 小时长得一样（见
//	   store.StalledActiveTasks）。
//
// node_id 为空的任务不在此列：不占槽位、也不是孤儿，未放置的积压由队列时长那条
// 告警负责，不该被「节点不在目录里」这条判据误伤。
func stalledBy(rows []store.StalledActive, snap nodeSnapshot, now time.Time, maxStall, maxSnapshotAge time.Duration) []stallCandidate {
	if !snapshotFresh(snap, now, maxSnapshotAge) {
		return nil
	}
	snapAge := now.Sub(snap.at)
	var out []stallCandidate
	for _, row := range rows {
		if row.NodeID == "" {
			continue
		}
		if _, known := snap.ids[row.NodeID]; known {
			continue
		}
		stalled := time.Duration(row.StalledMS) * time.Millisecond
		if stalled < maxStall {
			continue
		}
		out = append(out, stallCandidate{row: row, stalled: stalled, snapAge: snapAge})
	}
	return out
}

// RunStallReaper 周期性收割停滞任务，直到 ctx 结束。
//
// 只在 leader 上动手，但**每个副本都跑循环**：领导权会转移，在启动期决定「谁跑
// 收割」会把转移之后的空档永久固化下来。非 leader 的每一轮直接返回。
//
// 与 RunMetricsRefresh 的分工：那个循环每个副本都刷快照（/metrics 是逐个副本
// 抓的），这个循环只消费快照、不改它。
//
// 刻意不在启动时立刻跑一轮：那时快照还没填过，判定必然返回空集，跑一次只是
// 制造一条无意义的日志；而「等第一跳」也让进程启动阶段不出现不可逆写入。
//
// maxStall 为负 = 显式关闭。这是给「先在集群里观察一轮再打开」留的退路，但关闭
// 状态必须**在日志里说出来**：一个静默不工作的收割循环，会让「没有任何死信」被
// 读成「没有卡死的任务」。关掉它不会让信号消失——LumoTaskLost 仍在响，只是没有
// 自动兜底了。
func (s *Server) RunStallReaper(ctx context.Context, interval, maxStall time.Duration) {
	if maxStall < 0 {
		s.log.Warn("停滞收割已关闭（max-stall 为负）：卡死任务不会被自动转死信，只能靠 LumoTaskLost 人工处理")
		return
	}
	if interval <= 0 {
		interval = defaultStallReapInterval
	}
	if maxStall <= 0 {
		maxStall = defaultMaxStall
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reapStalled(ctx, maxStall)
		}
	}
}

// reapStalled 跑一轮收割。
func (s *Server) reapStalled(ctx context.Context, maxStall time.Duration) {
	if s.elec == nil || !s.elec.IsLeader() {
		return
	}
	snap := s.snapshot()
	now := time.Now()
	if !snapshotFresh(snap, now, maxStallSnapshotAge) {
		// 这不是「稍后再试」的软失败，而是硬闸门。必须留下日志：否则刷新循环
		// 一旦卡住，收割会变成静默空转，而「没有任何死信」会被读成「没有卡死
		// 的任务」。
		s.log.Warn("目录快照不新鲜，本轮不做停滞收割",
			"catalog_ok", snap.ok, "snapshot_age", snapshotAge(snap, now).String(),
			"max_age", maxStallSnapshotAge.String())
		return
	}

	rows, err := s.store.StalledActiveTasks(ctx)
	if err != nil {
		s.log.Warn("查询活跃任务失败，本轮不做停滞收割", "err", err)
		return
	}
	candidates := stalledBy(rows, snap, now, maxStall, maxStallSnapshotAge)
	if len(candidates) == 0 {
		return
	}

	dead := 0
	for _, c := range candidates {
		ok, err := s.store.DeadLetter(ctx, store.DeadLetterRecord{
			TaskID: c.row.TaskID, Attempt: c.row.Attempt, Realm: c.row.Realm,
			ClusterID: c.row.ClusterID, NodeID: c.row.NodeID,
			Reason: stallReasonOrphaned, StalledMS: c.stalled.Milliseconds(),
			SnapshotMS: c.snapAge.Milliseconds(),
		})
		if err != nil {
			s.log.Error("写死信失败", "task_id", c.row.TaskID, "err", err)
			continue
		}
		if !ok {
			// 判定与落库之间任务被推进了（节点回来、被取消、被重试）。
			// 这正是条件写要挡的情况，不是错误。
			continue
		}
		dead++
		s.log.Warn("任务已转死信",
			"task_id", c.row.TaskID, "attempt", c.row.Attempt,
			"node_id", c.row.NodeID, "cluster_id", c.row.ClusterID,
			"state", c.row.State, "stalled", c.stalled.String(),
			"snapshot_age", c.snapAge.String(), "reason", stallReasonOrphaned)
	}
	s.log.Info("停滞收割完成", "candidates", len(candidates), "dead_lettered", dead,
		"max_stall", maxStall.String())
}

// snapshotAge 快照年龄；从未成功读过目录时返回 0（调用方已先判 ok/at）。
func snapshotAge(snap nodeSnapshot, now time.Time) time.Duration {
	if snap.at.IsZero() {
		return 0
	}
	return now.Sub(snap.at)
}
