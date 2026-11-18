package integration_test

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// 建表语句在一个事务里执行，其中每条 `ALTER TABLE ... IF NOT EXISTS` 即使什么都
// 不改也会拿到表的 ACCESS EXCLUSIVE 锁并持有到事务结束。所以这个事务里不能有
// 任何耗时随表大小增长的语句——否则每次滚动重启都会把放置路径堵住一次全表扫描
// 那么久。回填（按行改数据）必须在事务之外做。
func TestSchemaTransactionHasNoRowBackfill(t *testing.T) {
	if m := regexp.MustCompile(`(?m)^\s*(UPDATE|DELETE)\s`).FindString(store.DDL); m != "" {
		t.Fatalf("建表事务里不得有按行改数据的语句（会在持有 ACCESS EXCLUSIVE 锁时扫全表），发现 %q", m)
	}
}

// 回填挪出建表事务之后仍然必须发生：升级前写入的行（没有 requested/assigned
// 集群）在启动后要被补齐。
func TestInitStillBackfillsLegacyRows(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_nodes (node_id, realm, cluster_id, capacity, capabilities, registered_at)
		VALUES ('legacy-node', 'r1', 'cn-north', 4, '[]', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_tasks (task_id, realm, cluster_id, requires, priority, state, node_id, attempt, fencing_token, created_at, updated_at)
		VALUES ('legacy', 'r1', 'cn-north', '[]', 0, 'RUNNING', 'legacy-node', 1, 1, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_task_attempts (task_id, attempt, realm, cluster_id, node_id, state, fencing_token, updated_at)
		VALUES ('legacy', 1, 'r1', 'cn-north', 'legacy-node', 'RUNNING', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id='legacy' AND requested_cluster_id='' AND assigned_cluster_id=''`); n != 1 {
		t.Fatal("前置条件：升级前的行不带 requested/assigned 集群")
	}

	if err := st.Init(ctx); err != nil {
		t.Fatalf("Init: %v", err)
	}

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id='legacy' AND requested_cluster_id='cn-north' AND assigned_cluster_id='cn-north'`); n != 1 {
		t.Fatal("启动后任务行应被回填 requested/assigned 集群")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_task_attempts WHERE task_id='legacy' AND assigned_cluster_id='cn-north'`); n != 1 {
		t.Fatal("启动后 attempt 行应被回填 assigned 集群")
	}
}

func commandCheckOID(t *testing.T, st *store.Store) uint32 {
	t.Helper()
	var oid uint32
	if err := st.Pool().QueryRow(context.Background(), `
		SELECT oid FROM pg_constraint
		WHERE conname = 'scheduler_control_commands_command_check'
		  AND conrelid = 'scheduler_control_commands'::regclass`).Scan(&oid); err != nil {
		t.Fatalf("读取约束失败: %v", err)
	}
	return oid
}

// 约束已经是目标形态时，启动不得把它删掉重建：重建要在 ACCESS EXCLUSIVE 锁下
// 把整张表重新校验一遍。约束的 OID 不变即证明没有重建。
func TestInitDoesNotRebuildUpToDateCommandCheck(t *testing.T) {
	st := newStore(t)
	before := commandCheckOID(t, st)

	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}

	if after := commandCheckOID(t, st); after != before {
		t.Fatalf("约束已是目标形态，不应被重建（oid %d -> %d）", before, after)
	}
}

// 升级路径仍然成立：旧部署的约束只认 CANCEL，启动后必须认 PREEMPT。
func TestInitUpgradesLegacyCommandCheck(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `
		ALTER TABLE scheduler_control_commands DROP CONSTRAINT scheduler_control_commands_command_check;
		ALTER TABLE scheduler_control_commands ADD CONSTRAINT scheduler_control_commands_command_check
		  CHECK (command IN ('CANCEL'))`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Init(context.Background()) })

	if err := st.Init(ctx); err != nil {
		t.Fatalf("Init: %v", err)
	}

	now := time.Now().UnixMilli()
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_control_commands (task_id, command, status, requested_at, updated_at)
		VALUES ('t1', 'PREEMPT', 'REQUESTED', $1, $1)`, now); err != nil {
		t.Fatalf("升级后约束应接受 PREEMPT: %v", err)
	}
}
