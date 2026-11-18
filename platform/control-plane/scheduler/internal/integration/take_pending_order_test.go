package integration_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 钉住取队列的**完整顺序**：跨队列按持久虚拟服务量做加权公平（平手看队首的
// 优先级与入队时刻），队列内按 EDF、优先级与入队时刻。换实现不得改变它。
//
// 期望顺序是按规则手算的，不是从实现的输出里录的。它在 deadline 改为只在队列内
// 生效时变过一次：此前三个带 deadline 的任务无条件排在最前（跨 realm）。
func TestTakePendingOrderIsStableAcrossBatches(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	queue := func(id, realm, q string, weight, priority int, deadline int64) {
		t.Helper()
		if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: id, Realm: realm, Queue: q, Weight: weight, Priority: priority, DeadlineMS: deadline}); err != nil {
			t.Fatal(err)
		}
		// created_at 取库端毫秒；拉开间隔让「先到先得」可判定。
		if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET created_at = created_at + (SELECT count(*) FROM scheduler_tasks) WHERE task_id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 5; i++ {
		queue(fmt.Sprintf("a%d", i), "r1", "a", 1, i%2, 0)
		queue(fmt.Sprintf("b%d", i), "r1", "b", 3, 0, 0)
		queue(fmt.Sprintf("c%d", i), "r2", "a", 2, 5-i, 0)
	}
	queue("d-late", "r1", "a", 1, 0, 9_000)
	queue("d-early", "r2", "b", 1, 0, 5_000)
	queue("d-early-hi", "r1", "b", 3, 9, 5_000)

	var got []string
	for batch := 0; batch < 4; batch++ {
		tasks, err := st.TakePending(ctx, l, 5, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range tasks {
			if !task.FromPending {
				t.Fatalf("%s 应标记为来自排队", task.TaskID)
			}
			got = append(got, task.TaskID)
		}
	}
	const want = "d-early-hi c0 d-late d-early b0 c1 b1 c2 a1 b2 b3 c3 b4 a3 c4 a0 a2 a4"
	if s := strings.Join(got, " "); s != want {
		t.Fatalf("取队列顺序变了:\n got  %s\n want %s", s, want)
	}
	var vf string
	if err := st.Pool().QueryRow(ctx, `SELECT string_agg(realm||'/'||queue||'='||round(virtual_finish::numeric,4), ' ' ORDER BY realm,queue) FROM scheduler_queue_fairness`).Scan(&vf); err != nil {
		t.Fatal(err)
	}
	const wantVF = "r1/a=6.0000 r1/b=2.0000 r2/a=2.5000 r2/b=1.0000"
	if vf != wantVF {
		t.Fatalf("持久虚拟服务量变了:\n got  %s\n want %s", vf, wantVF)
	}
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE state='PENDING' AND schedule_checks=1 AND next_check_at > 0`); n != 18 {
		t.Fatalf("每个被取走的任务都应记一次检查并进入重查间隔: %d", n)
	}
}

func takeOrder(t *testing.T, st interface {
	TakePending(context.Context, *domain.Lease, int, time.Duration) ([]domain.Task, error)
}, l *domain.Lease, limit int) string {
	t.Helper()
	tasks, err := st.TakePending(context.Background(), l, limit, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.TaskID)
	}
	return strings.Join(ids, " ")
}

// deadline 由请求体给出，任何调用方都能带。它只能在**自己的队列内**把任务往前排，
// 不能越过别的 realm / 队列的公平序——否则一个租户给每个任务带上很小的 deadline，
// 就排到了所有租户的无 deadline 任务前面，公平队列形同虚设。
func TestDeadlineDoesNotJumpOtherQueuesFairShare(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: "honest", Realm: "r1", Queue: "q"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"rush-1", "rush-2"} {
		if _, err := st.QueueTask(ctx, l, domain.Task{TaskID: id, Realm: "r2", Queue: "q", DeadlineMS: 1}); err != nil {
			t.Fatal(err)
		}
	}
	// r2 此前已经得到过更多服务：按公平序该轮到 r1。
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_queue_fairness SET virtual_finish = virtual_finish + 100 WHERE realm='r2'`); err != nil {
		t.Fatal(err)
	}

	if got := takeOrder(t, st, l, 1); got != "honest" {
		t.Fatalf("别的 realm 的 deadline 不得越过公平序，先取出的应是 honest，实际 %q", got)
	}
}

// 队列内仍然是 EDF：这是 deadline 剩下的全部含义，不能丢。
func TestDeadlineStillOrdersWithinItsOwnQueue(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	l, err := st.Acquire(ctx, "leader", 60000)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []domain.Task{
		{TaskID: "plain-hi", Realm: "r1", Queue: "q", Priority: 9},
		{TaskID: "late", Realm: "r1", Queue: "q", DeadlineMS: 9_000},
		{TaskID: "early", Realm: "r1", Queue: "q", DeadlineMS: 5_000},
	} {
		if _, err := st.QueueTask(ctx, l, task); err != nil {
			t.Fatal(err)
		}
	}
	if got := takeOrder(t, st, l, 3); got != "early late plain-hi" {
		t.Fatalf("队列内应先按 deadline 再按优先级，实际 %q", got)
	}
}
