package domain

import (
	"errors"
	"strings"
	"testing"
)

// §24.2 判据：状态是闭集，闭集外一律拒绝，且错误里要带上合法取值。
func TestValidThreadStateClosedSet(t *testing.T) {
	for _, state := range ThreadStates {
		if err := ValidThreadState(state); err != nil {
			t.Fatalf("%s 应合法: %v", state, err)
		}
	}
	// `failed` 必须在闭集里：§24.2.1 与 §7.1 的降级判据都是「终止并标记 failed」。
	// 它若被漏掉，节点丢失只能混进 stopped，而两者的处置相反。
	for _, want := range []ThreadState{ThreadStateIdle, ThreadStateRunning, ThreadStateAwaiting,
		ThreadStateStopped, ThreadStateDone, ThreadStateFailed} {
		if err := ValidThreadState(want); err != nil {
			t.Fatalf("闭集里必须有 %q: %v", want, err)
		}
	}
	for _, bad := range []ThreadState{"", "Running", "paused", "waiting ", "失败"} {
		err := ValidThreadState(bad)
		if err == nil {
			t.Fatalf("闭集外的 %q 应被拒绝", bad)
		}
		if !strings.Contains(err.Error(), "合法取值") {
			t.Fatalf("错误要列出合法取值（否则调用方无从修正）: %v", err)
		}
	}
	if len(ThreadStates) != 6 {
		t.Fatalf("闭集大小 %d，want 6", len(ThreadStates))
	}
}

// §24.2 判据：合法边逐条成立，且**终态无出边**（要续跑必须新建 Thread）。
func TestThreadTransitionTable(t *testing.T) {
	legal := []struct{ from, to ThreadState }{
		{ThreadStateIdle, ThreadStateRunning},
		{ThreadStateIdle, ThreadStateStopped},
		{ThreadStateIdle, ThreadStateFailed},
		{ThreadStateRunning, ThreadStateAwaiting},
		{ThreadStateRunning, ThreadStateDone},
		{ThreadStateRunning, ThreadStateStopped},
		{ThreadStateRunning, ThreadStateFailed},
		{ThreadStateAwaiting, ThreadStateRunning},
		{ThreadStateAwaiting, ThreadStateStopped},
		{ThreadStateAwaiting, ThreadStateFailed},
	}
	for _, edge := range legal {
		if err := ValidateThreadTransition(edge.from, edge.to); err != nil {
			t.Fatalf("%s → %s 应合法: %v", edge.from, edge.to, err)
		}
		if !CanThreadTransition(edge.from, edge.to) {
			t.Fatalf("CanThreadTransition(%s, %s) 应为 true", edge.from, edge.to)
		}
	}

	// 三条刻意不存在的边，各自的理由写在 thread.go 的表注释里。
	illegal := []struct {
		from, to ThreadState
		why      string
	}{
		{ThreadStateIdle, ThreadStateAwaiting, "没跑过就等 = 等一个从未 arm 的唤醒"},
		{ThreadStateAwaiting, ThreadStateDone, "完成必须来自一轮 Run（一轮 = 一个 Run）"},
		{ThreadStateStopped, ThreadStateRunning, "终态不可复活"},
		{ThreadStateDone, ThreadStateRunning, "终态不可复活"},
		{ThreadStateFailed, ThreadStateRunning, "failed 若能复活，节点丢失就变成了迁移"},
		{ThreadStateFailed, ThreadStateAwaiting, "同上"},
	}
	for _, edge := range illegal {
		err := ValidateThreadTransition(edge.from, edge.to)
		if err == nil {
			t.Fatalf("%s → %s 应被拒绝（%s）", edge.from, edge.to, edge.why)
		}
		if !errors.Is(err, ErrInvalidThread) {
			t.Fatalf("拒绝要是 ErrInvalidThread: %v", err)
		}
	}

	// 终态的出边集合必须为空——逐个状态断言，免得某天有人「顺手」加一条。
	for _, terminal := range []ThreadState{ThreadStateStopped, ThreadStateDone, ThreadStateFailed} {
		if !ThreadStateTerminal(terminal) {
			t.Fatalf("%s 应是终态", terminal)
		}
		for _, target := range ThreadStates {
			if CanThreadTransition(terminal, target) {
				t.Fatalf("终态 %s 不得有出边（到 %s）", terminal, target)
			}
		}
	}

	// 同态转移一律拒绝：重复投递（至少一次投递下必然出现）不是一次推进。
	if err := ValidateThreadTransition(ThreadStateRunning, ThreadStateRunning); err == nil {
		t.Fatal("同态转移应被拒绝（否则重复投递看起来像一次真实推进）")
	}
	// from 不在闭集里 = 存储被写脏了，报的必须是闭集错误而不是「非法转移」。
	err := ValidateThreadTransition("whatever", ThreadStateRunning)
	if err == nil || !strings.Contains(err.Error(), "合法取值") {
		t.Fatalf("脏 from 应报闭集错误（否则现场会去查状态机）: %v", err)
	}
}

// §24.2.2 判据：一轮 = 一个 Run，而线程此刻能不能开新一轮是纯判据。
func TestThreadAcceptsNewRound(t *testing.T) {
	yes := []ThreadState{ThreadStateIdle, ThreadStateAwaiting}
	no := []ThreadState{ThreadStateRunning, ThreadStateStopped, ThreadStateDone, ThreadStateFailed}
	for _, state := range yes {
		if !ThreadAcceptsNewRound(state) {
			t.Fatalf("%s 应接受新一轮", state)
		}
	}
	for _, state := range no {
		if ThreadAcceptsNewRound(state) {
			t.Fatalf("%s 不得接受新一轮", state)
		}
	}
}

func TestThreadRoundOf(t *testing.T) {
	base := Thread{ID: "t1", TaskID: "task-7", State: ThreadStateIdle}

	round, err := ThreadRoundOf(base, 1)
	if err != nil {
		t.Fatalf("idle 线程应能开第一轮: %v", err)
	}
	if round.TaskID != "task-7" || round.Attempt != 1 || round.Key() != "task-7#1" {
		t.Fatalf("轮次身份不对: %+v key=%s", round, round.Key())
	}

	waiting := base
	waiting.State = ThreadStateAwaiting
	if _, err := ThreadRoundOf(waiting, 2); err != nil {
		t.Fatalf("awaiting 线程被唤醒应能开新一轮: %v", err)
	}

	running := base
	running.State = ThreadStateRunning
	if _, err := ThreadRoundOf(running, 2); err == nil {
		t.Fatal("running 线程不得开第二轮（两轮会抢同一个工作目录）")
	}
	for _, terminal := range []ThreadState{ThreadStateStopped, ThreadStateDone, ThreadStateFailed} {
		row := base
		row.State = terminal
		if _, err := ThreadRoundOf(row, 2); err == nil {
			t.Fatalf("终态 %s 不得开新一轮（续跑必须新建 Thread）", terminal)
		}
	}

	// attempt 从 1 起：0 是「从未派发」，不是一个轮次。
	if _, err := ThreadRoundOf(base, 0); err == nil {
		t.Fatal("attempt=0 必须被拒绝（它永远不会与任何真实 Run 对上，成本会静默少一笔）")
	}
	noTask := base
	noTask.TaskID = ""
	if _, err := ThreadRoundOf(noTask, 1); err == nil {
		t.Fatal("没有 task_id 的线程开不出轮次")
	}
}

// §24.2.1 + §7.1 判据（§14 验收判据 9）：承载节点丢失 = failed + 重派新 Run，**不迁移**。
func TestThreadOnNodeLoss(t *testing.T) {
	base := Thread{ID: "t1", TaskID: "task-7", NodeID: "node-a", State: ThreadStateRunning}

	verdict, err := ThreadOnNodeLoss(base)
	if err != nil {
		t.Fatalf("正常行不该报错: %v", err)
	}
	if verdict.State != ThreadStateFailed || !verdict.ReassignRun || verdict.MigrateNode {
		t.Fatalf("节点丢失应 → failed + 重派 + 不迁移，收到 %+v", verdict)
	}
	if !strings.Contains(verdict.Reason, "node-a") {
		t.Fatalf("结论里要能看出是哪个节点丢了: %s", verdict.Reason)
	}

	// 非终态的各态一律 failed + 重派。
	for _, state := range []ThreadState{ThreadStateIdle, ThreadStateRunning, ThreadStateAwaiting} {
		t2 := base
		t2.State = state
		v, err := ThreadOnNodeLoss(t2)
		if err != nil || v.State != ThreadStateFailed || !v.ReassignRun || v.MigrateNode {
			t.Fatalf("%s 上节点丢失应 → failed + 重派: %+v err=%v", state, v, err)
		}
	}

	// 终态：幂等忽略（节点丢失是至少一次投递的通知；每次重派 = 无限重投）。
	for _, state := range []ThreadState{ThreadStateStopped, ThreadStateDone, ThreadStateFailed} {
		t2 := base
		t2.State = state
		v, err := ThreadOnNodeLoss(t2)
		if err != nil {
			t.Fatalf("终态 %s 上不该报错: %v", state, err)
		}
		if v.State != state || v.ReassignRun || v.MigrateNode {
			t.Fatalf("终态 %s 应原样保留且不重派，收到 %+v", state, v)
		}
	}

	// 没有承载节点的行：这是「还没放上去」，不是「节点丢了」——不能当丢失处理。
	noNode := base
	noNode.NodeID = ""
	if _, err := ThreadOnNodeLoss(noNode); err == nil {
		t.Fatal("没有 node_id 的行不得走节点丢失路径")
	}
}

// §24.3.2 判据：工作目录的归属是**等值**判据，且必须是相对路径。
func TestValidateThreadWorkspace(t *testing.T) {
	if got := ThreadWorkspaceDir("t1"); got != "thread/t1/" {
		t.Fatalf("工作目录形式应为 thread/<id>/，收到 %q", got)
	}
	if err := ValidateThreadWorkspace("t1", "thread/t1/"); err != nil {
		t.Fatalf("派生值应合法: %v", err)
	}

	rejected := map[string]string{
		"":                    "空目录",
		"thread/t2/":          "别人的目录（两个 Thread 共用一个目录 = 踩踏）",
		"thread/t10/":         "前缀相同但不是本行（前缀判据会放过它）",
		"thread/t1":           "少了尾斜杠",
		"/data/ws/thread/t1/": "绝对路径（节点局部事实不得写进被别的节点读的行）",
		"thread/t1/../t2/":    "越界",
		"thread\\t1\\":        "反斜杠",
		"C:/ws/thread/t1/":    "盘符",
	}
	for workspace, why := range rejected {
		if err := ValidateThreadWorkspace("t1", workspace); err == nil {
			t.Fatalf("workspace %q 应被拒绝（%s）", workspace, why)
		}
	}
}

// §11 判据：列照抄，非空列与 id 形态在写库之前就被判死。
// 节点失联通知的判据（§24.2.3(4) 的「通知协调者」腿）。
//
// 两条从严的判法，各自的代价都很具体：
//   - 给一条还在跑的线程发通知 → 协调者会重派一条其实活着的线程，同一份工作出现两个执行者；
//   - 通知缺协调者 ref → 送不到任何人手里，而它占掉的唯一索引 (realm, thread_id) 会让
//     同一线程**真正**的那条通知永远插不进来。
func TestNodeLossNoticeOf(t *testing.T) {
	failed := Thread{
		ID: "t-1", Realm: "realm-1", SessionRef: "sess-1",
		CoordinatorSessionRef: "coord-1", NodeID: "node-a", State: ThreadStateFailed,
	}
	notice, err := NodeLossNoticeOf(failed, "承载节点 node-a 丢失")
	if err != nil {
		t.Fatalf("failed 的行应能派生通知: %v", err)
	}
	if notice.ThreadID != "t-1" || notice.NodeID != "node-a" ||
		notice.SessionRef != "sess-1" || notice.CoordinatorSessionRef != "coord-1" ||
		notice.Realm != "realm-1" || notice.Reason != "承载节点 node-a 丢失" {
		t.Fatalf("通知字段与行不一致: %+v", notice)
	}

	// 非 failed 一律拒（含 idle/awaiting：它们都还活着）。
	for _, state := range []ThreadState{ThreadStateIdle, ThreadStateRunning, ThreadStateAwaiting, ThreadStateDone} {
		candidate := failed
		candidate.State = state
		if _, err := NodeLossNoticeOf(candidate, "r"); !errors.Is(err, ErrInvalidThread) {
			t.Fatalf("state=%s 不得派生通知，收到 %v", state, err)
		}
	}

	// 缺协调者 / 会话 / 节点 / realm：通知的用途就是被送达与归因，缺任何一项都送不到。
	missing := []Thread{
		{ID: "t-1", Realm: "realm-1", SessionRef: "sess-1", NodeID: "node-a", State: ThreadStateFailed},
		{ID: "t-1", Realm: "realm-1", SessionRef: "sess-1", CoordinatorSessionRef: "coord-1", State: ThreadStateFailed},
		{ID: "t-1", Realm: "realm-1", CoordinatorSessionRef: "coord-1", NodeID: "node-a", State: ThreadStateFailed},
		{ID: "t-1", SessionRef: "sess-1", CoordinatorSessionRef: "coord-1", NodeID: "node-a", State: ThreadStateFailed},
	}
	for index, row := range missing {
		if _, err := NodeLossNoticeOf(row, "r"); !errors.Is(err, ErrInvalidThread) {
			t.Fatalf("第 %d 个缺字段的行应被拒，收到 %v", index, err)
		}
	}
}

func TestValidateThreadCreate(t *testing.T) {
	valid := Thread{
		ID: "t-1", Realm: "r1", ProjectID: "proj_1", TaskID: "task-7",
		CoordinatorSessionRef: "coord-1", SessionRef: "sess-1",
		NodeID: "node-a", Workspace: "thread/t-1/", State: ThreadStateIdle,
	}
	if err := ValidateThreadCreate(valid); err != nil {
		t.Fatalf("合法行被拒: %v", err)
	}

	// 每一列的缺失都要单独能报出来（错误信息里带字段名，现场才知道补哪一列）。
	missing := []func(*Thread){
		func(row *Thread) { row.Realm = "" },
		func(row *Thread) { row.ProjectID = "" },
		func(row *Thread) { row.TaskID = "" },
		func(row *Thread) { row.CoordinatorSessionRef = "" },
		func(row *Thread) { row.SessionRef = "" },
		func(row *Thread) { row.NodeID = "" },
		func(row *Thread) { row.Workspace = "" },
	}
	for i, mutate := range missing {
		bad := valid
		mutate(&bad)
		if err := ValidateThreadCreate(bad); err == nil {
			t.Fatalf("第 %d 个缺列应被拒绝", i)
		}
	}

	// 新建必须 idle：一出生就 running 会让看板把「还没放上去」显示成「在执行」。
	for _, state := range []ThreadState{ThreadStateRunning, ThreadStateAwaiting, ThreadStateDone} {
		bad := valid
		bad.State = state
		if err := ValidateThreadCreate(bad); err == nil {
			t.Fatalf("新建状态 %s 应被拒绝", state)
		}
	}

	// id 会进 URL 路径段与工作目录段，含分隔符会让资源归属与路径归属脱钩。
	for _, bad := range []string{"", "t/1", "t 1", "..", "线程1", strings.Repeat("a", 129)} {
		badRow := valid
		badRow.ID = bad
		badRow.Workspace = ThreadWorkspaceDir(bad)
		if err := ValidateThreadCreate(badRow); err == nil {
			t.Fatalf("id %q 应被拒绝", bad)
		}
	}

	// session_ref 这类外部标识：只禁空白与 /（不预设 dsh 的会话语法）。
	for _, bad := range []string{"sess 1", "sess/1", "sess\n1"} {
		badRow := valid
		badRow.SessionRef = bad
		if err := ValidateThreadCreate(badRow); err == nil {
			t.Fatalf("session_ref %q 应被拒绝", bad)
		}
	}
	if err := ValidateThreadRef("session_ref", "sess:1#2"); err != nil {
		t.Fatalf("带分隔符的会话引用应放行（dsh 没有本平台约定的语法）: %v", err)
	}
}
