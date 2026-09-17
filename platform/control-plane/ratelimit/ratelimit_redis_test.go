package ratelimit

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// 活库用例的门控变量。与 `LUMO_TEST_PG_DSN` 同一口径：由 `platform/deploy/test-local-pg.sh`
// 注入（本地 redis 容器默认就在起），未设置时整组 skip 且 skip 可见。
const redisDSNEnv = "LUMO_TEST_REDIS_DSN"

// liveClient 连接本地 Redis；未配置 → skip，配置了但连不上 → **fail**。
//
// 「连不上」绝不能 skip：那会让一台 DNS 坏掉/容器没起来的机器和一台「根本没配」的机器
// 在输出上长得一样，而两者该做的处置相反（一个查环境、一个补配置）。跳过的理由必须是
// 「没配」，不能是「配了但用不了」。
func liveClient(t *testing.T) (*redis.Client, context.Context) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv(redisDSNEnv))
	if dsn == "" {
		t.Skipf("未设置 %s（本地 redis 容器未启动或未注入）；Lua 令牌桶的原子性未经真库验证", redisDSNEnv)
	}

	opts, err := redis.ParseURL(dsn)
	if err != nil {
		// 也接受裸 host:port，省得调用方为了一个地址去拼 scheme。
		opts = &redis.Options{Addr: dsn}
	}
	client := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("%s=%q 已设置但连不上：%v（这是环境故障，不是「没有证据」）", redisDSNEnv, dsn, err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, context.Background()
}

// liveKey 造一个本次运行独用的桶名。
//
// 用时间戳而不是固定名：本地 Redis 是跨测试运行复用的容器，固定名会让上一轮的残留令牌
// 影响这一轮（表现为「第一次请求就被拒」这种莫名其妙的失败）。
func liveKey(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf("lumo:test:rl:%s:%d", strings.ReplaceAll(t.Name(), "/", "_"), time.Now().UnixNano())
}

// TestLiveBurstExhaustedThenRecovers 桶按 burst 放行，用尽后拒绝并给出等待时长，等够了再放行。
//
// 这一条同时覆盖了三件事：初始桶是满的（不是空的）、拒绝时 retry 是有意义的（不是 0）、
// 令牌真的会随**时间**补充（Lua 里的 rate 换算没写反）。
func TestLiveBurstExhaustedThenRecovers(t *testing.T) {
	client, ctx := liveClient(t)
	key := liveKey(t)
	// rpm=600 → rate=10/s，burst=3：补一个令牌约 100ms，用例跑得快。
	limiter := New(client)

	for i := 0; i < 3; i++ {
		v, err := limiter.Allow(ctx, key, 600, 3)
		if err != nil {
			t.Fatalf("第 %d 次请求报错: %v", i+1, err)
		}
		if !v.Allowed {
			t.Fatalf("第 %d 次请求应放行（初始桶应为满的 burst=3）", i+1)
		}
	}

	v, err := limiter.Allow(ctx, key, 600, 3)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if v.Allowed {
		t.Fatal("burst 已用尽，第 4 次应被拒")
	}
	if v.RetryAfter <= 0 {
		t.Fatalf("拒绝时必须给出正的等待时长，实际 %v（0 会让客户端立刻重试）", v.RetryAfter)
	}
	if v.RetryAfter > 200*time.Millisecond {
		t.Fatalf("rate=10/s 时补一个令牌约 100ms，等待时长 %v 量级不对", v.RetryAfter)
	}

	time.Sleep(v.RetryAfter + 30*time.Millisecond)
	if v, err := limiter.Allow(ctx, key, 600, 3); err != nil {
		t.Fatalf("报错: %v", err)
	} else if !v.Allowed {
		t.Fatalf("等待 %v 后应已补足一个令牌，仍被拒", v.RetryAfter)
	}
}

// TestLiveKeysAreIsolated 不同 key 的桶互不影响。
//
// 判据必须双向：既要求「另一个 key 不受影响」，也要求「原 key 确实被卡住」——只断言前者
// 的话，一个「永远放行」的实现也能通过。
func TestLiveKeysAreIsolated(t *testing.T) {
	client, ctx := liveClient(t)
	keyA, keyB := liveKey(t)+":a", liveKey(t)+":b"
	limiter := New(client)

	// 用尽 A（burst=1）。
	if v, err := limiter.Allow(ctx, keyA, 600, 1); err != nil || !v.Allowed {
		t.Fatalf("A 首次应放行: %+v %v", v, err)
	}
	if v, err := limiter.Allow(ctx, keyA, 600, 1); err != nil || v.Allowed {
		t.Fatalf("A 应已用尽: %+v %v", v, err)
	}
	// B 完全独立。
	if v, err := limiter.Allow(ctx, keyB, 600, 1); err != nil || !v.Allowed {
		t.Fatalf("B 不应受 A 影响: %+v %v", v, err)
	}
}

// TestLiveBucketExpires 空闲桶必须设上 TTL，否则 Redis 会被无数一次性 key 慢慢撑爆。
func TestLiveBucketExpires(t *testing.T) {
	client, ctx := liveClient(t)
	key := liveKey(t)
	if _, err := New(client).Allow(ctx, key, 600, 3); err != nil {
		t.Fatalf("报错: %v", err)
	}

	ttl, err := client.TTL(ctx, key).Result()
	if err != nil {
		t.Fatalf("读 TTL 失败: %v", err)
	}
	if ttl <= 0 {
		t.Fatalf("桶必须带正 TTL（空闲桶要自然过期），实际 %v", ttl)
	}
	// 脚本给的期望是 ceil(burst/rate*1000)+1000 = ceil(3/10*1000)+1000 = 1300ms。
	// 上界写死而不是从 TTL 反推：反推等于拿被测对象给自己当期望值。
	if ttl > 1300*time.Millisecond {
		t.Fatalf("TTL 超出脚本声明的 1300ms 上界，实际 %v", ttl)
	}
}

// TestLiveNoOversubscriptionUnderConcurrency 并发下不得超发——这是整段 Lua 存在的理由。
//
// 断言的是**恰好等于** burst，不是「不超过太多」：读-算-写分三次往返的实现会在并发下多放行，
// 而「多放行几十个」在业务上就是限流失效。反过来，若实现有 bug 导致少放行（比如误加锁把
// 令牌扣两次），这条也会红。
//
// rate 取 1/60 每秒（rpm=1）：即使测试机卡住几秒也几乎不会补进一个令牌，所以「恰好 50」是
// 确定性断言而不是概率断言。若这里偶发 flaky，说明 rate 取大了，不要去放宽期望值。
func TestLiveNoOversubscriptionUnderConcurrency(t *testing.T) {
	client, ctx := liveClient(t)
	key := liveKey(t)
	limiter := New(client)

	const burst = 50
	const goroutines = 200

	var allowed, denied, failed atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // 让所有 goroutine 尽量同时压上去
			v, err := limiter.Allow(ctx, key, 1, burst)
			switch {
			case err != nil:
				failed.Add(1)
			case v.Allowed:
				allowed.Add(1)
			default:
				denied.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if failed.Load() != 0 {
		t.Fatalf("%d 个请求报错（Redis 或脚本有问题）", failed.Load())
	}
	if got := allowed.Load(); got != burst {
		t.Fatalf("并发下必须恰好放行 %d 个（多放行=限流失效，少放行=令牌被重复扣），实际 %d", burst, got)
	}
	if got := denied.Load(); got != goroutines-burst {
		t.Fatalf("应拒绝 %d 个，实际 %d", goroutines-burst, got)
	}
}

// TestLiveRejectedRetryAfterLetsNextRequestThrough 拒绝时给的等待时长必须真的够用。
//
// 单独一条：`retry_ms` 算错（比如漏乘 1000、或用了 ceil 之前的整数除法）时，上面几条都可能
// 仍然绿——只有「照着它等，然后再来一次」才能证明它是个可用的值而不是一个好看的数字。
func TestLiveRejectedRetryAfterLetsNextRequestThrough(t *testing.T) {
	client, ctx := liveClient(t)
	key := liveKey(t)
	limiter := New(client)

	if _, err := limiter.Allow(ctx, key, 60, 1); err != nil {
		t.Fatalf("报错: %v", err)
	}
	first, err := limiter.Allow(ctx, key, 60, 1)
	if err != nil {
		t.Fatalf("报错: %v", err)
	}
	if first.Allowed {
		t.Fatal("应被拒")
	}
	// rpm=60 → rate=1/s → 等待时长应约 1000ms（这里只要求量级对，不要求精确）。
	if first.RetryAfter < 500*time.Millisecond || first.RetryAfter > 1500*time.Millisecond {
		t.Fatalf("rate=1/s 时等待时长应约 1000ms，实际 %v", first.RetryAfter)
	}

	time.Sleep(first.RetryAfter + 50*time.Millisecond)
	if v, err := limiter.Allow(ctx, key, 60, 1); err != nil {
		t.Fatalf("报错: %v", err)
	} else if !v.Allowed {
		t.Fatalf("照 %v 等待后仍被拒——retry 时长不是可用值", first.RetryAfter)
	}
}
