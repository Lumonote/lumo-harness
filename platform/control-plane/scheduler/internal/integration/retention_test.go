package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// 放置热路径上的三条查询（事务内按节点数活跃任务、全表活跃计数、终态回报时
// 确认派发）此前没有可用索引，只能随历史全表扫。
func TestHotPathIndexesExist(t *testing.T) {
	st := newStore(t)
	for _, name := range []string{"idx_scheduler_tasks_active_node", "idx_outbox_task_attempt"} {
		if n := rowCount(t, st, `SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = '`+name+`'`); n != 1 {
			t.Fatalf("缺少索引 %s", name)
		}
	}
}

func insertOutbox(t *testing.T, st *store.Store, taskID string, attempt int, delivered bool) {
	t.Helper()
	var deliveredAt any
	if delivered {
		deliveredAt = int64(1)
	}
	if _, err := st.Pool().Exec(context.Background(), `
		INSERT INTO scheduler_dispatch_outbox (task_id, attempt, node_id, payload, delivered_at, created_at)
		VALUES ($1, $2, 'n1', '{}', $3, 1)`, taskID, attempt, deliveredAt); err != nil {
		t.Fatalf("插入派发失败: %v", err)
	}
}

func leaderLease(t *testing.T, st *store.Store) *domain.Lease {
	t.Helper()
	lease, err := st.Acquire(context.Background(), "retention-test", 60_000)
	if err != nil {
		t.Fatalf("取租约失败: %v", err)
	}
	return lease
}

// 只清「终态且足够老」的任务及其附属行；活跃任务、排队任务、近期终态一律不动。
func TestPurgeTerminalRemovesOnlyOldTerminalTasks(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	old := now - 40*24*3600_000
	insertActive(t, st, "old-done", "COMPLETED", "n1", 1, old, old)
	insertOutbox(t, st, "old-done", 1, true)
	if _, err := st.Pool().Exec(ctx, `INSERT INTO scheduler_control_commands
		(task_id,command,attempt,node_id,status,requested_at,updated_at) VALUES ('old-done','CANCEL',1,'n1','ACKNOWLEDGED',1,1)`); err != nil {
		t.Fatal(err)
	}
	insertActive(t, st, "old-running", "RUNNING", "n1", 1, old, old)
	insertOutbox(t, st, "old-running", 1, false)
	insertTask(t, st, "old-pending", "PENDING", "cn-north", old)
	insertActive(t, st, "recent-done", "COMPLETED", "n1", 1, now, now)

	purged, err := st.PurgeTerminal(ctx, leaderLease(t, st), 30*24*3600_000, 100)
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if purged != 1 {
		t.Fatalf("应只清掉 1 个任务，实际 %d", purged)
	}
	for _, table := range []string{"scheduler_tasks", "scheduler_task_attempts", "scheduler_dispatch_outbox", "scheduler_control_commands"} {
		if n := rowCount(t, st, `SELECT count(*) FROM `+table+` WHERE task_id='old-done'`); n != 0 {
			t.Fatalf("%s 里仍有 old-done 的行: %d", table, n)
		}
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks`); n != 3 {
		t.Fatalf("其余 3 个任务必须保留，实际 %d", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id='old-running'`); n != 1 {
		t.Fatalf("活跃任务的派发不得被清")
	}
}

// 每轮有上限：一次清理不能变成一条长事务。
func TestPurgeTerminalHonoursBatchLimit(t *testing.T) {
	st := newStore(t)
	old := time.Now().UnixMilli() - 40*24*3600_000
	for _, id := range []string{"a", "b", "c"} {
		insertTask(t, st, id, "FAILED", "cn-north", old)
	}
	purged, err := st.PurgeTerminal(context.Background(), leaderLease(t, st), 30*24*3600_000, 2)
	if err != nil || purged != 2 {
		t.Fatalf("应清 2 个: %d %v", purged, err)
	}
}

// 清理是不可逆写入，只有当前 leader 能做。
func TestPurgeTerminalRequiresLeadership(t *testing.T) {
	st := newStore(t)
	insertTask(t, st, "a", "FAILED", "cn-north", 1)
	stale := &domain.Lease{Holder: "nobody", FencingToken: 99}
	if _, err := st.PurgeTerminal(context.Background(), stale, 1000, 10); err == nil {
		t.Fatal("非 leader 不得清理")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks`); n != 1 {
		t.Fatal("非 leader 的清理不得删除任何行")
	}
}
