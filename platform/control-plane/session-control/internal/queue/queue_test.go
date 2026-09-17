package queue

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/session-control/internal/state"
)

// fakeClock 让「持有超时」可以在毫秒内被测到。真实时钟下要测 30s 的 MaxHold，
// 只能把 MaxHold 配成很小——那样测的又不是生产配置了。
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newManager(t *testing.T, clock *fakeClock, maxHold, waitLimit time.Duration) *Manager {
	t.Helper()
	return NewManager(Options{MaxHold: maxHold, WaitLimit: waitLimit, Now: clock.Now})
}

// TestAcquireIsExclusive：同一会话同时只有一条脉冲在生效。
func TestAcquireIsExclusive(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, time.Second*5)

	first, err := m.Acquire(context.Background(), "s1", "a", state.CmdPause)
	if err != nil {
		t.Fatalf("第一条应立刻拿到: %v", err)
	}
	if first.Queued() {
		t.Fatal("第一条没有排队")
	}

	// 第二条不该拿到，直到第一条释放。
	done := make(chan *Grant, 1)
	go func() {
		grant, err := m.Acquire(context.Background(), "s1", "b", state.CmdStop)
		if err != nil {
			t.Errorf("第二条报错: %v", err)
			done <- nil
			return
		}
		done <- grant
	}()

	select {
	case <-done:
		t.Fatal("第一条还在生效中，第二条不该拿到")
	case <-time.After(80 * time.Millisecond):
	}

	first.Release()
	select {
	case grant := <-done:
		if grant == nil {
			t.Fatal("第二条没有拿到")
		}
		if !grant.Queued() {
			t.Fatal("第二条应标记为排过队")
		}
		grant.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后第二条没有被交接")
	}
}

// TestFIFOOrderIsRespected 是本包存在的核心理由之一。
//
// 用一把互斥锁 + 随机唤醒也能做到互斥，但唤醒顺序不保证——而人在面板上看到的是
// 「我排在第二」。顺序与显示不符不是性能问题，是控制台在说谎。
func TestFIFOOrderIsRespected(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, 5*time.Second)

	holder, err := m.Acquire(context.Background(), "s1", "holder", state.CmdPause)
	if err != nil {
		t.Fatalf("占位失败: %v", err)
	}

	const waiters = 4
	var (
		mu    sync.Mutex
		order []string
	)
	var wg sync.WaitGroup
	// **逐个**放进来并等到确认入队，再放下一个：一次把四个 goroutine 都放出去时，
	// 入队顺序由调度器决定，断言一个固定的 "abcd" 就是在断言 Go 的调度——那样的用例
	// 会随机红，而它对队列本身什么都没说。这里构造的是**确定的入队顺序**，
	// 于是「出队顺序必须等于入队顺序」才是对 FIFO 的真断言。
	for i := 0; i < waiters; i++ {
		id := string(rune('a' + i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			grant, err := m.Acquire(context.Background(), "s1", id, state.CmdStop)
			if err != nil {
				t.Errorf("等待者 %s 报错: %v", id, err)
				return
			}
			mu.Lock()
			order = append(order, id)
			mu.Unlock()
			grant.Release()
		}()
		waitForWaiting(t, m, "s1", i+1)
	}

	holder.Release()
	// 等到队列彻底排空（最后一个持有者释放后 Inflight 才会是 nil）。
	waitForIdleOrNext(t, m, "s1")
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if got := join(order); got != "abcd" {
		t.Fatalf("出队顺序必须等于入队顺序（期望 \"abcd\"），实际 %q", got)
	}
}

func join(parts []string) string {
	out := ""
	for _, p := range parts {
		out += p
	}
	return out
}

func waitForWaiting(t *testing.T, m *Manager, sessionRef string, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(m.Snapshot(sessionRef).Waiting) >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待者在超时前没有进入队列（期望 >=%d）", n)
}

func waitForIdleOrNext(t *testing.T, m *Manager, sessionRef string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m.Snapshot(sessionRef).Inflight == nil {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// TestWaitLimitReturnsBusyWithContext 超时必须给出**可诊断**的现场，而不是一句
// 「忙」。响应里要能回答「谁在挡着我、挡了多久、前面还排着几条」。
func TestWaitLimitReturnsBusyWithContext(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, 40*time.Millisecond)

	holder, err := m.Acquire(context.Background(), "s1", "holder", state.CmdPause)
	if err != nil {
		t.Fatalf("占位失败: %v", err)
	}
	defer holder.Release()
	// 让持有者「已经持有了一会儿」：不推进时钟的话 HeldFor 恰好是 0，而这一项正是
	// 现场信息里最先被看的东西（「它是不是卡住了」）。等待本身用真实时钟（40ms），
	// 只有「持有多久」用注入的时钟。
	clock.advance(2 * time.Second)

	_, err = m.Acquire(context.Background(), "s1", "waiter", state.CmdStop)
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("等待超时必须归为 ErrBusy，实际 %v", err)
	}
	var busy *BusyError
	if !errors.As(err, &busy) {
		t.Fatalf("错误必须带现场信息（*BusyError），实际 %T", err)
	}
	if busy.Holder != "holder" || busy.HolderCommand != state.CmdPause {
		t.Fatalf("现场信息不符：%+v", busy)
	}
	if busy.HeldFor <= 0 {
		t.Fatalf("应报出持有者已持有多久，实际 %s", busy.HeldFor)
	}
	// 超时的等待者必须**离开队列**：留在队里会让后来的释放把生效权交给一个已经
	// 回家的调用方，那条脉冲就永远不会被 Release。
	waitForWaiting(t, m, "s1", 0)
}

// TestReleaseIsIdempotent：defer 与显式调用都跑到时不能误伤下一个持有者。
func TestReleaseIsIdempotent(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, 5*time.Second)

	grant, err := m.Acquire(context.Background(), "s1", "a", state.CmdPause)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	grant.Release()
	grant.Release()
	grant.Release()

	next, err := m.Acquire(context.Background(), "s1", "b", state.CmdStop)
	if err != nil {
		t.Fatalf("重复释放后应还能拿到生效权: %v", err)
	}
	if next.CorrelationID() != "b" {
		t.Fatalf("拿到的不是自己：%q", next.CorrelationID())
	}
	next.Release()
}

// TestStaleReleaseDoesNotStealFromNewHolder 是最容易写错的一条：被强制接管之后，
// 旧持有者（带着过期凭据）再调用 Release，**不可以**把新持有者一起清掉。
//
// 写错的后果很具体：清掉之后队列挂空，同一会话上会有两条脉冲同时在跑「读状态 →
// 算目标状态 → 写回」，而这正是本包要防的丢失更新。
func TestStaleReleaseDoesNotStealFromNewHolder(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Second, 5*time.Second)

	stale, err := m.Acquire(context.Background(), "s1", "stale", state.CmdPause)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}

	// 时间越过 MaxHold，随后新请求进来：超限持有者被强制接管，新请求拿到生效权。
	clock.advance(2 * time.Second)
	fresh, err := m.Acquire(context.Background(), "s1", "fresh", state.CmdStop)
	if err != nil {
		t.Fatalf("强制接管后应能拿到: %v", err)
	}
	if fresh.CorrelationID() != "fresh" {
		t.Fatalf("拿到的不是新请求：%q", fresh.CorrelationID())
	}

	stale.Release() // 过期凭据的释放必须无效

	if got := m.Snapshot("s1").Inflight; got == nil || got.CorrelationID != "fresh" {
		t.Fatalf("过期释放误伤了新持有者：%+v", got)
	}
	fresh.Release()
}

// TestSweepForceTakesOverdueHolderAndReports 后台清扫要能摘掉卡死的持有者，并把
// 这件事变成可见事件（回调 → 指标/告警）。「队列在被堵」没有别的历史证据。
func TestSweepForceTakesOverdueHolderAndReports(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Second, 5*time.Second)

	type forced struct {
		session, correlation string
		held                 time.Duration
	}
	var (
		mu   sync.Mutex
		seen []forced
	)
	m.OnForceRelease(func(session, correlation string, held time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, forced{session, correlation, held})
	})

	if _, err := m.Acquire(context.Background(), "s1", "stuck", state.CmdPause); err != nil {
		t.Fatalf("报错: %v", err)
	}
	// 未超限时不该被摘。
	if got := m.Sweep(); len(got) != 0 {
		t.Fatalf("未超限就被接管：%+v", got)
	}

	clock.advance(3 * time.Second)
	got := m.Sweep()
	if len(got) != 1 || got[0].CorrelationID != "stuck" {
		t.Fatalf("超限持有者应被接管，实际 %+v", got)
	}
	if got[0].Held < 3*time.Second {
		t.Fatalf("应报出实际持有时长，实际 %s", got[0].Held)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0].correlation != "stuck" {
		t.Fatalf("强制接管必须触发回调（它是指标的唯一来源），实际 %+v", seen)
	}
	if snapshot := m.Snapshot("s1"); snapshot.Forced != 1 || snapshot.Inflight != nil {
		t.Fatalf("现场不符：%+v", snapshot)
	}
}

// TestContextCancellationLeavesNoPendingWaiter：HTTP 客户端断开时不该继续占着队列位置。
func TestContextCancellationLeavesNoPendingWaiter(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, 10*time.Second)

	holder, err := m.Acquire(context.Background(), "s1", "holder", state.CmdPause)
	if err != nil {
		t.Fatalf("占位失败: %v", err)
	}
	defer holder.Release()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	if _, err := m.Acquire(ctx, "s1", "waiter", state.CmdStop); err == nil {
		t.Fatal("ctx 取消后不该拿到生效权")
	}
	waitForWaiting(t, m, "s1", 0)
}

// TestSnapshotPositionsAndTotals 钉住只读投影面的两件事：
// 位置连续（控制台直接展示它），以及聚合深度不按会话维度展开（指标基数是有界的）。
func TestSnapshotPositionsAndTotals(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, 5*time.Second)

	if got := m.Snapshot("unknown"); got.Inflight != nil || len(got.Waiting) != 0 {
		t.Fatalf("未知会话应返回零值现场（查询一个没有控制活动的会话是正常操作），实际 %+v", got)
	}

	holder, err := m.Acquire(context.Background(), "s1", "h", state.CmdPause)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	go func() { _, _ = m.Acquire(context.Background(), "s1", "w1", state.CmdStop) }()
	waitForWaiting(t, m, "s1", 1)
	go func() { _, _ = m.Acquire(context.Background(), "s1", "w2", state.CmdStop) }()
	waitForWaiting(t, m, "s1", 2)

	snapshot := m.Snapshot("s1")
	if snapshot.Inflight == nil || snapshot.Inflight.Position != 1 {
		t.Fatalf("生效中的位置应为 1，实际 %+v", snapshot.Inflight)
	}
	for i, entry := range snapshot.Waiting {
		if entry.Position != i+2 {
			t.Fatalf("第 %d 个等待者的位置应为 %d，实际 %d", i, i+2, entry.Position)
		}
	}
	if depth := m.Depth("s1"); depth != 3 {
		t.Fatalf("深度应为 3（生效 1 + 等待 2），实际 %d", depth)
	}
	if inflight, waiting := m.Totals(); inflight != 1 || waiting != 2 {
		t.Fatalf("聚合深度应为 (1,2)，实际 (%d,%d)", inflight, waiting)
	}

	holder.Release()
	// 放行第一个等待者；它不会自己释放（上面的 goroutine 没有 defer Release），
	// 但这里只关心聚合计数，不再等待第二个 —— 避免用例结束时留下悬挂 goroutine 的
	// 假失败。真正断言顺序的用例是 TestFIFOOrderIsRespected。
	waitForWaiting(t, m, "s1", 1)
}

func TestAcquireRejectsEmptyIdentifiers(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	m := newManager(t, clock, time.Minute, time.Second)

	if _, err := m.Acquire(context.Background(), "", "c", state.CmdPause); err == nil {
		t.Fatal("空 sessionRef 必须被拒（它会让所有会话挤进同一个队列）")
	}
	if _, err := m.Acquire(context.Background(), "s1", "", state.CmdPause); err == nil {
		t.Fatal("空 correlationID 必须被拒（它是审计与现场信息的键）")
	}
}

// TestDefaultsAreNotZeroLocks：零值 Options 必须给出**有限**的上限。
// 上限为 0 的队列要么立刻超时、要么永远不超时，两种都是「配置没给」被静默成行为。
func TestDefaultsAreNotZeroLocks(t *testing.T) {
	opts := Options{}.withDefaults()
	if opts.MaxHold <= 0 || opts.WaitLimit <= 0 || opts.Now == nil {
		t.Fatalf("缺省值必须齐备，实际 %+v", opts)
	}
}
