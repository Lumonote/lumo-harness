package integration_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// insertMigratable 写一行任务，绕过放置事务直接造数据。
//
// 与 stall_test.go 的 insertActive 分开而不是复用它：漂移的判据里
// **cluster_id 与 avoid_nodes 都是一等输入**（前者决定「属不属于失联集群」，
// 后者要被追加后写回），而 insertActive 把 cluster_id 写死成 'cn-north'、
// 不设 avoid_nodes。用放置流程造数据会把被测对象和放置语义绑在一起。
func insertMigratable(t *testing.T, st *store.Store, taskID, clusterID, state, nodeID string, attempt int, avoidNodes string) {
	t.Helper()
	if _, err := st.Pool().Exec(context.Background(), `
		INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, state, attempt, node_id, avoid_nodes,
			 created_at, updated_at)
		VALUES ($1, 'r1', $2, '[]', $3, $4, $5, $6, 0, 0)`,
		taskID, clusterID, state, attempt, nodeID, avoidNodes); err != nil {
		t.Fatalf("插入任务失败: %v", err)
	}
}

// insertDispatch 写一条派发行；claimed 为真时模拟「已认领但未送达」。
func insertDispatch(t *testing.T, st *store.Store, taskID string, attempt int, nodeID string, claimed bool) {
	t.Helper()
	ctx := context.Background()
	if claimed {
		if _, err := st.Pool().Exec(ctx, `
			INSERT INTO scheduler_dispatch_outbox (task_id, attempt, node_id, payload, claimed_by, claimed_at, created_at)
			VALUES ($1, $2, $3, '{}', 'reader', 1, 0)`, taskID, attempt, nodeID); err != nil {
			t.Fatalf("插入派发失败: %v", err)
		}
		return
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO scheduler_dispatch_outbox (task_id, attempt, node_id, payload, created_at)
		VALUES ($1, $2, $3, '{}', 0)`, taskID, attempt, nodeID); err != nil {
		t.Fatalf("插入派发失败: %v", err)
	}
}

// migrationRecord 造一条观测记录（与 server 侧构造的形状一致）。
func migrationRecord(taskID string, attempt int) store.MigrationRecord {
	return store.MigrationRecord{
		TaskID: taskID, Attempt: attempt, Realm: "r1",
		FromClusterID: "cn-north", FromNodeID: "n1",
		Reason: "cluster_down: 用例", ClusterAgeMS: 130_000, SnapshotMS: 1_234,
	}
}

// TestMigrateTaskReturnsTaskToGlobalQueue 漂移的语义：**解除旧绑定，不挑新位置**。
//
// 四处一起断言，因为它们是同一个决定的四个面：状态回 PENDING（drain 会接续）、
// node_id 清空（不再指向原节点）、cluster_id 清空（退回「任意集群」的退化形态，
// 让放置闸门自己去排除失联集群）、attempt **不动**（下一次放置才会开 attempt+1，
// 而 fencing 正靠这个）。
func TestMigrateTaskReturnsTaskToGlobalQueue(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertMigratable(t, st, "moving", "cn-north", "RUNNING", "n1", 2, `["old-node"]`)

	res, err := st.MigrateTask(ctx, migrationRecord("moving", 2))
	if err != nil {
		t.Fatalf("漂移失败: %v", err)
	}
	if !res.Applied {
		t.Fatal("条件全部成立时应完成漂移")
	}

	var state, clusterID, avoidNodes string
	var nodeID *string
	var attempt int
	if err := st.Pool().QueryRow(ctx, `
		SELECT state, cluster_id, node_id, attempt, avoid_nodes FROM scheduler_tasks
		WHERE task_id = 'moving'`).
		Scan(&state, &clusterID, &nodeID, &attempt, &avoidNodes); err != nil {
		t.Fatalf("读任务失败: %v", err)
	}
	if state != string(domain.StatePending) {
		t.Fatalf("漂移后应为 PENDING（drain 才会接续放置），实际 %s", state)
	}
	if nodeID != nil {
		t.Fatalf("漂移后 node_id 必须清空（否则 drain 会以为它还在原节点上跑），实际 %q", *nodeID)
	}
	if clusterID != "" {
		t.Fatalf("漂移后 cluster_id 必须清空（退回任意集群，由放置闸门排除失联集群），实际 %q", clusterID)
	}
	if attempt != 2 {
		t.Fatalf("漂移本身不应推进 attempt（下一次放置才 +1），实际 %d", attempt)
	}
	// 原有反亲和必须保留，原节点要被追进去——丢了前半句会静默放宽已有约束。
	for _, want := range []string{"old-node", "n1"} {
		if !containsJSON(avoidNodes, want) {
			t.Fatalf("反亲和名单应同时含 %q 与实际内容 %s", want, avoidNodes)
		}
	}
}

// TestMigratedTaskRejectsTheOldNodesResult fencing 的实证。
//
// §7.4.1 要求「跨集群重放置产生新 attempt 而非并行执行」。记录层面唯一能保证这
// 件事的地方就是这里：漂移把任务置回 PENDING 之后，原节点用旧 attempt 回报的终态
// **必须不生效**。不然原节点迟到的回报会把一个已经搬走的任务改回终态，而新位置的
// 执行还在跑——那正是「并行执行」。
//
// 用同一个库、同一代 attempt、同一份回报做**对照**：没被漂移的那条回报生效，
// 被漂移的那条不生效。差别只能来自漂移本身，排除了「回报路径本来就不工作」
// 这种解释。
func TestMigratedTaskRejectsTheOldNodesResult(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertMigratable(t, st, "moved", "cn-north", "RUNNING", "n1", 2, `[]`)
	insertMigratable(t, st, "stayed", "cn-north", "RUNNING", "n1", 2, `[]`)

	if res, err := st.MigrateTask(ctx, migrationRecord("moved", 2)); err != nil || !res.Applied {
		t.Fatalf("漂移失败: applied=%v err=%v", res.Applied, err)
	}

	// 原节点（旧 attempt=2）回报终态。
	pMoved, err := st.CompleteTaskAttempt(ctx, "moved", 2, domain.StateCompleted)
	if err != nil {
		t.Fatalf("回报失败: %v", err)
	}
	pStayed, err := st.CompleteTaskAttempt(ctx, "stayed", 2, domain.StateCompleted)
	if err != nil {
		t.Fatalf("回报失败: %v", err)
	}

	if pMoved.State != domain.StatePending {
		t.Fatalf("被漂移的任务不应接受旧节点的终态回报，实际变成 %s", pMoved.State)
	}
	if pStayed.State != domain.StateCompleted {
		t.Fatalf("对照组（未漂移）的回报应当生效，实际 %s——"+
			"若它也不生效，说明本用例证明的不是漂移提供的 fencing", pStayed.State)
	}
}

// TestMigrateTaskIsConditional 条件写的三个条件，任一不成立就什么都不改。
//
// 判定与落库之间隔着一次数据库往返：期间任务可能被推进（节点回报了终态、被取消、
// 重排队后被放到别的集群）。把「刚才观察到的事实」当成「现在仍然成立」是这类
// 收割逻辑最常见的错法，而后果是不可逆的——台账与状态都不该动。
func TestMigrateTaskIsConditional(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	insertMigratable(t, st, "newer", "cn-north", "RUNNING", "n1", 3, `[]`)         // ①代不符
	insertMigratable(t, st, "cancelling", "cn-north", "CANCELLING", "n1", 1, `[]`) // ②态不可漂
	insertMigratable(t, st, "elsewhere", "cn-east", "RUNNING", "n1", 1, `[]`)      // ③集群不符

	cases := []struct {
		taskID  string
		attempt int
		why     string
	}{
		{"newer", 2, "attempt 已是第 3 代，调用方观测的是第 2 代"},
		{"cancelling", 1, "CANCELLING 不在可漂移状态里（漂走等于丢掉那次取消）"},
		{"elsewhere", 1, "任务已不属于被判定失联的集群"},
	}
	for _, c := range cases {
		res, err := st.MigrateTask(ctx, migrationRecord(c.taskID, c.attempt))
		if err != nil {
			t.Fatalf("%s: 漂移调用失败: %v", c.why, err)
		}
		if res.Applied {
			t.Fatalf("%s: 条件不成立时不应漂移", c.why)
		}
	}

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_task_migrations`); n != 0 {
		t.Fatalf("条件不成立时不应写台账，实际 %d 行", n)
	}
	if got := taskState(t, st, "newer"); got != "RUNNING" {
		t.Fatalf("条件不成立时任务状态不应变化，实际 %s", got)
	}
	if got := taskState(t, st, "elsewhere"); got != "RUNNING" {
		t.Fatalf("不属于失联集群的任务不应被动，实际 %s", got)
	}
	// 集群号也不能被动：它是条件③ 的输入，被改了会让下一轮判据全部失真。
	var clusterID string
	if err := st.Pool().QueryRow(ctx, `
		SELECT cluster_id FROM scheduler_tasks WHERE task_id = 'elsewhere'`).Scan(&clusterID); err != nil {
		t.Fatalf("读任务失败: %v", err)
	}
	if clusterID != "cn-east" {
		t.Fatalf("不属于失联集群的任务 cluster_id 不应变化，实际 %q", clusterID)
	}

	// 重复调用同一份观测：第一次生效、第二次什么都不做（幂等）。
	if res, err := st.MigrateTask(ctx, migrationRecord("newer", 3)); err != nil || !res.Applied {
		t.Fatalf("正确的一代应完成漂移: applied=%v err=%v", res.Applied, err)
	}
	if res, err := st.MigrateTask(ctx, migrationRecord("newer", 3)); err != nil || res.Applied {
		t.Fatalf("重复提交同一份观测应什么都不做: applied=%v err=%v", res.Applied, err)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_task_migrations`); n != 1 {
		t.Fatalf("台账应恰好 1 行，实际 %d 行", n)
	}
}

// TestMigrateTaskVoidsUnclaimedDispatchOnly 漂移必须顺手堵掉 outbox 这个后门。
//
// `ClaimDispatch` 只看 `node_id + claimed_by IS NULL + delivered_at IS NULL`——
// **它不看任务状态**。所以一条还没被认领的旧 attempt 派发行，在漂移之后仍会被
// 投给原节点，把 fencing 从后门绕过去。
//
// 已认领的行**不能删**：那条 RPC 可能已经发出或正在发，删行只会让本地账目与实际
// 不符；它的回收路径已被 `RequeueStaleDispatch` 的 EXISTS 守卫挡住（漂移后
// state=PENDING），留着是安全的。
func TestMigrateTaskVoidsUnclaimedDispatchOnly(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertMigratable(t, st, "moving", "cn-north", "RUNNING", "n1", 1, `[]`)
	insertDispatch(t, st, "moving", 1, "n1", false) // 未认领：必须被删
	insertDispatch(t, st, "moving", 1, "n1", true)  // 已认领：必须留着

	res, err := st.MigrateTask(ctx, migrationRecord("moving", 1))
	if err != nil {
		t.Fatalf("漂移失败: %v", err)
	}
	if !res.Applied {
		t.Fatal("条件成立时应完成漂移")
	}
	if res.VoidedDispatches != 1 {
		t.Fatalf("应恰好作废 1 条未认领派发，实际 %d", res.VoidedDispatches)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = 'moving'`); n != 1 {
		t.Fatalf("已认领的那条必须留着，实际剩 %d 行", n)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_dispatch_outbox WHERE task_id = 'moving' AND claimed_by IS NOT NULL`); n != 1 {
		t.Fatalf("留下的应是已认领那条，实际 %d 行", n)
	}
}

// TestMigrationRecordsTheEvidence 台账必须留下判据本身。
//
// 漂移与死信最大的差别是**它不是终点**（任务随后会被重新放置，还可能成功），
// 所以事后追问「这批任务为什么跑到别的集群去了」时，库里唯一还留着答案的地方
// 就是这里——`scheduler_tasks.cluster_id` 已经被清空了。
func TestMigrationRecordsTheEvidence(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	insertMigratable(t, st, "moved", "cn-north", "RUNNING", "n1", 4, `[]`)

	rec := migrationRecord("moved", 4)
	rec.Reason = "cluster_down: 所属集群超过自报阈值，任务漂回全局队列重放置"
	if res, err := st.MigrateTask(ctx, rec); err != nil || !res.Applied {
		t.Fatalf("漂移失败: applied=%v err=%v", res.Applied, err)
	}

	var fromCluster, fromNode, reason string
	var clusterAgeMS, snapshotMS int64
	if err := st.Pool().QueryRow(ctx, `
		SELECT from_cluster_id, from_node_id, reason, cluster_age_ms, snapshot_ms
		FROM scheduler_task_migrations WHERE task_id = 'moved' AND attempt = 4`).
		Scan(&fromCluster, &fromNode, &reason, &clusterAgeMS, &snapshotMS); err != nil {
		t.Fatalf("读台账失败: %v", err)
	}
	if fromCluster != "cn-north" || fromNode != "n1" {
		t.Fatalf("台账应记下来源集群与节点（cluster_id 已被清空，这是唯一线索）：%q %q", fromCluster, fromNode)
	}
	if reason == "" {
		t.Fatal("台账必须留下原因文本")
	}
	if clusterAgeMS != 130_000 || snapshotMS != 1_234 {
		t.Fatalf("台账应记下判定依据（自报年龄与快照年龄），实际 age=%d snapshot=%d", clusterAgeMS, snapshotMS)
	}

	if recorded, err := st.MigrationRecorded(ctx, "moved", 4); err != nil || !recorded {
		t.Fatalf("MigrationRecorded 应报告已记录: recorded=%v err=%v", recorded, err)
	}
	if recorded, err := st.MigrationRecorded(ctx, "moved", 5); err != nil || recorded {
		t.Fatalf("未记录的一代不应报告为已记录: recorded=%v err=%v", recorded, err)
	}
}

// TestMigratableActiveTasksScope 候选集的范围：只有「这些集群上的、可漂移态的」。
//
// 三件事一起钉住：CANCELLING 不在内（漂走等于丢掉那次取消）、别的集群不在内
// （不属于本次判定的射程）、终态不在内（它们不占槽位也不该被搬家）。
// 空集群列表要短路成空集而不是 `= ANY('{}')`——省一次往返，也让调用方不必先判空。
func TestMigratableActiveTasksScope(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	now := time.Now().UnixMilli()
	insertMigratable(t, st, "placed", "cn-north", "PLACED", "n1", 1, `[]`)
	insertMigratable(t, st, "running", "cn-north", "RUNNING", "n1", 1, `[]`)
	insertMigratable(t, st, "cancelling", "cn-north", "CANCELLING", "n1", 1, `[]`)
	insertMigratable(t, st, "other-cluster", "cn-east", "RUNNING", "n9", 1, `[]`)
	insertTask(t, st, "done", "COMPLETED", "cn-north", now)

	rows, err := st.MigratableActiveTasks(ctx, []string{"cn-north"})
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	got := make(map[string]bool, len(rows))
	for _, r := range rows {
		got[r.TaskID] = true
		if r.ClusterID != "cn-north" {
			t.Fatalf("不应返回别的集群的任务: %s", r.ClusterID)
		}
	}
	if len(got) != 2 || !got["placed"] || !got["running"] {
		t.Fatalf("应恰好返回 placed 与 running，实际 %v", got)
	}

	empty, err := st.MigratableActiveTasks(ctx, nil)
	if err != nil {
		t.Fatalf("空集群列表失败: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("空集群列表应短路成空集，实际 %d 条", len(empty))
	}
}

// containsJSON 判断 JSON 数组文本里是否含某个元素。
//
// 断言用字符串匹配而不是 json.Unmarshal：断言要能在实现写出坏 JSON 时**失败**，
// 用同一个解析器会让「两边一起错」看起来像通过。两侧引号一起匹配，所以
// `"n1"` 不会误配 `"n11"`。
func containsJSON(arr, wanted string) bool {
	return strings.Contains(arr, `"`+wanted+`"`)
}
