package integration_test

import (
	"context"
	"os"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// testDSN 活库集成测试的入口闸：无 LUMO_TEST_PG_DSN 时跳过（离线环境友好）。
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过活库集成测试")
	}
	return dsn
}

// TestDDLIdempotent 建表幂等 + 调度表齐备 + 预插空租约行。
func TestDDLIdempotent(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testDSN(t))
	if err != nil {
		t.Fatalf("连接 PG 失败: %v", err)
	}
	t.Cleanup(st.Close)

	if err := st.Init(ctx); err != nil {
		t.Fatalf("首次建表失败: %v", err)
	}
	if err := st.Init(ctx); err != nil {
		t.Fatalf("二次建表（幂等）失败: %v", err)
	}

	for _, table := range []string{
		"scheduler_leader_lease", "scheduler_nodes", "scheduler_tasks",
		"scheduler_dispatch_outbox", "scheduler_reconcile_ledger", "scheduler_task_attempts",
		"scheduler_control_commands",
	} {
		var n int
		if err := st.Pool().QueryRow(ctx,
			`SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatalf("查表 %s 失败: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("表 %s 不存在", table)
		}
	}

	// 预插租约行存在且为空租约
	var holder string
	if err := st.Pool().QueryRow(ctx,
		`SELECT holder FROM scheduler_leader_lease WHERE id = 1`).Scan(&holder); err != nil {
		t.Fatalf("预插租约行缺失: %v", err)
	}
	if holder != "" {
		t.Fatalf("初始租约应为空, got %q", holder)
	}
}
