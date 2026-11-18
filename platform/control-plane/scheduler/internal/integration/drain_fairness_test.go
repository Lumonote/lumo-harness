package integration_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

var slowBackoff = server.DrainOptions{Batch: 64, Backoff: time.Hour, MaxBackoff: time.Hour}

func drainHarness(t *testing.T, capacity int, controlURL string) (*store.Store, *server.Server, *domain.Lease) {
	t.Helper()
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "N1", Realm: "r1", ClusterID: "c1", Capacity: capacity, ControlURL: controlURL}); err != nil {
		t.Fatal(err)
	}
	lease, err := st.Acquire(ctx, "drain-test", 60000)
	if err != nil {
		t.Fatal(err)
	}
	return st, server.New(st, &election.State{}, cat, discardLogger()), lease
}

func stateOf(t *testing.T, st *store.Store, taskID string) domain.TaskState {
	t.Helper()
	p, err := st.GetPlacement(context.Background(), taskID)
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", taskID, err)
	}
	return p.State
}

// 等容量的任务在退避里（最长 30s），而槽位释放是它唯一在等的事件：
// 释放之后的下一轮 drain 必须立刻重查它，而不是等退避走完。
func TestDrainRechecksCapacityWaitersAsSoonAsASlotFrees(t *testing.T) {
	st, api, lease := drainHarness(t, 1, "")
	ctx := context.Background()
	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "running", Realm: "r1"}, "N1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "waiter", Realm: "r1"}); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)
	if s := stateOf(t, st, "waiter"); s != domain.StatePending {
		t.Fatalf("节点已满，waiter 应仍在排队: %s", s)
	}
	api.Drain(ctx, lease, slowBackoff)
	if s := stateOf(t, st, "waiter"); s != domain.StatePending {
		t.Fatalf("没有槽位释放时不应绕过退避: %s", s)
	}

	if _, err := st.CompleteAssignedTask(ctx, "running", "r1", "N1", 1, domain.StateCompleted); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)
	if s := stateOf(t, st, "waiter"); s != domain.StatePlaced {
		t.Fatalf("槽位释放后的下一轮 drain 应放置 waiter，实际 %s", s)
	}
}

// 因别的原因排队的任务（没有兼容节点）不该被槽位释放唤醒：那不是它在等的事件。
func TestSlotReleaseDoesNotWakeIncompatibleWaiters(t *testing.T) {
	st, api, lease := drainHarness(t, 1, "")
	ctx := context.Background()
	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "running", Realm: "r1"}, "N1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "gpu", Realm: "r1", Requires: []domain.Requirement{{Key: "gpu"}}}); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)
	if _, err := st.CompleteAssignedTask(ctx, "running", "r1", "N1", 1, domain.StateCompleted); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)
	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id='gpu' AND schedule_checks=1`); n != 1 {
		t.Fatalf("不兼容的排队任务不应被重查")
	}
}

// 抢占此前只在提交那一刻尝试一次。排队之后才出现的低优先级占用者、以及投递失败
// 的停止命令，都要靠 drain 再试。
func TestDrainRequestsPreemptionForQueuedHighPriorityTask(t *testing.T) {
	var stops atomic.Int64
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.Path == "/subagent/stop" && strings.Contains(string(body), `"childId":"low"`) {
			stops.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer node.Close()
	st, api, lease := drainHarness(t, 1, node.URL)
	ctx := context.Background()
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "high", Realm: "r1", Priority: 9}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "low", Realm: "r1", Priority: 1}, "N1"); err != nil {
		t.Fatal(err)
	}

	api.Drain(ctx, lease, slowBackoff)

	if stops.Load() != 1 {
		t.Fatalf("drain 应向节点发出一次停止请求，实际 %d", stops.Load())
	}
	if s := stateOf(t, st, "low"); s != domain.StateCancelling {
		t.Fatalf("被抢占者应为 CANCELLING，实际 %s", s)
	}
	if s := stateOf(t, st, "high"); s != domain.StatePending {
		t.Fatalf("发起者在槽位真正释放前必须仍在排队，实际 %s", s)
	}
}

// 新提交不得越过已经在等容量的同优先级任务拿走刚释放的槽位。
func TestNewSubmissionQueuesBehindCapacityWaiter(t *testing.T) {
	st, api, lease := drainHarness(t, 1, "")
	ctx := context.Background()
	elec := &election.State{}
	api = server.New(st, elec, &catalog.Pg{Pool: st.Pool()}, discardLogger())
	eCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go election.Run(eCtx, elec, st, "drain-test", 60*time.Second, func(bool) {})
	waitFor(t, 2*time.Second, elec.IsLeader)
	ts := httptest.NewServer(api.Routes())
	defer ts.Close()

	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "running", Realm: "r1"}, "N1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "waiter", Realm: "r1"}); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)
	if _, err := st.CompleteAssignedTask(ctx, "running", "r1", "N1", 1, domain.StateCompleted); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/placements", strings.NewReader(`{"task_id":"newcomer"}`))
	req.Header.Set("X-Lumo-Realm", "r1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("有同优先级任务在等容量时，新提交应排队（202），实际 %d", resp.StatusCode)
	}
	api.Drain(ctx, lease, slowBackoff)
	if w, n := stateOf(t, st, "waiter"), stateOf(t, st, "newcomer"); w != domain.StatePlaced || n != domain.StatePending {
		t.Fatalf("槽位应归先到的 waiter: waiter=%s newcomer=%s", w, n)
	}
}

// 更高优先级的新提交不受此限：它本来就该排在前面。
func TestHigherPrioritySubmissionMayPassCapacityWaiter(t *testing.T) {
	st, _, lease := drainHarness(t, 2, "")
	ctx := context.Background()
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "waiter", Realm: "r1", Priority: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeferPending(ctx, "waiter", "no-capacity", time.Hour, time.Hour); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		priority int
		realm    string
		want     bool
	}{{1, "r1", true}, {0, "r1", true}, {2, "r1", false}, {1, "r2", false}} {
		got, err := st.CapacityWaiterAhead(ctx, domain.Task{TaskID: "x", Realm: c.realm, Priority: c.priority})
		if err != nil || got != c.want {
			t.Fatalf("priority=%d realm=%s: got %v want %v err=%v", c.priority, c.realm, got, c.want, err)
		}
	}
}

// 一轮 drain 里同一个 worker 的多个任务只问一次治理目录：逐任务串行询问会让
// 治理变慢时整轮 drain 被拖住。
func TestDrainAsksWorkerDirectoryOncePerWorkerPerRound(t *testing.T) {
	var calls atomic.Int64
	gov := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"realm":"r1","worker_id":"w1","node_ids":["N1"]}`))
	}))
	defer gov.Close()
	st, api, lease := drainHarness(t, 8, "")
	api.SetWorkerDirectory(catalog.WorkerDirectory{URL: gov.URL, Token: "t"})
	ctx := context.Background()
	for _, id := range []string{"g1", "g2", "g3"} {
		if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: id, Realm: "r1", WorkerID: "w1", ProjectID: "p1"}); err != nil {
			t.Fatal(err)
		}
	}
	api.Drain(ctx, lease, slowBackoff)
	if calls.Load() != 1 {
		t.Fatalf("同一 worker/项目一轮应只查询一次，实际 %d", calls.Load())
	}
	for _, id := range []string{"g1", "g2", "g3"} {
		if s := stateOf(t, st, id); s != domain.StatePlaced {
			t.Fatalf("%s 应已放置: %s", id, s)
		}
	}
}

// preemptionHarness 一个容量为 1、被低优先级任务占满的节点，以及一个已经为
// 高优先级任务 high 发起过抢占的调度器：low 处于 CANCELLING，high 在等它腾出的槽。
func preemptionHarness(t *testing.T) (*store.Store, *server.Server, *domain.Lease) {
	t.Helper()
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(node.Close)
	st, api, lease := drainHarness(t, 1, node.URL)
	ctx := context.Background()
	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "low", Realm: "r1", Priority: 1}, "N1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "high", Realm: "r1", Priority: 9, Queue: "qa"}); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)
	if s := stateOf(t, st, "low"); s != domain.StateCancelling {
		t.Fatalf("前置条件：low 应已被请求抢占（CANCELLING），实际 %s", s)
	}
	return st, api, lease
}

// 让队列在公平序里排到后面，模拟「它此前已经得到过更多服务」。
//
// 必须在对手队列的任务**入队之后**调用：新队列入队时会对齐到活跃队列里最小的
// 虚拟服务量，先推后入队等于把对手也一起推后，两边打平后按优先级排——那样这些
// 用例不需要任何预留就能通过。
func pushQueueBack(t *testing.T, st *store.Store, queue string) {
	t.Helper()
	if _, err := st.Pool().Exec(context.Background(),
		`UPDATE scheduler_queue_fairness SET virtual_finish = virtual_finish + 100 WHERE realm='r1' AND queue=$1`, queue); err != nil {
		t.Fatal(err)
	}
}

// 抢占腾出的槽必须留给发起抢占的任务。
//
// 取队列的全局顺序里公平序排在优先级之前，所以另一个队列的低优先级任务可以排在
// 发起者前面、拿走刚腾出的槽。后果不是「高优先级任务多等一会儿」：发起者下一轮
// 还是放不下，会再杀一个——被抢占者白死，而且每轮都可能再死一个。
func TestPreemptedSlotIsReservedForThePreemptor(t *testing.T) {
	st, api, lease := preemptionHarness(t)
	ctx := context.Background()
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "rival", Realm: "r1", Priority: 1, Queue: "qb"}); err != nil {
		t.Fatal(err)
	}
	pushQueueBack(t, st, "qa")

	if _, err := st.CompleteAssignedTask(ctx, "low", "r1", "N1", 1, domain.StateAborted); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)

	if s := stateOf(t, st, "rival"); s != domain.StatePending {
		t.Fatalf("另一个队列的低优先级任务不得拿走为 high 腾出的槽，实际 %s", s)
	}
	if s := stateOf(t, st, "high"); s != domain.StatePlaced {
		t.Fatalf("腾出的槽应归发起抢占的 high，实际 %s", s)
	}
}

// 预留只挡优先级不高于发起者的任务：更高优先级的任务本来就有权拿这个槽
// （它自己来也会发起抢占），挡住它只会多杀一个。
func TestHigherPriorityTaskMayTakeReservedSlot(t *testing.T) {
	st, api, lease := preemptionHarness(t)
	ctx := context.Background()
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "urgent", Realm: "r1", Priority: 20, Queue: "qb"}); err != nil {
		t.Fatal(err)
	}
	pushQueueBack(t, st, "qa")

	if _, err := st.CompleteAssignedTask(ctx, "low", "r1", "N1", 1, domain.StateAborted); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)

	if s := stateOf(t, st, "urgent"); s != domain.StatePlaced {
		t.Fatalf("优先级更高的任务应能拿到这个槽，实际 %s", s)
	}
}

// 发起者不再等容量（被取消、已放到别处）时，预留立即失效——否则这个槽会一直空着。
func TestReservationEndsWhenPreemptorStopsWaiting(t *testing.T) {
	st, api, lease := preemptionHarness(t)
	ctx := context.Background()
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "rival", Realm: "r1", Priority: 1, Queue: "qb"}); err != nil {
		t.Fatal(err)
	}
	pushQueueBack(t, st, "qa")
	if _, err := st.CompleteAssignedTask(ctx, "low", "r1", "N1", 1, domain.StateAborted); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordCancelIntent(ctx, "high"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RequestCancel(ctx, "high"); err != nil {
		t.Fatal(err)
	}
	if s := stateOf(t, st, "high"); s != domain.StateAborted {
		t.Fatalf("前置条件：排队中的 high 取消后应为 ABORTED，实际 %s", s)
	}

	api.Drain(ctx, lease, slowBackoff)

	if s := stateOf(t, st, "rival"); s != domain.StatePlaced {
		t.Fatalf("发起者已取消，槽位应放给其他任务，实际 %s", s)
	}
}

// reservedSlotWithRivalFirst 槽位已腾出、rival 在公平序里排在 high 前面。
// 之后用 Batch=1 的 drain 只取 rival，于是 high 不在本轮批次里——预留必须不依赖
// 「发起者恰好在同一批」才算数。
func reservedSlotWithRivalFirst(t *testing.T) (*store.Store, *server.Server, *domain.Lease) {
	t.Helper()
	st, api, lease := preemptionHarness(t)
	ctx := context.Background()
	if _, err := st.CompleteAssignedTask(ctx, "low", "r1", "N1", 1, domain.StateAborted); err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "rival", Realm: "r1", Priority: 1, Queue: "qb"}); err != nil {
		t.Fatal(err)
	}
	pushQueueBack(t, st, "qa")
	return st, api, lease
}

var onlyHead = server.DrainOptions{Batch: 1, Backoff: time.Second, MaxBackoff: 30 * time.Second}

// 发起者不在本轮批次里时，预留仍然挡得住低优先级任务。
func TestReservationHoldsWhenPreemptorIsNotInTheBatch(t *testing.T) {
	st, api, lease := reservedSlotWithRivalFirst(t)

	api.Drain(context.Background(), lease, onlyHead)

	if s := stateOf(t, st, "rival"); s != domain.StatePending {
		t.Fatalf("预留期内低优先级任务不得拿走这个槽，实际 %s", s)
	}
}

// 预留有期限：发起者一直在等容量、却始终没来拿这个槽（比如这个节点对它已不再
// 合格）时，不能让槽位永久空置。与上一条成对——只差槽位腾出的时刻，证明这条通过
// 靠的是「过期」而不是「预留根本没生效」。
func TestReservationExpires(t *testing.T) {
	st, api, lease := reservedSlotWithRivalFirst(t)
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_task_attempts SET updated_at = updated_at - 3600000 WHERE task_id='low'`); err != nil {
		t.Fatal(err)
	}

	api.Drain(ctx, lease, onlyHead)

	if s := stateOf(t, st, "rival"); s != domain.StatePlaced {
		t.Fatalf("预留过期后槽位应放给其他任务，实际 %s", s)
	}
}

// 一个等待者同一时间只应有一次未兑现的抢占。
//
// 停止不是瞬时的（节点要走完自己的收尾），而等待者每次被重查都还是「放不下」。
// 受害者筛选只排除「已有停止命令在途的那一个任务」，节点仍是满的，于是每重查一次
// 就会再挑一个受害者——为一个槽位杀掉一整个节点的低优先级任务。
func TestWaiterDoesNotPreemptTwiceWhileFirstVictimIsStopping(t *testing.T) {
	var stops atomic.Int64
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/subagent/stop" {
			stops.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer node.Close()
	st, api, lease := drainHarness(t, 2, node.URL)
	ctx := context.Background()
	for _, id := range []string{"low-a", "low-b"} {
		if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: id, Realm: "r1", Priority: 1}, "N1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "high", Realm: "r1", Priority: 9}); err != nil {
		t.Fatal(err)
	}

	api.Drain(ctx, lease, slowBackoff)
	// 退避走完、high 再次到期，而第一个受害者还没报终态。
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET next_check_at = 0 WHERE task_id='high'`); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id IN ('low-a','low-b') AND state='CANCELLING'`); n != 1 {
		t.Fatalf("同一个等待者只应有一个受害者在停止中，实际 %d 个", n)
	}
	if stops.Load() != 1 {
		t.Fatalf("只应向节点发出一次停止请求，实际 %d", stops.Load())
	}
}

// 「未兑现的抢占」不包括没送达的那次：停止请求投递失败时受害者还在跑，
// 等待者下一次被重查必须能重试，否则一次网络抖动就让它永远等下去。
func TestFailedStopDeliveryDoesNotBlockRetry(t *testing.T) {
	var stops atomic.Int64
	var healthy atomic.Bool
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/subagent/stop" {
			stops.Add(1)
			if !healthy.Load() {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer node.Close()
	st, api, lease := drainHarness(t, 1, node.URL)
	ctx := context.Background()
	if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: "low", Realm: "r1", Priority: 1}, "N1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "high", Realm: "r1", Priority: 9}); err != nil {
		t.Fatal(err)
	}

	api.Drain(ctx, lease, slowBackoff)
	if s := stateOf(t, st, "low"); s != domain.StatePlaced {
		t.Fatalf("前置条件：停止没送达，low 应仍在运行，实际 %s", s)
	}
	first := stops.Load()
	if first == 0 {
		t.Fatal("前置条件：第一轮应尝试过停止")
	}

	healthy.Store(true)
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET next_check_at = 0 WHERE task_id='high'`); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)

	if stops.Load() <= first {
		t.Fatalf("投递失败后应重试停止，实际没有新的请求")
	}
	if s := stateOf(t, st, "low"); s != domain.StateCancelling {
		t.Fatalf("重试送达后 low 应为 CANCELLING，实际 %s", s)
	}
}

// 在途的停止有期限：节点确认了停止却一直不回报终态时，等待者不能被这一个
// 卡死的受害者永久挡住。
func TestStuckVictimStopsBlockingAfterGrace(t *testing.T) {
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer node.Close()
	st, api, lease := drainHarness(t, 2, node.URL)
	ctx := context.Background()
	for _, id := range []string{"low-a", "low-b"} {
		if _, err := st.PlaceTask(ctx, lease, domain.Task{TaskID: id, Realm: "r1", Priority: 1}, "N1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.QueueTask(ctx, lease, domain.Task{TaskID: "high", Realm: "r1", Priority: 9}); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)

	// 一小时过去，第一个受害者仍是 CANCELLING。
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_control_commands SET updated_at = updated_at - 3600000`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE scheduler_tasks SET next_check_at = 0 WHERE task_id='high'`); err != nil {
		t.Fatal(err)
	}
	api.Drain(ctx, lease, slowBackoff)

	if n := rowCount(t, st, `SELECT count(*) FROM scheduler_tasks WHERE task_id IN ('low-a','low-b') AND state='CANCELLING'`); n != 2 {
		t.Fatalf("宽限期过后应允许再抢占一个，实际 %d 个在停止中", n)
	}
}
