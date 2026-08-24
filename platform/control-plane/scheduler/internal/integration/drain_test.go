package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/planner"
)

// TestSlotGateAndDrain spec §7 场景 7：槽位满 → 排队 PENDING；首任务终态后 drain 放置成功。
func TestSlotGateAndDrain(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "N1", ClusterID: "c1", Capacity: 1, Capabilities: []string{"llm"}}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
	l, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}

	t1 := domain.Task{TaskID: "t1", Realm: "r1", ClusterID: "c1"}
	t2 := domain.Task{TaskID: "t2", Realm: "r1", ClusterID: "c1", Priority: 5}
	if _, err := st.PlaceTask(ctx, l, t1, "N1"); err != nil {
		t.Fatalf("t1 放置失败: %v", err)
	}

	// 槽位满（cap 1）：直接放置拒绝，排队入 PENDING
	if _, err := st.PlaceTask(ctx, l, t2, "N1"); !errors.As(err, new(*domain.NoCapacityError)) {
		t.Fatalf("槽位满应 NoCapacity, got %v", err)
	}
	state, err := st.QueueTask(ctx, l, t2)
	if err != nil || state != domain.StatePending {
		t.Fatalf("t2 应排队 PENDING: %v err=%v", state, err)
	}
	if n := outboxCount(t, st, "t2"); n != 0 {
		t.Fatalf("排队任务不应有派发, got %d", n)
	}

	// 首任务终态 → 槽位释放 → drain：pending → 规划 → 放置
	if _, err := st.CompleteTask(ctx, "t1", domain.StateCompleted); err != nil {
		t.Fatalf("t1 回报终态失败: %v", err)
	}
	pending, err := st.PendingTasks(ctx, 10)
	if err != nil || len(pending) != 1 || pending[0].TaskID != "t2" {
		t.Fatalf("pending 应含 t2: %+v err=%v", pending, err)
	}
	nodes, err := cat.List(ctx)
	if err != nil {
		t.Fatalf("列节点失败: %v", err)
	}
	active, err := st.ActiveCounts(ctx)
	if err != nil {
		t.Fatalf("活跃计数失败: %v", err)
	}
	n := planner.Pick(pending[0], nodes, active)
	if n == nil {
		t.Fatal("槽位释放后应有候选节点")
	}
	p, err := st.PlaceTask(ctx, l, pending[0], n.NodeID)
	if err != nil || p.State != domain.StatePlaced || p.Attempt != 1 {
		t.Fatalf("drain 放置失败: %+v err=%v", p, err)
	}
	if n := outboxCount(t, st, "t2"); n != 1 {
		t.Fatalf("drain 放置应恰好 1 条派发, got %d", n)
	}

	// 派发认领闭环：节点取走全部未认领信封（t1 的派发始终未被认领），FIFO 顺序；
	// 二次认领为空。
	envs, err := st.ClaimDispatch(ctx, "N1", 10)
	if err != nil || len(envs) != 2 {
		t.Fatalf("认领应取回 t1、t2 两条: %+v err=%v", envs, err)
	}
	if envs[0].TaskID != "t1" || envs[1].TaskID != "t2" {
		t.Fatalf("认领应按 FIFO 返回 t1、t2: %+v", envs)
	}
	envs2, err := st.ClaimDispatch(ctx, "N1", 10)
	if err != nil || len(envs2) != 0 {
		t.Fatalf("二次认领应为空: %+v err=%v", envs2, err)
	}
}
