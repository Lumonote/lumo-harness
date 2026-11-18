package integration_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/store"
)

// 准入锁的并发语义。
//
// 这些用例都用同一个手法把一次放置**停在事务中途**：另开一条连接锁住目标节点行，
// PlaceTask 过了围栏校验、走到槽位闸时就挂在那里——此刻它持有准入锁、尚未提交。
// 然后观察别的路径是被它挡住还是不受影响。断言「没被挡住」用带期限的 ctx，
// 断言「被挡住」用一段观察窗口；两者都不靠 sleep 猜时序。

const (
	blockedAtNodeRow = `%FROM scheduler_nodes WHERE node_id=$1 AND realm=$2 FOR UPDATE%`
	observeWindow    = 300 * time.Millisecond
	promptly         = 2 * time.Second
)

func sideConn(t *testing.T) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), testDSN(t))
	if err != nil {
		t.Fatalf("旁路连接失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func admissionNodes(t *testing.T, st *store.Store, cluster string, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if err := (&catalog.Pg{Pool: st.Pool()}).Upsert(context.Background(),
			domain.Node{NodeID: id, Realm: "r1", ClusterID: cluster, Capacity: 4, Capabilities: []string{"llm"}}); err != nil {
			t.Fatalf("登记节点失败: %v", err)
		}
	}
}

// holdNodeRow 锁住节点行；返回的函数放开它。
func holdNodeRow(t *testing.T, nodeID string) func() {
	t.Helper()
	conn := sideConn(t)
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("旁路事务失败: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM scheduler_nodes WHERE node_id=$1 FOR UPDATE`, nodeID); err != nil {
		t.Fatalf("锁节点行失败: %v", err)
	}
	released := false
	release := func() {
		if !released {
			released = true
			_ = tx.Rollback(ctx)
		}
	}
	t.Cleanup(release)
	return release
}

// waitLockWaiters 等到至少 n 个后端在等锁且其语句匹配 pattern。
func waitLockWaiters(t *testing.T, pattern string, n int) {
	t.Helper()
	conn := sideConn(t)
	waitFor(t, 5*time.Second, func() bool {
		var got int
		if err := conn.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, pattern).Scan(&got); err != nil {
			t.Fatalf("查等锁后端失败: %v", err)
		}
		return got >= n
	})
}

type placed struct {
	p   domain.Placement
	err error
}

func placeAsync(st *store.Store, lease *domain.Lease, task domain.Task, node string) <-chan placed {
	ch := make(chan placed, 1)
	go func() {
		p, err := st.PlaceTask(context.Background(), lease, task, node)
		ch <- placed{p, err}
	}()
	return ch
}

type leased struct {
	l   *domain.Lease
	err error
}

func leaseAsync(fn func(context.Context) (*domain.Lease, error)) <-chan leased {
	ch := make(chan leased, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		l, err := fn(ctx)
		ch <- leased{l, err}
	}()
	return ch
}

// stillPending 在观察窗口内 ch 没有结果。
func stillPending[T any](ch <-chan T) bool {
	select {
	case <-ch:
		return false
	case <-time.After(observeWindow):
		return true
	}
}

func admissionTask(id, cluster string) domain.Task {
	return domain.Task{TaskID: id, Realm: "r1", ClusterID: cluster, Requires: []domain.Requirement{{Key: "llm"}}}
}

// 续一把仍然有效的租约不改变「谁有权决策」，所以不该等在途放置：否则放置越忙，
// leader 越续不上租（压测里 64 并发时续租最大 1.76s，单次期限 2s）。
func TestLeaseRenewalDoesNotWaitForInFlightPlacement(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1")
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, lease, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)

	renewCtx, cancel := context.WithTimeout(ctx, promptly)
	defer cancel()
	renewed, err := st.Acquire(renewCtx, "node-a", 5000)
	if err != nil {
		t.Fatalf("续租被在途放置挡住: %v", err)
	}
	if renewed.FencingToken != lease.FencingToken {
		t.Fatalf("续租不该换 token: %d → %d", lease.FencingToken, renewed.FencingToken)
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("在途放置应成功: %v", r.err)
	}
}

// 不同节点上的放置互不相干：容量由各自的节点行锁保住，不需要全局串行。
func TestPlacementsOnDifferentNodesDoNotSerialize(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1", "N2")
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, lease, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)

	otherCtx, cancel := context.WithTimeout(ctx, promptly)
	defer cancel()
	p, err := st.PlaceTask(otherCtx, lease, admissionTask("t2", "c1"), "N2")
	if err != nil || p.NodeID != "N2" {
		t.Fatalf("另一节点上的放置被挡住: %+v err=%v", p, err)
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("在途放置应成功: %v", r.err)
	}
}

// follower 每个周期都会来问一次租约。它不该排到 leader 的在途放置后面（那会让它的
// 选举循环挂住），也不该因为排了队而让 leader 后续的放置停顿。
func TestFollowerPollNeitherWaitsNorStallsPlacements(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1", "N2")
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, lease, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)

	pollCtx, cancel := context.WithTimeout(ctx, promptly)
	defer cancel()
	if _, err := st.Acquire(pollCtx, "node-b", 5000); !errors.Is(err, domain.ErrNotAcquired) {
		t.Fatalf("follower 应立刻得到 ErrNotAcquired, got %v", err)
	}
	otherCtx, cancel2 := context.WithTimeout(ctx, promptly)
	defer cancel2()
	if _, err := st.PlaceTask(otherCtx, lease, admissionTask("t2", "c1"), "N2"); err != nil {
		t.Fatalf("follower 的询问不该让 leader 的放置停顿: %v", err)
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("在途放置应成功: %v", r.err)
	}
}

// **围栏的核心性质**：易主必须等在途放置提交。放置过了围栏校验之后租约才过期，
// 这一笔仍然属于旧 leader 的任期——新 leader 只能在它落定之后上任，否则旧任期的
// 写入会出现在新任期开始之后。
func TestTakeoverWaitsForInFlightPlacement(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1")
	a, err := st.Acquire(ctx, "node-a", 400)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, a, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)
	time.Sleep(500 * time.Millisecond) // a 的租约过期

	takeover := leaseAsync(func(ctx context.Context) (*domain.Lease, error) { return st.Acquire(ctx, "node-b", 5000) })
	if !stillPending(takeover) {
		t.Fatal("易主没有等在途放置：旧任期的写入会落在新任期开始之后")
	}
	release()
	r := <-inFlight
	if r.err != nil || r.p.FencingToken != a.FencingToken {
		t.Fatalf("在途放置应以旧 token 提交: %+v err=%v", r.p, r.err)
	}
	b := <-takeover
	if b.err != nil || b.l.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主应成功且 token+1: %+v err=%v", b.l, b.err)
	}
	var fo *domain.FencedOutError
	if _, err := st.PlaceTask(ctx, a, admissionTask("t2", "c1"), "N1"); !errors.As(err, &fo) {
		t.Fatalf("易主后旧租约应被围栏拒, got %v", err)
	}
}

// 过期租约**重新生效**与易主是同一类事件（都改变「此刻谁有权决策」），哪怕持有者没变。
// 降级放置的前提是「全局租约此刻无效」；全局 leader 断连后回来续上自己的旧租约时，
// 必须等这些在途的降级放置落定。
func TestExpiredGlobalLeaseRevivesOnlyAfterDegradedPlacementsSettle(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1")
	global, err := st.Acquire(ctx, "node-g", 300)
	if err != nil {
		t.Fatal(err)
	}
	local, err := st.AcquireCluster(ctx, "c1", "node-c", 5000)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond) // 全局租约过期，无人接管

	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, local, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)

	revive := leaseAsync(func(ctx context.Context) (*domain.Lease, error) { return st.Acquire(ctx, "node-g", 5000) })
	if !stillPending(revive) {
		t.Fatal("过期的全局租约在降级放置在途时重新生效了")
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("降级放置应成功: %v", r.err)
	}
	g := <-revive
	if g.err != nil || g.l.FencingToken != global.FencingToken {
		t.Fatalf("同一持有者取回租约不换 token: %+v err=%v", g.l, g.err)
	}
	if _, err := st.PlaceTask(ctx, local, admissionTask("t2", "c1"), "N1"); !errors.Is(err, domain.ErrGlobalLeaderActive) {
		t.Fatalf("全局租约恢复后降级放置应被拒, got %v", err)
	}
}

// 集群本地租约的易主同样要等在途的降级放置。
func TestClusterTakeoverWaitsForInFlightDegradedPlacement(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1")
	a, err := st.AcquireCluster(ctx, "c1", "node-a", 400)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, a, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)
	time.Sleep(500 * time.Millisecond)

	takeover := leaseAsync(func(ctx context.Context) (*domain.Lease, error) {
		return st.AcquireCluster(ctx, "c1", "node-b", 5000)
	})
	if !stillPending(takeover) {
		t.Fatal("集群租约易主没有等在途的降级放置")
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("在途降级放置应成功: %v", r.err)
	}
	if b := <-takeover; b.err != nil || b.l.FencingToken != a.FencingToken+1 {
		t.Fatalf("集群易主应成功且 token+1: %+v err=%v", b.l, b.err)
	}
}

// 同一个**新** task_id 的两次放置（客户端超时重试、两个请求同时到达）只能派发一次。
// 任务行还不存在时行锁锁不到东西，单飞必须另有着落。
func TestConcurrentPlacementOfSameNewTaskDispatchesOnce(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1", "N2")
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	first := placeAsync(st, lease, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)

	second := placeAsync(st, lease, admissionTask("t1", "c1"), "N2")
	if !stillPending(second) {
		t.Fatal("同一任务的第二次放置没有等第一次：两次都会派发")
	}
	release()
	a, b := <-first, <-second
	if a.err != nil || b.err != nil {
		t.Fatalf("两次放置都应返回: %v / %v", a.err, b.err)
	}
	if a.p.NodeID != "N1" || b.p.NodeID != "N1" || a.p.Attempt != 1 || b.p.Attempt != 1 {
		t.Fatalf("第二次应幂等返回第一次的放置: %+v / %+v", a.p, b.p)
	}
	if n := outboxCount(t, st, "t1"); n != 1 {
		t.Fatalf("同一任务派发了 %d 次", n)
	}
}

// 排他方（取队列、对账、清理、易主）一旦开始等，后来的放置必须排在它后面。
// 否则只要放置持续有重叠，排他方就永远等不到——这正是「租约行降成共享行锁」
// 在压测里的表现（续租与取队列 2s 超时）。
func TestQueuedExclusiveAdmissionIsNotOvertakenByNewPlacements(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1", "N2")
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, lease, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)

	drained := make(chan error, 1)
	go func() {
		_, err := st.TakePending(ctx, lease, 8, time.Second)
		drained <- err
	}()
	waitLockWaiters(t, `%`, 2) // 取队列也在等了

	late := placeAsync(st, lease, admissionTask("t2", "c1"), "N2")
	if !stillPending(late) {
		t.Fatal("后来的放置越过了正在等的排他方")
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("在途放置应成功: %v", r.err)
	}
	if err := <-drained; err != nil {
		t.Fatalf("取队列应成功: %v", err)
	}
	if r := <-late; r.err != nil {
		t.Fatalf("排在后面的放置最终应成功: %v", r.err)
	}
}

// 放置必须**先**取准入锁、**后**取任务锁。反过来：排在等待中的排他方后面的放置已经
// 握着任务锁，而排他方在等的在途放置如果恰好在等这把任务锁，三者成环。
// 这里直接看锁表：排在排他方后面的那个放置不得持有任何任务锁。
func TestPlacementQueuedBehindExclusiveHoldsNoTaskLock(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1", "N2")
	lease, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, lease, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)
	drained := make(chan error, 1)
	go func() {
		_, err := st.TakePending(ctx, lease, 8, time.Second)
		drained <- err
	}()
	waitLockWaiters(t, `%`, 2)
	late := placeAsync(st, lease, admissionTask("t2", "c1"), "N2")
	waitLockWaiters(t, `%`, 3)

	// 双 int4 键的咨询锁（objsubid=2）就是任务锁；此刻只有在途的那一个放置该持有。
	var taskLocks int
	if err := sideConn(t).QueryRow(ctx, `SELECT count(*) FROM pg_locks
		WHERE locktype = 'advisory' AND objsubid = 2 AND granted
		  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`).Scan(&taskLocks); err != nil {
		t.Fatal(err)
	}
	if taskLocks != 1 {
		t.Fatalf("持有任务锁的事务数 = %d，应只有在途的那一个：排队中的放置先拿了任务锁", taskLocks)
	}
	release()
	for _, r := range []placed{<-inFlight, <-late} {
		if r.err != nil {
			t.Fatalf("放置最终应成功: %v", r.err)
		}
	}
	if err := <-drained; err != nil {
		t.Fatalf("取队列应成功: %v", err)
	}
}

// 围栏读租约必须发生在**拿到准入锁之后**，不能与取锁共用一个快照。
//
// 构造：全局租约已过期，全局 leader 正在取回它（握着排他锁、UPDATE 卡在一把旁路行锁上）；
// 此时一笔降级放置到达，排在排他锁后面。放开行锁后租约重新生效，降级放置拿到锁——
// 它必须看见「全局租约已有效」并被拒。若读租约用的是等锁之前的快照，它看到的还是
// 过期租约，会在全局 leader 已经复位之后把这一笔放下去。
func TestFencingReadsLeaseAfterAdmissionLockIsGranted(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1")
	if _, err := st.Acquire(ctx, "node-g", 300); err != nil {
		t.Fatal(err)
	}
	local, err := st.AcquireCluster(ctx, "c1", "node-c", 5000)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond) // 全局租约过期

	side := sideConn(t)
	tx, err := side.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM scheduler_leader_lease WHERE id=1 FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	revive := leaseAsync(func(ctx context.Context) (*domain.Lease, error) { return st.Acquire(ctx, "node-g", 5000) })
	waitLockWaiters(t, `%INSERT INTO scheduler_leader_lease%`, 1)
	degraded := placeAsync(st, local, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, `%`, 2)

	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if g := <-revive; g.err != nil {
		t.Fatalf("全局租约应取回: %v", g.err)
	}
	if r := <-degraded; !errors.Is(r.err, domain.ErrGlobalLeaderActive) {
		t.Fatalf("降级放置应看见已恢复的全局租约并被拒, got %+v err=%v", r.p, r.err)
	}
	if n := outboxCount(t, st, "t1"); n != 0 {
		t.Fatalf("被拒的降级放置派发了 %d 次", n)
	}
}

// 全局放置与集群本地的降级放置**不重叠**。
//
// 降级决策权不是靠一次「接管」拿到的：集群租约早就握在手里，全局租约一到期它就生效，
// 中间没有任何取排他锁的动作。所以「任期变更都在排他锁内」这条论证盖不住这个交接点，
// 得由降级放置自己取排他锁来等全局 leader 在途的那几笔落定——这也是
// cluster-remediation-2026-11-06 里「两条准入路径先锁同一把锁」的原意。
// 降级是罕见的兜底路径，串行的代价可以忽略。
func TestDegradedPlacementWaitsForInFlightGlobalPlacement(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	admissionNodes(t, st, "c1", "N1", "N2")
	global, err := st.Acquire(ctx, "node-g", 400)
	if err != nil {
		t.Fatal(err)
	}
	local, err := st.AcquireCluster(ctx, "c1", "node-c", 5000)
	if err != nil {
		t.Fatal(err)
	}
	release := holdNodeRow(t, "N1")
	inFlight := placeAsync(st, global, admissionTask("t1", "c1"), "N1")
	waitLockWaiters(t, blockedAtNodeRow, 1)
	time.Sleep(500 * time.Millisecond) // 全局租约过期，降级决策权随即生效

	degraded := placeAsync(st, local, admissionTask("t2", "c1"), "N2")
	if !stillPending(degraded) {
		t.Fatal("降级放置没有等全局 leader 的在途放置")
	}
	release()
	if r := <-inFlight; r.err != nil {
		t.Fatalf("全局 leader 的在途放置应成功: %v", r.err)
	}
	if r := <-degraded; r.err != nil || r.p.NodeID != "N2" {
		t.Fatalf("降级放置随后应成功: %+v err=%v", r.p, r.err)
	}
}
