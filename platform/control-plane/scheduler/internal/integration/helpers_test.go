package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// newStore 建 store 并清空调度表，保证用例隔离（活库共享，禁用 t.Parallel）。
func newStore(t *testing.T) *store.Store {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, testDSN(t))
	if err != nil {
		t.Fatalf("连接 PG 失败: %v", err)
	}
	t.Cleanup(st.Close)
	if err := st.Init(ctx); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := st.Pool().Exec(ctx, `
		TRUNCATE scheduler_tasks, scheduler_dispatch_outbox, scheduler_nodes,
		         scheduler_reconcile_ledger, scheduler_task_attempts,
		         scheduler_control_commands, scheduler_leader_lease`); err != nil {
		t.Fatalf("清表失败: %v", err)
	}
	// TRUNCATE 删掉了预插租约行，重跑 DDL 恢复
	if err := st.Init(ctx); err != nil {
		t.Fatalf("重建租约行失败: %v", err)
	}
	return st
}

// waitFor 轮询条件直至超时（选举是异步循环，断言前先等它就位）。
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("条件在超时内未满足")
}

// rowCount 单值计数断言辅助。
func rowCount(t *testing.T, st *store.Store, query string) int {
	t.Helper()
	var n int
	if err := st.Pool().QueryRow(context.Background(), query).Scan(&n); err != nil {
		t.Fatalf("计数失败: %v", err)
	}
	return n
}
