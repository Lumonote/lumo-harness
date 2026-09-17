package batch

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func mustNew(t *testing.T, cfg Config) *Coalescer {
	t.Helper()
	c, err := New(cfg)
	if err != nil {
		t.Fatalf("构造汇聚器失败: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

// TestDisabledWindowIsAPassThrough 窗口为 0 时必须是直通：不延迟、不建组。
//
// 这一条决定了「默认关闭」是不是真的等于「与没有这层同形」。若关闭态还建组或
// 起定时器，默认关闭就只是「没生效」而不是「没开销」。
func TestDisabledWindowIsAPassThrough(t *testing.T) {
	c := mustNew(t, Config{Window: 0, MaxBatch: 0})
	start := time.Now()
	for i := 0; i < 50; i++ {
		if err := c.Acquire(context.Background(), "m"); err != nil {
			t.Fatalf("直通不应报错: %v", err)
		}
	}
	if elapsed := time.Since(start); elapsed > 20*time.Millisecond {
		t.Fatalf("直通路径不该有可观测延迟, got %s", elapsed)
	}
	if waiting, released := c.Stats(); waiting != 0 || released != 0 {
		t.Fatalf("直通不该留下任何状态: waiting=%d released=%d", waiting, released)
	}
	if len(c.groups) != 0 {
		t.Fatalf("直通不该建组: %d", len(c.groups))
	}
}

// TestFullBatchReleasesWithoutWaitingForTheWindow 批满即放行。
//
// 若这条不成立，吞吐上界就被窗口钉死（每窗口一批），「并发越高吞吐越高」也就不
// 成立了。
func TestFullBatchReleasesWithoutWaitingForTheWindow(t *testing.T) {
	c := mustNew(t, Config{Window: time.Hour, MaxBatch: 3})

	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = c.Acquire(context.Background(), "m")
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("批满后应立即放行，实际被窗口（1h）挡住")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("批满放行太慢: %s", elapsed)
	}
	if _, released := c.Stats(); released != 1 {
		t.Fatalf("应恰好形成 1 批, got %d", released)
	}
}

// TestWindowReleaseIsAnUpperBoundOnDelay 单个请求的延迟上界 = 窗口。
//
// §7.2「首 token 延迟不受批处理拖累」的可验证形式：延迟是加法（一个窗口），
// 不是乘法（等前面的人）。
func TestWindowReleaseIsAnUpperBoundOnDelay(t *testing.T) {
	window := 60 * time.Millisecond
	c := mustNew(t, Config{Window: window, MaxBatch: 64})

	start := time.Now()
	if err := c.Acquire(context.Background(), "m"); err != nil {
		t.Fatalf("Acquire 失败: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed < window {
		t.Fatalf("不该早于窗口放行: %s < %s", elapsed, window)
	}
	// 上界给足容差：断言的是「有界」，不是「精确等于窗口」。
	if elapsed > 10*window {
		t.Fatalf("延迟应被窗口界定在 %s 量级, got %s", window, elapsed)
	}
}

// TestDifferentKeysNeverShareABatch 不同 key（模型）不混批。
//
// 混批的后果不是「慢」而是「错」：不同模型走不同上游。
func TestDifferentKeysNeverShareABatch(t *testing.T) {
	c := mustNew(t, Config{Window: 40 * time.Millisecond, MaxBatch: 2})

	// a 先占一个名额，不该被 b 的两个请求凑满。
	aDone := make(chan error, 1)
	go func() { aDone <- c.Acquire(context.Background(), "a") }()

	time.Sleep(10 * time.Millisecond)
	// b 的两个请求**并发**进来。串行调用等于第一个自己先等完窗口，量不到「批满
	// 即放行」——这条用例要证明的正是后者。
	bDone := make(chan error, 2)
	bStart := time.Now()
	for i := 0; i < 2; i++ {
		go func() { bDone <- c.Acquire(context.Background(), "b") }()
	}
	for i := 0; i < 2; i++ {
		if err := <-bDone; err != nil {
			t.Fatalf("b 的 Acquire 失败: %v", err)
		}
	}
	bElapsed := time.Since(bStart)

	if err := <-aDone; err != nil {
		t.Fatalf("a 的 Acquire 失败: %v", err)
	}
	// b 自己凑满 2 个，应当立即放行，而不是被 a 拖到窗口。
	if bElapsed > 20*time.Millisecond {
		t.Fatalf("b 的批应因自身批满立即放行, got %s", bElapsed)
	}
	if _, released := c.Stats(); released != 2 {
		t.Fatalf("应形成 2 批（a 一批、b 一批）, got %d", released)
	}
}

// TestCancelledRequestDoesNotHoldABatchSlot 取消的请求必须把名额还回去。
//
// 不还的后果很具体：批里只剩「已经走掉的请求」时永远攒不满 MaxBatch，后面的
// 请求只能干等窗口——现象是「并发一高吞吐反而掉」。
//
// 判别手法要能区分「还了」和「没还」：若那个名额还在（len==1），后面再补 1 个
// 就凑满 2 会**立刻**放行；正因为还了（len==0），新来的那一个只能等窗口。所以
// 这里断言的是「新请求没有被立刻放行」——它比「新请求最终能过」更严，后者在
// 名额没还的情况下同样成立。
func TestCancelledRequestDoesNotHoldABatchSlot(t *testing.T) {
	window := 200 * time.Millisecond
	c := mustNew(t, Config{Window: window, MaxBatch: 2})

	ctx, cancel := context.WithCancel(context.Background())
	cancelled := make(chan error, 1)
	go func() { cancelled <- c.Acquire(ctx, "m") }()

	// 等它进批，再取消。
	waitFor(t, func() bool { w, _ := c.Stats(); return w == 1 })
	cancel()
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatalf("应返回 context.Canceled, got %v", err)
	}
	waitFor(t, func() bool { w, _ := c.Stats(); return w == 0 })
	if n := c.groupSize("m"); n != 0 {
		t.Fatalf("取消的请求仍占着名额: group size=%d", n)
	}

	// 名额已还：新来的一个攒不满 2，只能等窗口——不该被立刻放行。
	start := time.Now()
	next := make(chan error, 1)
	go func() { next <- c.Acquire(context.Background(), "m") }()

	select {
	case err := <-next:
		t.Fatalf("名额没还回去（批被立刻凑满放行）: err=%v elapsed=%s", err, time.Since(start))
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case err := <-next:
		if err != nil {
			t.Fatalf("窗口到点应正常放行: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("窗口到点仍未放行")
	}
}

// TestCancellationRacingReleaseReportsReleased 取消与放行撞上时以「已放行」为准。
//
// 报成取消的后果是：一个已经被放行（上游即将收到）的请求被调用方当成没发出去，
// 重试一次就重复计费。
func TestCancellationRacingReleaseReportsReleased(t *testing.T) {
	c := mustNew(t, Config{Window: 30 * time.Millisecond, MaxBatch: 8})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Acquire(ctx, "m") }()

	// 卡在「窗口刚放行」与「取消」之间：先等窗口到点，再立刻取消。
	time.Sleep(35 * time.Millisecond)
	cancel()

	if err := <-done; err != nil {
		t.Fatalf("已放行的请求不该被报成取消: %v", err)
	}
}

// TestAlreadyCancelledContextTakesNoSlot 已结束的 ctx 不该占名额。
func TestAlreadyCancelledContextTakesNoSlot(t *testing.T) {
	c := mustNew(t, Config{Window: time.Hour, MaxBatch: 2})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := c.Acquire(ctx, "m"); !errors.Is(err, context.Canceled) {
		t.Fatalf("应返回 context.Canceled, got %v", err)
	}
	if w, _ := c.Stats(); w != 0 {
		t.Fatalf("不该留下等待中的名额: %d", w)
	}
	if len(c.groups) != 0 {
		t.Fatalf("不该建组: %d", len(c.groups))
	}
}

// TestStaleWindowTimerCannotReleaseTheNextBatch 上一批的定时器不能误放行下一批。
//
// 这个窗口真实存在：定时器 Stop 与回调触发是竞态，回调可能已经在跑。没有代次
// 判断的话，它会把「刚开、还没攒够」的下一批提前放行——表现为「批大小随机地
// 变成 1」，而吞吐问题恰恰是最难从现象倒推原因的那类。
func TestStaleWindowTimerCannotReleaseTheNextBatch(t *testing.T) {
	c := mustNew(t, Config{Window: 20 * time.Millisecond, MaxBatch: 2})

	// 手动造出「旧批已被释放，但旧回调仍在跑」的状态。
	c.mu.Lock()
	old := &group{}
	c.groups["m"] = old
	c.mu.Unlock()
	c.release("m", old)

	// 新的一批：1 个请求，应当等满窗口才走。
	newWaiter := make(chan error, 1)
	go func() { newWaiter <- c.Acquire(context.Background(), "m") }()
	waitFor(t, func() bool { w, _ := c.Stats(); return w == 1 })

	// 旧回调此刻到达（代次不同）。
	c.release("m", old)

	select {
	case err := <-newWaiter:
		t.Fatalf("旧回调误放行了新批: err=%v", err)
	case <-time.After(10 * time.Millisecond):
	}
	// 此刻只该有「手动释放旧批」那一批；新批还在等它自己的窗口。
	if _, released := c.Stats(); released != 1 {
		t.Fatalf("旧回调不该产生额外的批, released=%d", released)
	}
}

// TestCloseIsIdempotentAndStopsTimers Close 幂等，且关闭后不再放行、不再建组。
//
// Close 刻意**只停定时器、不放行挂起的请求**：放行意味着「去发上游」，而关闭
// 路径正在收摊——把一批请求放进一个正在关停的上游，比让它们由调用方自己的 ctx
// 收尾更糟。所以这条用例断言挂起者是被自己的 ctx 结束的。
func TestCloseIsIdempotentAndStopsTimers(t *testing.T) {
	c := mustNew(t, Config{Window: time.Minute, MaxBatch: 8})

	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Acquire(ctx, "m") }()
	waitFor(t, func() bool { w, _ := c.Stats(); return w == 1 })

	c.Close()
	c.Close() // 幂等

	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("挂起的请求应由调用方 ctx 收尾, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Close 之后挂起的请求再也不会被放行（定时器已停），必须靠调用方 ctx 结束")
	}

	if err := c.Acquire(context.Background(), "m"); err != nil {
		t.Fatalf("关闭后应直通: %v", err)
	}
	if len(c.groups) != 0 {
		t.Fatalf("关闭后不该建组: %d", len(c.groups))
	}
}

// TestConfigValidationNamesTheVariable 非法配置必须点名变量，不静默夹取。
func TestConfigValidationNamesTheVariable(t *testing.T) {
	cases := []struct {
		name    string
		cfg     Config
		wantSub string
	}{
		{"窗口为负", Config{Window: -time.Millisecond, MaxBatch: 4}, "LUMO_LLM_BATCH_WINDOW_MS"},
		{"开了窗口但没给批上限", Config{Window: time.Millisecond, MaxBatch: 0}, "LUMO_LLM_BATCH_MAX"},
		{"批上限为负", Config{Window: 0, MaxBatch: -1}, "LUMO_LLM_BATCH_MAX"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(tc.cfg)
			if err == nil {
				t.Fatalf("非法配置应拒绝构造")
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("错误信息应点名变量 %s, got %v", tc.wantSub, err)
			}
		})
	}
}

// TestValidConfigurationsAreAccepted 合法配置（含窗口关闭）不得被误拒。
func TestValidConfigurationsAreAccepted(t *testing.T) {
	for _, cfg := range []Config{
		{Window: 0, MaxBatch: 0},
		{Window: time.Millisecond, MaxBatch: 1},
		{Window: time.Second, MaxBatch: 4096},
	} {
		if err := cfg.Validate(); err != nil {
			t.Fatalf("%+v 应合法: %v", cfg, err)
		}
	}
}

// TestEveryRequestIsReleasedExactlyOnce 每个请求都被放行恰好一次。
//
// 并发压一遍：漏放行 = 请求永久挂住（比报错难发现），重复放行 = 同一请求被发
// 两次上游（重复计费）。两个方向都要堵。
func TestEveryRequestIsReleasedExactlyOnce(t *testing.T) {
	c := mustNew(t, Config{Window: 5 * time.Millisecond, MaxBatch: 4})

	const n = 200
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			key := "m"
			if i%3 == 0 {
				key = "m2"
			}
			if err := c.Acquire(ctx, key); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("请求未被正常放行: %v", err)
	}
	if w, _ := c.Stats(); w != 0 {
		t.Fatalf("全部结束后不该还有等待中的请求: %d", w)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("条件在超时前未成立")
}

// groupSize 当前 key 那一批里还挂着几个名额。测试用（同包可见内部状态）。
func (c *Coalescer) groupSize(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if g := c.groups[key]; g != nil {
		return len(g.waiters)
	}
	return 0
}
