package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

func virtualFinish(t *testing.T, st *store.Store, queue string) float64 {
	t.Helper()
	var v float64
	if err := st.Pool().QueryRow(context.Background(), `SELECT virtual_finish FROM scheduler_queue_fairness WHERE realm='r1' AND queue=$1`, queue).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// 被选中却放不下的任务没有得到任何服务：它的队列不该为此被记账，否则一个队首
// 长期放不下的租户会在公平序里越排越后。
func TestDeferredTaskRefundsItsQueueVirtualService(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: "stuck", Realm: "r1", Queue: "a", Weight: 2}); err != nil {
		t.Fatal(err)
	}
	before := virtualFinish(t, st, "a")
	if tasks, err := st.TakePending(ctx, l, 8, time.Hour); err != nil || len(tasks) != 1 {
		t.Fatalf("take: %d %v", len(tasks), err)
	}
	if got := virtualFinish(t, st, "a"); got != before+0.5 {
		t.Fatalf("被选中时应记 1/weight: %v", got)
	}
	if err := st.DeferPending(ctx, "stuck", "no-capacity", time.Hour, time.Hour); err != nil {
		t.Fatal(err)
	}
	if got := virtualFinish(t, st, "a"); got != before {
		t.Fatalf("放不下应退还: got %v want %v", got, before)
	}
}

// 权重来自请求体；不设上限时一个调用方可以用极大的权重独占公平序。
func TestQueueWeightIsCapped(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: "greedy", Realm: "r1", Weight: 1 << 30}); err != nil {
		t.Fatal(err)
	}
	if n := rowCount(t, st, `SELECT weight FROM scheduler_tasks WHERE task_id='greedy'`); n != store.MaxQueueWeight {
		t.Fatalf("权重应被限制为 %d，实际 %d", store.MaxQueueWeight, n)
	}
}
