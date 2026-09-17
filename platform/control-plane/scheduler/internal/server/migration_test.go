package server

import (
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// migratable 造一条候选行。
func migratable(taskID, clusterID, nodeID string) store.MigratableActive {
	return store.MigratableActive{
		TaskID: taskID, Realm: "r1", ClusterID: clusterID, NodeID: nodeID,
		Attempt: 1, State: string(domain.StateRunning), AvoidNodes: "[]",
	}
}

// TestMigratableBySelectsOrphanedTask 正向用例。
//
// 它必须存在：下面每一个「不选」的用例，在实现退化成「永远返回空集」时都会继续
// 通过。一个只会说「不」的判据看起来和「一切正常」一模一样——而漂移的「不选」
// 意味着失联集群上的任务被永久挂住，没有任何指标会提醒。
func TestMigratableBySelectsOrphanedTask(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "alive")
	rows := []store.MigratableActive{migratable("t-gone", "cn-north", "gone")}

	got := migratableBy(rows, snap, now, maxStallSnapshotAge)
	if len(got) != 1 {
		t.Fatalf("应选中 1 个，实际 %d 个", len(got))
	}
	if got[0].TaskID != "t-gone" {
		t.Fatalf("选错了任务: %+v", got[0])
	}
}

// TestMigratableByRequiresNodeAbsent 节点仍在目录里 → 绝不选。
//
// 这是 §7.4.1「迁移前必须确认 fencing」的落点，与 stall.go 同一条判据：目录认为
// 该节点还在，就说明它随时可能推进这个任务，此时把任务挪走会在别处开第二个
// attempt——记录层面或许还能靠 attempt 挡住旧节点的回报，但物理副作用已经重复。
func TestMigratableByRequiresNodeAbsent(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "alive")
	rows := []store.MigratableActive{migratable("t-alive", "cn-north", "alive")}

	if got := migratableBy(rows, snap, now, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("节点仍在目录里时不应漂移，实际选中 %d 个", len(got))
	}
}

// TestMigratableByRequiresFreshSnapshot 陈旧快照不做不可逆判定。
//
// 陈旧快照是真实节点集合的**子集**（目录读失败时保留上一份），所以它偏向把仍然
// 活着的节点判成「不存在」。用它做不可逆操作，等于把一次目录抖动放大成批量搬家。
// 不新鲜时必须返回空集，而不是「拿旧的凑合一下」。
func TestMigratableByRequiresFreshSnapshot(t *testing.T) {
	now := time.Now()
	rows := []store.MigratableActive{migratable("t-gone", "cn-north", "gone")}

	stale := freshSnap(now.Add(-2*maxStallSnapshotAge), "alive")
	if got := migratableBy(rows, stale, now, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("陈旧快照下不应漂移，实际选中 %d 个", len(got))
	}

	// 从未成功读过目录：节点集合是**未知**而不是「空」。把未知当空会让全部活跃
	// 任务都变成「节点不在目录里」。
	never := nodeSnapshot{}
	if got := migratableBy(rows, never, now, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("从未读过目录时不应漂移，实际选中 %d 个", len(got))
	}

	// 时钟回拨：快照「有多旧」本身就不可知，宁可不动手。
	future := freshSnap(now.Add(time.Hour), "alive")
	if got := migratableBy(rows, future, now, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("快照时间在未来（时钟回拨）时不应漂移，实际选中 %d 个", len(got))
	}
}

// TestMigratableBySkipsUnboundTasks 没有节点绑定的任务不在此列。
//
// PLACED / RUNNING 本应总有绑定节点；真出现空值说明它不在任何节点上跑，那它下一轮
// 会被 drain 正常接续，不需要也不该被「搬家」——搬它只会让它多绕一圈排队。
func TestMigratableBySkipsUnboundTasks(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "alive")
	rows := []store.MigratableActive{migratable("t-unbound", "cn-north", "")}

	if got := migratableBy(rows, snap, now, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("没有节点绑定的任务不应被漂移，实际选中 %d 个", len(got))
	}
}

// TestMigrationStatsAccumulate 累积器是加法的，且读到的是一份快照值。
//
// 这里刻意不测「某个初值等于多少」：migrationStats 是包级变量，用例之间的执行
// 顺序会影响它，那样的断言会随新增用例而随机变红。测**增量**才是这个对象的契约。
func TestMigrationStatsAccumulate(t *testing.T) {
	beforeMigrated, beforeSkipped, beforeVoided := readMigrationStats()

	observeMigration(2, 3, 1)
	observeMigration(1, 0, 4)

	migrated, skipped, voided := readMigrationStats()
	if migrated != beforeMigrated+3 {
		t.Fatalf("migrated 应累加 3，实际 %d → %d", beforeMigrated, migrated)
	}
	if skipped != beforeSkipped+3 {
		t.Fatalf("skipped 应累加 3，实际 %d → %d", beforeSkipped, skipped)
	}
	if voided != beforeVoided+5 {
		t.Fatalf("voided 应累加 5，实际 %d → %d", beforeVoided, voided)
	}
}
