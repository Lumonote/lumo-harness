package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// insertTask 直接写一行任务，绕过放置事务。这一组用例测的是**统计查询**本身，
// 用放置流程造数据会把被测对象和放置语义绑在一起：放置失败时无法判断是统计
// 查询坏了还是放置坏了。
func insertTask(t *testing.T, st *store.Store, taskID, state, clusterID string, createdAtMS int64) {
	t.Helper()
	if _, err := st.Pool().Exec(context.Background(), `
		INSERT INTO scheduler_tasks (task_id, realm, cluster_id, requires, state, created_at, updated_at)
		VALUES ($1, 'r1', $2, '[]', $3, $4, $4)`, taskID, clusterID, state, createdAtMS); err != nil {
		t.Fatalf("插入任务失败: %v", err)
	}
}

// TestNonTerminalStateCountsExcludesTerminalStates 钉住「不统计终态」这个决定。
// 终态行只增不减，一旦纳入统计，抓取路径就会随历史线性变慢；而终态计数对告警
// 没有可操作性，属于用真实成本换零信息。
func TestNonTerminalStateCountsExcludesTerminalStates(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertTask(t, st, "p1", "PENDING", "cn-north", now)
	insertTask(t, st, "p2", "PENDING", "cn-north", now)
	insertTask(t, st, "run", "RUNNING", "cn-north", now)
	insertTask(t, st, "q1", "PENDING", "cn-south", now)
	insertTask(t, st, "c1", "COMPLETED", "cn-north", now)
	insertTask(t, st, "f1", "FAILED", "cn-north", now)
	insertTask(t, st, "a1", "ABORTED", "cn-north", now)

	counts, err := st.NonTerminalStateCounts(context.Background())
	if err != nil {
		t.Fatalf("统计非终态任务失败: %v", err)
	}
	got := make(map[string]int64, len(counts))
	for _, row := range counts {
		got[row.State+"|"+row.ClusterID] = row.Count
	}
	if got["PENDING|cn-north"] != 2 {
		t.Fatalf("PENDING/cn-north 应为 2，实际 %d（全量 %v）", got["PENDING|cn-north"], got)
	}
	if got["RUNNING|cn-north"] != 1 {
		t.Fatalf("RUNNING/cn-north 应为 1，实际 %d（全量 %v）", got["RUNNING|cn-north"], got)
	}
	if got["PENDING|cn-south"] != 1 {
		t.Fatalf("按集群分组丢失了 cn-south（全量 %v）", got)
	}
	if len(got) != 3 {
		t.Fatalf("终态不该出现在结果里（全量 %v）", got)
	}
}

// TestOldestPendingByClusterIgnoresNonPendingStates 钉住的是「等待时长」的语义：
// 只有 PENDING 在等，RUNNING 已经在跑了。把活跃任务算进排队时长会让一个长跑
// 任务永久顶着一个巨大的「排队时间」，queue_backlog 因此变成噪声。
func TestOldestPendingByClusterIgnoresNonPendingStates(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertTask(t, st, "old", "PENDING", "cn-north", now-120_000)
	insertTask(t, st, "new", "PENDING", "cn-north", now-1_000)
	insertTask(t, st, "south", "PENDING", "cn-south", now-30_000)
	insertTask(t, st, "running", "RUNNING", "cn-north", now-600_000)

	waits, err := st.OldestPendingByCluster(context.Background())
	if err != nil {
		t.Fatalf("统计排队时长失败: %v", err)
	}
	got := make(map[string]float64, len(waits))
	for _, row := range waits {
		got[row.ClusterID] = row.Seconds
	}
	// 库端 now() 与用例本地时钟之间有毫秒级抖动，断言落在区间上而不是比精确值。
	if got["cn-north"] < 119 || got["cn-north"] > 126 {
		t.Fatalf("cn-north 的最久等待应约为 120s（取最早那条 PENDING），实际 %v", got["cn-north"])
	}
	if got["cn-south"] < 29 || got["cn-south"] > 36 {
		t.Fatalf("cn-south 的最久等待应约为 30s，实际 %v", got["cn-south"])
	}
	if len(got) != 2 {
		t.Fatalf("只应有排队任务的集群，实际 %v", got)
	}
}
