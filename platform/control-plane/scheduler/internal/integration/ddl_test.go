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
		"scheduler_control_commands", "scheduler_dead_letters", "scheduler_clusters",
		"scheduler_task_migrations",
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

	// 预插租约行存在且为空租约。
	//
	// 断言之前**必须自己复位这一行**：`scheduler_leader_lease` 是全局单行，而
	// 「holder 被写成了别人的实例名」这件事在本轮运行结束后仍然留着——`Release`
	// 只把 `expires_at` 置 0 以维持 token 高水位，**不清 holder**（见 `store.Release`），
	// 所以 TTL 过期也不等于这一行变空。任何先于本用例当过 leader 的用例都会把它留成
	// 自己的实例名。先 `TRUNCATE` 再重跑 `Init`（利用预插的 `ON CONFLICT DO NOTHING`）
	// 才能拿到「Init 会预插一条空租约行」这个**本用例自己的**前提。
	//
	// 这条复位是 2026-09-15 补的：本用例此前排在所有 leader 用例**之前**
	// （文件序 catalog/cluster < ddl < election/http），所以它一直看到空租约——
	// 结论正确但依据不是它自己的。当天新增的 `cluster_test.go` 排序在它之前且要当
	// leader，它立刻变红（`got "gate-test"`）。
	if _, err := st.Pool().Exec(ctx, `TRUNCATE scheduler_leader_lease`); err != nil {
		t.Fatalf("复位租约行失败: %v", err)
	}
	if err := st.Init(ctx); err != nil {
		t.Fatalf("复位后重建租约行失败: %v", err)
	}

	var holder string
	if err := st.Pool().QueryRow(ctx,
		`SELECT holder FROM scheduler_leader_lease WHERE id = 1`).Scan(&holder); err != nil {
		t.Fatalf("预插租约行缺失: %v", err)
	}
	if holder != "" {
		t.Fatalf("初始租约应为空, got %q", holder)
	}
}
