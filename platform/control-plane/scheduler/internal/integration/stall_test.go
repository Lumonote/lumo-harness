package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// insertActive 直接写一行活跃任务 + 对应的 attempt 行，绕过放置事务。
//
// 两个 updated_at 分开传，是这个文件的核心：它们正是「停滞时钟该取哪一个」这个
// 决定的观测点。用放置流程造数据会把被测对象和放置语义绑在一起。
func insertActive(t *testing.T, st *store.Store, taskID, state, nodeID string, attempt int, taskUpdatedMS, attemptUpdatedMS int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, state, attempt, node_id, created_at, updated_at)
		VALUES ($1, 'r1', 'cn-north', '[]', $2, $3, $4, $5, $5)`,
		taskID, state, attempt, nodeID, taskUpdatedMS); err != nil {
		t.Fatalf("插入任务失败: %v", err)
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_task_attempts
			(task_id, attempt, realm, cluster_id, node_id, state, fencing_token, updated_at)
		VALUES ($1, $2, 'r1', 'cn-north', $3, $4, 0, $5)`,
		taskID, attempt, nodeID, state, attemptUpdatedMS); err != nil {
		t.Fatalf("插入 attempt 失败: %v", err)
	}
}

// TestStalledActiveTasksUsesAttemptClockNotTaskClock 钉住停滞时钟的来源。
//
// scheduler_tasks.updated_at 只在状态**跃迁**时前进（reconcile 里 stateRank 不
// 前进就不写它），所以一个正常跑了 10 小时的 RUNNING 任务和「卡死 10 小时」在它
// 眼里完全一样。拿它当停滞判据会成批误杀长任务——而终态不可回退，节点事后回报的
// 真实结果会被直接丢掉。这里造出「任务行很旧、attempt 行很新」，只有取 attempt
// 行才会得到一个小值。
func TestStalledActiveTasksUsesAttemptClockNotTaskClock(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertActive(t, st, "long-run", "RUNNING", "n1", 1, now-10*3600_000, now-3_000)

	rows, err := st.StalledActiveTasks(context.Background())
	if err != nil {
		t.Fatalf("查询活跃任务失败: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("应只有 1 条活跃任务，实际 %d 条", len(rows))
	}
	row := rows[0]
	if row.TaskID != "long-run" || row.Attempt != 1 || row.NodeID != "n1" {
		t.Fatalf("字段扫描不符: %+v", row)
	}
	// 库端 now() 与用例本地时钟有毫秒级抖动，断言落在区间上。
	if row.StalledMS < 0 || row.StalledMS > 30_000 {
		t.Fatalf("停滞时长应约 3s（attempt 行），实际 %d ms。"+
			"若取值来自 scheduler_tasks.updated_at，这里会是约 10 小时——那正是误杀长任务的成因", row.StalledMS)
	}
}

// TestStalledActiveTasksExcludesTerminalStates 终态不进结果集。
//
// 终态行只增不减，扫它们会让收割循环随历史线性变慢；而且终态任务本来就不该被
// 收割——它们已经不占槽位了。
func TestStalledActiveTasksExcludesTerminalStates(t *testing.T) {
	st := newStore(t)
	now := time.Now().UnixMilli()
	insertActive(t, st, "live", "RUNNING", "n1", 1, now, now)
	insertTask(t, st, "done", "COMPLETED", "cn-north", now)
	insertTask(t, st, "failed", "FAILED", "cn-north", now)
	insertTask(t, st, "aborted", "ABORTED", "cn-north", now)

	rows, err := st.StalledActiveTasks(context.Background())
	if err != nil {
		t.Fatalf("查询活跃任务失败: %v", err)
	}
	if len(rows) != 1 || rows[0].TaskID != "live" {
		t.Fatalf("只应有 live 一条活跃任务，实际 %+v", rows)
	}
}

// TestDeadLetterIsConditionalOnAttemptAndActiveState 钉住条件写的两个条件。
//
// 判定与落库之间隔着一次数据库往返和一轮目录刷新，把「刚才观察到的事实」当成
// 「现在仍然成立」是这类收割逻辑最常见的错法。条件不成立时必须**什么都不改**，
// 包括不写台账。
func TestDeadLetterIsConditionalOnAttemptAndActiveState(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	insertActive(t, st, "victim", "RUNNING", "gone", 2, now-9*3600_000, now-9*3600_000)
	insertTask(t, st, "finished", "COMPLETED", "cn-north", now)

	rec := func(taskID string, attempt int) store.DeadLetterRecord {
		return store.DeadLetterRecord{
			TaskID: taskID, Attempt: attempt, Realm: "r1", ClusterID: "cn-north",
			NodeID: "gone", Reason: "max_stall: 用例", StalledMS: 9 * 3600_000, SnapshotMS: 1234,
		}
	}

	// ① 旧的一代：期间已经开了新 attempt，绝不能改。
	ok, err := st.DeadLetter(ctx, rec("victim", 1))
	if err != nil {
		t.Fatalf("死信调用失败: %v", err)
	}
	if ok {
		t.Fatal("attempt 不符时不应完成死信转换")
	}

	// ② 终态任务：状态不活跃，同样不动。
	ok, err = st.DeadLetter(ctx, rec("finished", 0))
	if err != nil {
		t.Fatalf("死信调用失败: %v", err)
	}
	if ok {
		t.Fatal("终态任务不应被改成死信")
	}

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dead_letters`); n != 0 {
		t.Fatalf("条件不成立时不应写台账，实际 %d 行", n)
	}
	if got := taskState(t, st, "victim"); got != "RUNNING" {
		t.Fatalf("条件不成立时任务状态不应变化，实际 %s", got)
	}
	if got := taskState(t, st, "finished"); got != "COMPLETED" {
		t.Fatalf("终态任务不应被改动，实际 %s", got)
	}

	// ③ 正确的一代：转 FAILED 并落台账。
	ok, err = st.DeadLetter(ctx, rec("victim", 2))
	if err != nil {
		t.Fatalf("死信调用失败: %v", err)
	}
	if !ok {
		t.Fatal("条件全部成立时应完成死信转换")
	}
	if got := taskState(t, st, "victim"); got != string(domain.StateFailed) {
		t.Fatalf("死信后任务应为 FAILED，实际 %s", got)
	}

	// ④ 重复调用：状态已不活跃 → false，台账不能变成两行。
	ok, err = st.DeadLetter(ctx, rec("victim", 2))
	if err != nil {
		t.Fatalf("死信调用失败: %v", err)
	}
	if ok {
		t.Fatal("重复调用不应再产生一次转换")
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dead_letters`); n != 1 {
		t.Fatalf("台账应恰好 1 行，实际 %d 行", n)
	}
}

// TestDeadLetterRecordsTheEvidence 台账必须留下判据本身。
//
// 只把状态改成 FAILED 是不够的：那样它与「节点如实回报失败」在库里完全一样，
// 运维事后分不出谁放弃了、依据什么。而这个决定是在证据不充分时做出的（节点只是
// 不在目录里，不是被证明已死），所以依据必须可复核。
func TestDeadLetterRecordsTheEvidence(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	insertActive(t, st, "victim", "CANCELLING", "gone", 3, now-9*3600_000, now-9*3600_000)

	ok, err := st.DeadLetter(ctx, store.DeadLetterRecord{
		TaskID: "victim", Attempt: 3, Realm: "r1", ClusterID: "cn-north",
		NodeID: "gone", Reason: "max_stall: 所属节点已不在目录中",
		StalledMS: 32_400_000, SnapshotMS: 1_234,
	})
	if err != nil || !ok {
		t.Fatalf("死信调用失败: ok=%v err=%v", ok, err)
	}

	var nodeID, reason, clusterID string
	var stalledMS, snapshotMS int64
	if err := st.Pool().QueryRow(ctx, `
		SELECT node_id, reason, cluster_id, stalled_ms, snapshot_ms
		FROM scheduler_dead_letters WHERE task_id = 'victim' AND attempt = 3`).
		Scan(&nodeID, &reason, &clusterID, &stalledMS, &snapshotMS); err != nil {
		t.Fatalf("读台账失败: %v", err)
	}
	if nodeID != "gone" || clusterID != "cn-north" {
		t.Fatalf("台账应记下节点与集群: node=%q cluster=%q", nodeID, clusterID)
	}
	if reason == "" {
		t.Fatal("台账必须留下原因文本——否则事后无法区分「平台放弃」与「节点回报失败」")
	}
	if stalledMS != 32_400_000 || snapshotMS != 1_234 {
		t.Fatalf("台账应记下判定依据（停滞时长与快照年龄），实际 stalled=%d snapshot=%d", stalledMS, snapshotMS)
	}

	// attempt 行也必须跟着到终态：留着 RUNNING 会让「哪一代还活着」自相矛盾。
	var attemptState string
	if err := st.Pool().QueryRow(ctx, `
		SELECT state FROM scheduler_task_attempts WHERE task_id = 'victim' AND attempt = 3`).
		Scan(&attemptState); err != nil {
		t.Fatalf("读 attempt 失败: %v", err)
	}
	if attemptState != string(domain.StateFailed) {
		t.Fatalf("attempt 行应同步为 FAILED，实际 %s", attemptState)
	}

	recorded, err := st.DeadLetterRecorded(ctx, "victim", 3)
	if err != nil {
		t.Fatalf("查询台账失败: %v", err)
	}
	if !recorded {
		t.Fatal("DeadLetterRecorded 应报告已记录")
	}
	if recorded, err := st.DeadLetterRecorded(ctx, "victim", 4); err != nil || recorded {
		t.Fatalf("未记录的一代不应报告为已记录: recorded=%v err=%v", recorded, err)
	}
}

// taskState 读任务当前状态。
func taskState(t *testing.T, st *store.Store, taskID string) string {
	t.Helper()
	var state string
	if err := st.Pool().QueryRow(context.Background(),
		`SELECT state FROM scheduler_tasks WHERE task_id = $1`, taskID).Scan(&state); err != nil {
		t.Fatalf("读任务状态失败: %v", err)
	}
	return state
}
