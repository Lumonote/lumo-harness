package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/dispatch"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// nodeN1 一个 cap 4 的单节点目录。
func nodeN1(t *testing.T, st *store.Store) {
	t.Helper()
	if err := (&catalog.Pg{Pool: st.Pool()}).Upsert(context.Background(),
		domain.Node{NodeID: "N1", ClusterID: "c1", Capacity: 4, Capabilities: []string{"llm"}}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
	}
}

func outboxCount(t *testing.T, st *store.Store, taskID string) int {
	t.Helper()
	return rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = '`+taskID+`'`)
}

// TestFencedOutPlacement spec §7 场景 3：旧 leader 被 fencing 拒写；接管后重放 attempt+1 而非双执行。
func TestFencedOutPlacement(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)

	a, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("a 建租失败: %v", err)
	}
	if err := st.Release(ctx, "node-a"); err != nil {
		t.Fatalf("a 释放失败: %v", err)
	}
	b, err := st.Acquire(ctx, "node-b", 5000) // 零等待接管，token = a+1
	if err != nil {
		t.Fatalf("b 接管失败: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}

	task := domain.Task{TaskID: "t1", Realm: "r1", ClusterID: "c1",
		Requires: []domain.Requirement{{Key: "llm"}}}

	// 旧 leader 用旧租约放置 → FencedOut
	_, err = st.PlaceTask(ctx, a, task, "N1")
	var fo *domain.FencedOutError
	if !errors.As(err, &fo) {
		t.Fatalf("旧 leader 放置应被 fencing 拒, got %v", err)
	}

	// 新 leader 放置成功
	p, err := st.PlaceTask(ctx, b, task, "N1")
	if err != nil || p.Attempt != 1 || p.State != domain.StatePlaced {
		t.Fatalf("新 leader 放置失败: %+v err=%v", p, err)
	}

	// 旧 attempt 终态后重放 → attempt+1
	if _, err := st.CompleteTask(ctx, "t1", domain.StateFailed); err != nil {
		t.Fatalf("回报终态失败: %v", err)
	}
	p2, err := st.PlaceTask(ctx, b, task, "N1")
	if err != nil || p2.Attempt != 2 {
		t.Fatalf("重放应 attempt+1: %+v err=%v", p2, err)
	}

	// 活跃 attempt 再重放 → 幂等返回既有放置，不产生双执行
	p3, err := st.PlaceTask(ctx, b, task, "N1")
	if err != nil || p3.Attempt != 2 || p3.NodeID != "N1" {
		t.Fatalf("活跃 attempt 应幂等返回: %+v err=%v", p3, err)
	}
	if n := outboxCount(t, st, "t1"); n != 2 {
		t.Fatalf("outbox 应恰好 2 条（每 attempt 一条）, got %d", n)
	}
}

// TestIdempotentResubmit spec §7 场景 5：同 task_id 重交只产生一次放置与一条 outbox。
func TestIdempotentResubmit(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}

	task := domain.Task{TaskID: "t1", Realm: "r1", ClusterID: "c1"}
	p1, err := st.PlaceTask(ctx, l, task, "N1")
	if err != nil {
		t.Fatalf("首放失败: %v", err)
	}
	p2, err := st.PlaceTask(ctx, l, task, "N1")
	if err != nil {
		t.Fatalf("重交失败: %v", err)
	}
	if p1.Attempt != p2.Attempt || p1.NodeID != p2.NodeID || p2.Attempt != 1 {
		t.Fatalf("重交应返回同一放置: %+v vs %+v", p1, p2)
	}
	if n := outboxCount(t, st, "t1"); n != 1 {
		t.Fatalf("outbox 应恰好 1 条, got %d", n)
	}
}

// TestCancelIntentAndTerminal reports the durable control command separately
// from the terminal task state: node acknowledgement means CANCELLING, while
// only an execution terminal report yields ABORTED.
func TestCancelIntentAndTerminal(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}
	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "cancel-me", Realm: "r1", ClusterID: "c1"}, "N1"); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	if err := st.RecordCancelIntent(ctx, "cancel-me"); err != nil {
		t.Fatalf("持久化取消命令失败: %v", err)
	}
	var commandState string
	if err := st.Pool().QueryRow(ctx, `SELECT status FROM scheduler_control_commands WHERE task_id='cancel-me' AND command='CANCEL'`).Scan(&commandState); err != nil {
		t.Fatalf("读取取消命令失败: %v", err)
	}
	if commandState != "REQUESTED" {
		t.Fatalf("取消命令初态应 REQUESTED, got %s", commandState)
	}
	p, err := st.RequestCancel(ctx, "cancel-me")
	if err != nil || p.State != domain.StateCancelling {
		t.Fatalf("节点确认后应 CANCELLING: %+v err=%v", p, err)
	}
	if err := st.Pool().QueryRow(ctx, `SELECT status FROM scheduler_control_commands WHERE task_id='cancel-me' AND command='CANCEL'`).Scan(&commandState); err != nil {
		t.Fatalf("读取确认取消命令失败: %v", err)
	}
	if commandState != "ACKNOWLEDGED" {
		t.Fatalf("节点确认后命令应 ACKNOWLEDGED, got %s", commandState)
	}
	p, err = st.CompleteTask(ctx, "cancel-me", domain.StateAborted)
	if err != nil || p.State != domain.StateAborted {
		t.Fatalf("终态回报应 ABORTED: %+v err=%v", p, err)
	}
}

// TestOutboxAtomicity spec §7 场景 8：放置 ⟺ 派发同事务，任一失败两行皆无。
func TestOutboxAtomicity(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	nodeN1(t, st)
	l, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("建租失败: %v", err)
	}

	// 故障 sink：派发写失败 → 整个放置回滚
	bad, err := store.NewWithSink(ctx, testDSN(t), failingSink{})
	if err != nil {
		t.Fatalf("建故障 store 失败: %v", err)
	}
	t.Cleanup(bad.Close)

	task := domain.Task{TaskID: "t-bad", Realm: "r1", ClusterID: "c1"}
	if _, err := bad.PlaceTask(ctx, l, task, "N1"); err == nil {
		t.Fatal("派发失败应导致放置失败")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id = 't-bad'`); n != 0 {
		t.Fatalf("失败放置的任务行应回滚, got %d 行", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = 't-bad'`); n != 0 {
		t.Fatalf("失败放置的 outbox 应回滚, got %d 行", n)
	}

	// 正常 sink：两行同在
	if _, err := st.PlaceTask(ctx, l, task, "N1"); err != nil {
		t.Fatalf("正常放置失败: %v", err)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id = 't-bad'`); n != 1 {
		t.Fatalf("任务行应在, got %d", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = 't-bad'`); n != 1 {
		t.Fatalf("outbox 行应在, got %d", n)
	}
}

type failingSink struct{}

func (failingSink) WriteInto(context.Context, pgx.Tx, dispatch.Envelope) error {
	return errors.New("sink 故障")
}
