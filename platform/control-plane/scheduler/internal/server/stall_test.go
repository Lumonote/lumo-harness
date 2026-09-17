package server

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

const testMaxStall = 8 * time.Hour

func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// fakeLeader 直接指定领导权。真实选举要连库，而这里要验的是收割循环在
// 拿到/没拿到领导权时的行为。
type fakeLeader struct {
	leader bool
	lease  *domain.Lease
}

func (f fakeLeader) Current() *domain.Lease { return f.lease }
func (f fakeLeader) IsLeader() bool         { return f.leader }

// freshSnap 一份「刚刚成功读过目录、里面只有 n1」的快照。
func freshSnap(now time.Time, ids ...string) nodeSnapshot {
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return nodeSnapshot{at: now, ok: true, counts: map[string]int{}, ids: set}
}

func stalled(nodeID string, ms int64) store.StalledActive {
	return store.StalledActive{
		TaskID: "t-" + nodeID, Realm: "r1", ClusterID: "cn-north",
		NodeID: nodeID, Attempt: 1, State: string(domain.StateRunning), StalledMS: ms,
	}
}

// TestStalledBySelectsOrphanedStalledTask 是正向用例。
//
// 它必须存在：上面每一个「不选」的用例，在实现退化成「永远返回空集」时都会继续
// 通过。一个只会说「不」的判据看起来和「一切正常」一模一样。
func TestStalledBySelectsOrphanedStalledTask(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "alive")
	rows := []store.StalledActive{stalled("gone", testMaxStall.Milliseconds()+1000)}

	got := stalledBy(rows, snap, now, testMaxStall, maxStallSnapshotAge)
	if len(got) != 1 {
		t.Fatalf("应选中 1 个，实际 %d 个", len(got))
	}
	if got[0].row.TaskID != "t-gone" {
		t.Fatalf("选错了任务: %+v", got[0].row)
	}
	if got[0].stalled < testMaxStall {
		t.Fatalf("停滞时长应 ≥ maxStall，实际 %s", got[0].stalled)
	}
}

// TestStalledByRequiresNodeAbsent 节点仍在目录里 → 绝不选。
//
// 这是 spec §7.4.1「迁移前必须确认 fencing」的直接落点：节点还活着，它随时可能
// 推进这个任务，此时放弃它就是把一个正常任务标成 FAILED，而状态机不允许终态回退，
// 节点事后回报的真实结果会被丢掉。
func TestStalledByRequiresNodeAbsent(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "n1")
	rows := []store.StalledActive{stalled("n1", 100*testMaxStall.Milliseconds())}

	if got := stalledBy(rows, snap, now, testMaxStall, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("节点仍在目录中，不应选中: %+v", got)
	}
}

// TestStalledByRequiresFreshSnapshot 目录读失败时整轮不动手。
//
// 陈旧快照是真实节点集合的**子集**，所以它偏向把活着的节点判成不存在。用它做
// 不可逆操作等于把一次目录抖动放大成批量误杀。
func TestStalledByRequiresFreshSnapshot(t *testing.T) {
	now := time.Now()
	rows := []store.StalledActive{stalled("gone", 100*testMaxStall.Milliseconds())}

	cases := map[string]nodeSnapshot{
		"从未读到过目录": {ok: false, ids: map[string]struct{}{}},
		"目录读失败":   {at: now, ok: false, ids: map[string]struct{}{}},
		"快照已过期":   {at: now.Add(-2 * maxStallSnapshotAge), ok: true, ids: map[string]struct{}{}},
		"时钟回拨":    {at: now.Add(time.Hour), ok: true, ids: map[string]struct{}{}},
	}
	for name, snap := range cases {
		if got := stalledBy(rows, snap, now, testMaxStall, maxStallSnapshotAge); len(got) != 0 {
			t.Fatalf("%s：快照不可信时不应选中任何任务，实际 %d 个", name, len(got))
		}
	}
}

// TestStalledByRequiresGracePeriod 节点刚掉线、目录还没更新时不动手。
func TestStalledByRequiresGracePeriod(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "alive")

	// 边界两侧各一例：差 1ms 就该分道扬镳。
	justUnder := []store.StalledActive{stalled("gone", testMaxStall.Milliseconds()-1)}
	if got := stalledBy(justUnder, snap, now, testMaxStall, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("宽限期内不应选中: %+v", got)
	}
	atBoundary := []store.StalledActive{stalled("gone", testMaxStall.Milliseconds())}
	if got := stalledBy(atBoundary, snap, now, testMaxStall, maxStallSnapshotAge); len(got) != 1 {
		t.Fatalf("到达边界应选中（判据是 < maxStall 才跳过），实际 %d 个", len(got))
	}

	// 时钟偏差导致负值：宁可漏收，不可误杀。
	negative := []store.StalledActive{stalled("gone", -time.Hour.Milliseconds())}
	if got := stalledBy(negative, snap, now, testMaxStall, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("停滞时长为负（时钟偏差）时不应选中: %+v", got)
	}
}

// TestStalledByIgnoresTasksWithoutNode 没有节点的任务不是孤儿，不归这条判据管。
//
// 未放置的积压由队列时长那条告警负责；把 PENDING 混进来会让「节点不在目录里」
// 这条判据误伤一批从未放置过的任务。
func TestStalledByIgnoresTasksWithoutNode(t *testing.T) {
	now := time.Now()
	snap := freshSnap(now, "alive")
	rows := []store.StalledActive{stalled("", 100*testMaxStall.Milliseconds())}

	if got := stalledBy(rows, snap, now, testMaxStall, maxStallSnapshotAge); len(got) != 0 {
		t.Fatalf("node_id 为空的任务不应被选中: %+v", got)
	}
}

// TestSnapshotFreshRejectsZeroAndSkewedAges 把新鲜度判据本身钉住。
func TestSnapshotFreshRejectsZeroAndSkewedAges(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		snap nodeSnapshot
		want bool
	}{
		{"零值快照", nodeSnapshot{}, false},
		{"ok 但无时刻", nodeSnapshot{ok: true}, false},
		{"刚读过", nodeSnapshot{at: now, ok: true}, true},
		{"边界", nodeSnapshot{at: now.Add(-maxStallSnapshotAge), ok: true}, true},
		{"超界 1ns", nodeSnapshot{at: now.Add(-maxStallSnapshotAge - time.Nanosecond), ok: true}, false},
		{"读失败但时刻很新", nodeSnapshot{at: now, ok: false}, false},
		{"时钟回拨", nodeSnapshot{at: now.Add(time.Nanosecond), ok: true}, false},
	}
	for _, c := range cases {
		if got := snapshotFresh(c.snap, now, maxStallSnapshotAge); got != c.want {
			t.Fatalf("%s: snapshotFresh = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestReapStalledDoesNothingWithoutLeader 非 leader 必须**在碰库之前**返回。
//
// 快照刻意给成**新鲜**的，这不是随手写的：零值快照会让新鲜度闸门先短路，于是
// 这个用例在 leader 判定被整段删掉之后仍然通过——它就成了一个只证明「有个闸门
// 挡住了」的空转用例。把另一道闸门打开，才钉得住这一道。
//
// store 是 nil：一旦 leader 判定被删掉或挪到查询之后，这里会直接空指针崩溃，
// 而不是安静地通过。
func TestReapStalledDoesNothingWithoutLeader(t *testing.T) {
	srv := &Server{elec: fakeLeader{}, log: discardLogger()}
	srv.nodeSnap = freshSnap(time.Now(), "alive")
	srv.reapStalled(context.Background(), testMaxStall)
}

// TestReapStalledSkipsOnStaleSnapshot leader 也会因为快照不新鲜而整轮不动手。
//
// 同样用 nil store 钉住「不碰库」：这个判断必须在查询活跃任务之前发生。
// 这里 elec 是 leader，所以挡住它的只能是新鲜度闸门。
func TestReapStalledSkipsOnStaleSnapshot(t *testing.T) {
	srv := &Server{elec: fakeLeader{leader: true}, log: discardLogger()}
	srv.nodeSnap = nodeSnapshot{at: time.Now().Add(-time.Hour), ok: true, ids: map[string]struct{}{}}
	srv.reapStalled(context.Background(), testMaxStall)
}

// TestRunStallReaperStopsWithContext 收割循环必须随 ctx 结束，否则优雅停机时
// 会留下一个还在跑不可逆写入的 goroutine。
func TestRunStallReaperStopsWithContext(t *testing.T) {
	srv := &Server{elec: fakeLeader{}, log: discardLogger()}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		srv.RunStallReaper(ctx, time.Millisecond, testMaxStall)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ctx 结束后 RunStallReaper 仍在运行")
	}
}

// TestRunStallReaperNegativeMaxStallDisables 负值 = 关闭，且必须立刻返回
// （不是进循环空转）。
//
// 这个开关是给「先在集群里观察一轮再打开」留的退路。用例同时钉住「关闭时循环
// 不启动」：若实现只是把负值当成 0 走默认值，这个用例会超时失败——那意味着
// 运维以为关掉了，实际还在做不可逆写入。
func TestRunStallReaperNegativeMaxStallDisables(t *testing.T) {
	srv := &Server{elec: fakeLeader{leader: true}, log: discardLogger()}
	done := make(chan struct{})
	go func() {
		// ctx 永不取消：唯一的返回途径只能是「负值即关闭」这条分支。
		srv.RunStallReaper(context.Background(), time.Millisecond, -1)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("max-stall 为负时应立即返回（关闭），实际进了收割循环")
	}
}
