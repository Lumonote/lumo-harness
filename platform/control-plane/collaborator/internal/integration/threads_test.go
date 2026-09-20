package integration_test

// 线程档位（§24.2）的真 PG 集成。
//
// 这里只放**只有真库能确认**的事——纯判据（状态机、工作目录归属、节点丢失结论）已经在
// internal/domain 的单测里逐条覆盖。留下的是四件：
//
//  1. `threads_session` 唯一索引真的在库里（「同一个会话两行、各写一个 node_id」在数据面上
//     不可能存在，§14 验收判据 9 的后半句）；
//  2. 状态转移真的不动 node_id / session_ref / workspace（本包是唯一写入方，而 UPDATE 的
//     列清单里根本没有它们——这条断言就是那句承诺的取证）；
//  3. 节点丢失的上报真的按 node_id 拦（拿别的节点名关不掉这条线程）；
//  4. `init()` 连跑两次不报错、且表只有一份（§22.3 规则 1 的每表必测项）。
//
// 没有 LUMO_TEST_PG_DSN 时整文件跳过（skip 不是通过，见 vitest.setup.ts 的同款训诫）。

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func threadRow(id, sessionRef, nodeID string) domain.Thread {
	return domain.Thread{
		ID:                    id,
		Realm:                 "realm-1",
		ProjectID:             "proj-1",
		TaskID:                "task-7",
		CoordinatorSessionRef: "coord-1",
		SessionRef:            sessionRef,
		NodeID:                nodeID,
		Workspace:             domain.ThreadWorkspaceDir(id),
		State:                 domain.ThreadStateIdle,
	}
}

// init 幂等 + 唯一索引真的建出来了。
func TestThreadSchemaInitIsIdempotent(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	// newPGStore 已经 Init 过一次；再跑一次必须同样成功（CREATE ... IF NOT EXISTS）。
	if err := st.Init(ctx); err != nil {
		t.Fatalf("第二次 init 失败（DDL 不是幂等的）: %v", err)
	}
	// 约束名与 DDL 里的索引名逐字一致：库里没有它，就说明这条不变量只在文档里。
	if _, err := st.CreateThread(ctx, threadRow("t-1", "sess-1", "node-a")); err != nil {
		t.Fatalf("建线程失败: %v", err)
	}
	if _, err := st.CreateThread(ctx, threadRow("t-2", "sess-1", "node-b")); !errors.Is(err, store.ErrThreadSessionTaken) {
		t.Fatalf("同一 session_ref 写第二个 node_id 应被 threads_session 拦住，收到 %v", err)
	}
	if _, err := st.CreateThread(ctx, threadRow("t-1", "sess-9", "node-a")); !errors.Is(err, store.ErrThreadIDTaken) {
		t.Fatalf("同 id 应被主键拦住（且报的是 id 冲突而不是 session 冲突），收到 %v", err)
	}
}

// 「不假装可迁移」的取证：状态推进不碰 node_id / session_ref / workspace。
func TestThreadTransitionKeepsNodeAffinity(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	created, err := st.CreateThread(ctx, threadRow("t-1", "sess-1", "node-a"))
	if err != nil {
		t.Fatalf("建线程失败: %v", err)
	}
	if created.State != domain.ThreadStateIdle || created.Workspace != "thread/t-1/" {
		t.Fatalf("新建行不对: %+v", created)
	}

	running, err := st.TransitionThread(ctx, "realm-1", "t-1", domain.ThreadStateRunning)
	if err != nil {
		t.Fatalf("idle → running 应成功: %v", err)
	}
	for _, field := range []struct {
		name      string
		got, want string
	}{
		{"node_id", running.NodeID, "node-a"},
		{"session_ref", running.SessionRef, "sess-1"},
		{"workspace", running.Workspace, "thread/t-1/"},
		{"coordinator_session_ref", running.CoordinatorSessionRef, "coord-1"},
		{"task_id", running.TaskID, "task-7"},
	} {
		if field.got != field.want {
			t.Fatalf("状态推进改动了 %s：%q → %q（承载节点亲和不迁移）", field.name, field.want, field.got)
		}
	}
	if !running.UpdatedAt.After(created.CreatedAt) && !running.UpdatedAt.Equal(created.CreatedAt) {
		t.Fatalf("updated_at 应不早于 created_at: %s vs %s", running.UpdatedAt, created.CreatedAt)
	}

	// 非法边（终态不可复活）：done 之后再想回到 running 必须被拒。
	if _, err := st.TransitionThread(ctx, "realm-1", "t-1", domain.ThreadStateDone); err != nil {
		t.Fatalf("running → done 应成功: %v", err)
	}
	if _, err := st.TransitionThread(ctx, "realm-1", "t-1", domain.ThreadStateRunning); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("终态复活应被拒，收到 %v", err)
	}
	// 未跑过就等（idle → awaiting）：会造出「等一个从未 arm 的唤醒」。
	if _, err := st.CreateThread(ctx, threadRow("t-3", "sess-3", "node-a")); err != nil {
		t.Fatalf("建线程失败: %v", err)
	}
	if _, err := st.TransitionThread(ctx, "realm-1", "t-3", domain.ThreadStateAwaiting); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("idle → awaiting 应被拒（§8.1 的永不唤醒形状），收到 %v", err)
	}
}

// 节点丢失：按 node_id 拦，且终态行上的重复上报是幂等的。
func TestThreadNodeLoss(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	if _, err := st.CreateThread(ctx, threadRow("t-1", "sess-1", "node-a")); err != nil {
		t.Fatalf("建线程失败: %v", err)
	}
	if _, err := st.TransitionThread(ctx, "realm-1", "t-1", domain.ThreadStateRunning); err != nil {
		t.Fatalf("idle → running 应成功: %v", err)
	}

	// 拿别的节点名来关：必须失败——否则「节点丢失」就成了迁移入口。
	if _, err := st.FailThreadOnNodeLoss(ctx, "realm-1", "t-1", "node-b"); !errors.Is(err, store.ErrThreadNodeMismatch) {
		t.Fatalf("错节点的上报应被拒，收到 %v", err)
	}
	failed, err := st.FailThreadOnNodeLoss(ctx, "realm-1", "t-1", "node-a")
	if err != nil {
		t.Fatalf("正确节点的上报应成功: %v", err)
	}
	if failed.State != domain.ThreadStateFailed || failed.NodeID != "node-a" {
		t.Fatalf("节点丢失后应 failed 且 node_id 不变，收到 %+v", failed)
	}

	// 至少一次投递：同一个节点的丢失会被多个观察者各报一次。第二次必须是幂等的，
	// 且**不写库**（写一次 updated_at 会让看板上的静默时长失真）。
	again, err := st.FailThreadOnNodeLoss(ctx, "realm-1", "t-1", "node-a")
	if err != nil {
		t.Fatalf("重复上报应幂等而非报错: %v", err)
	}
	if !again.UpdatedAt.Equal(failed.UpdatedAt) {
		t.Fatalf("重复上报改动了 updated_at：%s → %s", failed.UpdatedAt, again.UpdatedAt)
	}
}

// 按节点上报失联（§24.2.3(4) 的上报腿）+ 通知的产生与去重。
//
// 只有真库能确认三件事：一次上报**在同一个事务里**既改了状态又落了通知；重复上报不产生
// 第二条通知（靠 (realm, thread_id) 唯一索引，而不是靠调用方的自觉）；别的节点上的线程
// 一行都不动（否则一次上报会波及全集群）。
func TestFailThreadsOnNodeLossBulk(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	for _, spec := range []struct{ id, node string }{
		{"t-1", "node-a"}, {"t-2", "node-a"}, {"t-3", "node-b"},
	} {
		if _, err := st.CreateThread(ctx, threadRow(spec.id, "sess-"+spec.id, spec.node)); err != nil {
			t.Fatalf("建线程失败: %v", err)
		}
	}
	for _, id := range []string{"t-1", "t-2", "t-3"} {
		if _, err := st.TransitionThread(ctx, "realm-1", id, domain.ThreadStateRunning); err != nil {
			t.Fatalf("推进 %s 失败: %v", id, err)
		}
	}

	outcome, err := st.FailThreadsOnNodeLoss(ctx, "realm-1", "node-a")
	if err != nil {
		t.Fatalf("按节点上报应成功: %v", err)
	}
	if len(outcome.Failed) != 2 || len(outcome.Ignored) != 0 {
		t.Fatalf("node-a 上应有两条被终止，收到 %+v", outcome)
	}
	other, err := st.GetThread(ctx, "realm-1", "t-3")
	if err != nil {
		t.Fatalf("读 node-b 的线程失败: %v", err)
	}
	if other.State != domain.ThreadStateRunning {
		t.Fatalf("别的节点上的线程不得被这次上报波及，收到 %q", other.State)
	}

	notices, err := st.ListNodeLossNotices(ctx, "realm-1", 0, 0)
	if err != nil {
		t.Fatalf("读通知失败: %v", err)
	}
	if len(notices) != 2 {
		t.Fatalf("每个被终止的线程应有一条通知，收到 %+v", notices)
	}
	if notices[0].ThreadID != "t-1" || notices[1].ThreadID != "t-2" {
		t.Fatalf("通知应按 seq 升序返回，收到 %+v", notices)
	}
	first := notices[0]
	if first.NodeID != "node-a" || first.SessionRef != "sess-t-1" || first.CoordinatorSessionRef != "coord-1" {
		t.Fatalf("通知必须带上协调者与承载节点（否则无从投递、无从判断重派），收到 %+v", first)
	}
	if first.Reason == "" || first.Seq <= 0 {
		t.Fatalf("通知必须有可读理由与单调游标，收到 %+v", first)
	}

	// 至少一次投递：同一个节点会被多个观察者各报一次。第二次必须幂等，且不再产生通知。
	again, err := st.FailThreadsOnNodeLoss(ctx, "realm-1", "node-a")
	if err != nil {
		t.Fatalf("重复上报应幂等而非报错: %v", err)
	}
	if len(again.Failed) != 0 || len(again.Ignored) != 2 {
		t.Fatalf("重复上报应全部落入 ignored，收到 %+v", again)
	}
	after, err := st.ListNodeLossNotices(ctx, "realm-1", 0, 0)
	if err != nil || len(after) != 2 {
		t.Fatalf("重复上报不得产生第二条通知，收到 %d err=%v", len(after), err)
	}

	// 空 node_id 先被拒（否则一次拼错的调用会伪装成「这个节点上没有线程」）。
	if _, err := st.FailThreadsOnNodeLoss(ctx, "realm-1", "  "); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("空 node_id 应被拒，收到 %v", err)
	}
	// 跨 realm：空集而不是错误（上层无从用「查询报错」区分「不存在」与「越权」）。
	cross, err := st.ListNodeLossNotices(ctx, "realm-2", 0, 0)
	if err != nil || len(cross) != 0 {
		t.Fatalf("跨 realm 的通知应为空集，收到 %+v err=%v", cross, err)
	}
	crossOutcome, err := st.FailThreadsOnNodeLoss(ctx, "realm-2", "node-a")
	if err != nil || len(crossOutcome.Failed) != 0 {
		t.Fatalf("跨 realm 的上报不得动别的租户的线程，收到 %+v err=%v", crossOutcome, err)
	}
}

// 通知游标：`seq` 严格大于 since，且 limit 有界。
//
// 用 `created_at > since` 拉增量时，同一毫秒里的其余几条会被永久跳过——而它们的线程
// 已经 failed、协调者却永远收不到通知。这条断言就是冲着那个形状去的。
func TestListNodeLossNoticesCursor(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	for _, id := range []string{"t-1", "t-2", "t-3"} {
		if _, err := st.CreateThread(ctx, threadRow(id, "sess-"+id, "node-a")); err != nil {
			t.Fatalf("建线程失败: %v", err)
		}
		if _, err := st.TransitionThread(ctx, "realm-1", id, domain.ThreadStateRunning); err != nil {
			t.Fatalf("推进失败: %v", err)
		}
	}
	if _, err := st.FailThreadsOnNodeLoss(ctx, "realm-1", "node-a"); err != nil {
		t.Fatalf("上报失败: %v", err)
	}
	all, err := st.ListNodeLossNotices(ctx, "realm-1", 0, 0)
	if err != nil || len(all) != 3 {
		t.Fatalf("应有三条通知，收到 %d err=%v", len(all), err)
	}
	// 三条在同一毫秒里产生：时间戳游标会漏，seq 不会。
	rest, err := st.ListNodeLossNotices(ctx, "realm-1", all[0].Seq, 0)
	if err != nil || len(rest) != 2 || rest[0].ThreadID != "t-2" {
		t.Fatalf("游标应严格大于 since，收到 %+v err=%v", rest, err)
	}
	limited, err := st.ListNodeLossNotices(ctx, "realm-1", 0, 1)
	if err != nil || len(limited) != 1 {
		t.Fatalf("limit 应生效，收到 %d err=%v", len(limited), err)
	}
	// 超界与非法值都收敛到默认上限，而不是放大成「一次全拉」。
	if _, err := st.ListNodeLossNotices(ctx, "realm-1", -5, 10_000); err != nil {
		t.Fatalf("非法游标/上限应收敛而不是报错: %v", err)
	}
}

// 通知只在 failed 的行上产生：给一条还在跑的线程发「节点没了」的通知，会让协调者重派
// 一条其实活着的线程（同一份工作出现两个执行者）。判据本体是纯函数，单测在 domain 包里。
func TestNodeLossNoticeFollowsFailure(t *testing.T) {
	notice, err := domain.NodeLossNoticeOf(domain.Thread{
		ID: "t-1", Realm: "realm-1", SessionRef: "sess-1",
		CoordinatorSessionRef: "coord-1", NodeID: "node-a", State: domain.ThreadStateFailed,
	}, "节点丢了")
	if err != nil {
		t.Fatalf("failed 的行应能派生通知: %v", err)
	}
	if notice.ThreadID != "t-1" || notice.NodeID != "node-a" || notice.Reason != "节点丢了" {
		t.Fatalf("通知字段不对: %+v", notice)
	}
}

// realm 是首要授权边界：跨 realm 读/写一律按「不存在」处理。
func TestThreadRealmIsolation(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	if _, err := st.CreateThread(ctx, threadRow("t-1", "sess-1", "node-a")); err != nil {
		t.Fatalf("建线程失败: %v", err)
	}
	if _, err := st.GetThread(ctx, "realm-2", "t-1"); !errors.Is(err, store.ErrThreadNotFound) {
		t.Fatalf("跨 realm 读应是「不存在」，收到 %v", err)
	}
	if _, err := st.TransitionThread(ctx, "realm-2", "t-1", domain.ThreadStateRunning); !errors.Is(err, store.ErrThreadNotFound) {
		t.Fatalf("跨 realm 写应是「不存在」，收到 %v", err)
	}
	if _, err := st.FailThreadOnNodeLoss(ctx, "realm-2", "t-1", "node-a"); !errors.Is(err, store.ErrThreadNotFound) {
		t.Fatalf("跨 realm 的节点丢失上报应是「不存在」，收到 %v", err)
	}
	// 空集而不是错误：上层无从用「查询报错」区分「不存在」与「越权」。
	list, err := st.ListThreads(ctx, "realm-2", "proj-1", "", 0)
	if err != nil || len(list) != 0 {
		t.Fatalf("跨 realm 列表应为空集，收到 %v err=%v", list, err)
	}
}

func TestListThreadsFilters(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	for _, id := range []string{"t-1", "t-2", "t-3"} {
		if _, err := st.CreateThread(ctx, threadRow(id, "sess-"+id, "node-a")); err != nil {
			t.Fatalf("建线程失败: %v", err)
		}
	}
	if _, err := st.TransitionThread(ctx, "realm-1", "t-2", domain.ThreadStateRunning); err != nil {
		t.Fatalf("推进失败: %v", err)
	}

	all, err := st.ListThreads(ctx, "realm-1", "proj-1", "", 0)
	if err != nil || len(all) != 3 {
		t.Fatalf("应按项目列出三条，收到 %d err=%v", len(all), err)
	}
	running, err := st.ListThreads(ctx, "realm-1", "proj-1", domain.ThreadStateRunning, 0)
	if err != nil || len(running) != 1 || running[0].ID != "t-2" {
		t.Fatalf("按 state 过滤应只剩 t-2，收到 %+v err=%v", running, err)
	}
	// 闭集外的 state 必须报错而不是返回空集：空集会让「拼错了」看起来像「确实没有」。
	if _, err := st.ListThreads(ctx, "realm-1", "proj-1", "paused", 0); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("闭集外的 state 应报错，收到 %v", err)
	}
	other, err := st.ListThreads(ctx, "realm-1", "proj-2", "", 0)
	if err != nil || len(other) != 0 {
		t.Fatalf("别的项目应为空集，收到 %d err=%v", len(other), err)
	}
}

// 建行前的判据在 store 层也要拦（不是只在 HTTP 层拦）：写库失败之后才发现非法，
// 库里会留下半条自洽的行。
func TestCreateThreadValidates(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	bad := threadRow("t-1", "sess-1", "node-a")
	bad.Workspace = "thread/t-2/" // 别人的目录
	if _, err := st.CreateThread(ctx, bad); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("错归属的工作目录应被拒，收到 %v", err)
	}
	badState := threadRow("t-4", "sess-4", "node-a")
	badState.State = domain.ThreadStateRunning
	if _, err := st.CreateThread(ctx, badState); !errors.Is(err, domain.ErrInvalidThread) {
		t.Fatalf("新建非 idle 行应被拒，收到 %v", err)
	}
	if _, err := st.FailThreadOnNodeLoss(ctx, "realm-1", "t-1", "  "); !errors.Is(err, domain.ErrInvalidThread) {
		// t-1 不存在，但空白 node_id 必须**先**被拒：否则一次拼错的调用会伪装成 404。
		t.Fatalf("空 node_id 应被拒，收到 %v", err)
	}
	if _, err := st.GetThread(ctx, "realm-1", "nope"); !errors.Is(err, store.ErrThreadNotFound) {
		t.Fatalf("不存在的 id 应是 not found，收到 %v", err)
	}
}

// `threads` 是 §11 的表：列名逐字照抄，谁改列名这里就会红。
func TestThreadsColumnsMatchDesign(t *testing.T) {
	_, pool := newPGStore(t)
	rows, err := pool.Query(context.Background(), `
		SELECT column_name FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'threads'
		ORDER BY ordinal_position`)
	if err != nil {
		t.Fatalf("读列名失败: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, name)
	}
	want := []string{"id", "realm", "project_id", "task_id", "coordinator_session_ref",
		"session_ref", "node_id", "workspace", "state", "created_at", "updated_at"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("threads 列与设计 §11 不一致:\n got %v\nwant %v", got, want)
	}
	// 索引名也要在：store 用它区分两类唯一冲突（threads_pkey vs threads_session），
	// 名字变了那两处判定会一起走进「未知约束」的 500 分支。
	var index string
	if err := pool.QueryRow(context.Background(), `
		SELECT indexname FROM pg_indexes
		WHERE schemaname = current_schema() AND indexname = 'threads_session'`).Scan(&index); err != nil {
		t.Fatalf("threads_session 索引不存在: %v", err)
	}
}
