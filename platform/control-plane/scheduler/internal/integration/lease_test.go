package integration_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// TestElectionRace spec §7 场景 1：20 轮 × 20 并发抢租，每轮恰好 1 胜出。
func TestElectionRace(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	for round := 0; round < 20; round++ {
		if _, err := st.Pool().Exec(ctx, `TRUNCATE scheduler_leader_lease`); err != nil {
			t.Fatalf("第 %d 轮清租约失败: %v", round, err)
		}
		if err := st.Init(ctx); err != nil {
			t.Fatalf("第 %d 轮重建租约行失败: %v", round, err)
		}

		var mu sync.Mutex
		winners := 0
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				if l, err := st.Acquire(ctx, fmt.Sprintf("node-%d", i), 5000); err == nil && l != nil {
					mu.Lock()
					winners++
					mu.Unlock()
				}
			}(i)
		}
		wg.Wait()
		if winners != 1 {
			t.Fatalf("第 %d 轮胜出 %d 个, 应为 1", round, winners)
		}
	}
}

// TestTakeoverAfterExpiry spec §7 场景 2：持租未过期他人不可接管；过期后备节点接管，token +1。
func TestTakeoverAfterExpiry(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	const ttl = int64(800)

	a, err := st.Acquire(ctx, "node-a", ttl)
	if err != nil {
		t.Fatalf("a 首任应成功: %v", err)
	}
	if _, err := st.Acquire(ctx, "node-b", ttl); !errors.Is(err, domain.ErrNotAcquired) {
		t.Fatalf("a 持租未过期, b 不应接管, got %v", err)
	}

	time.Sleep(1200 * time.Millisecond) // 等 a 过期（无续租）

	b, err := st.Acquire(ctx, "node-b", ttl)
	if err != nil {
		t.Fatalf("过期后 b 应接管: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}
}

// TestGracefulRelease spec §7 场景 4：释放置 expires_at=0 → 备节点零等待接管。
func TestGracefulRelease(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	a, err := st.Acquire(ctx, "node-a", 5000)
	if err != nil {
		t.Fatalf("a 建租失败: %v", err)
	}
	if err := st.Release(ctx, "node-a"); err != nil {
		t.Fatalf("a 释放失败: %v", err)
	}

	b, err := st.Acquire(ctx, "node-b", 5000) // 无需等待 TTL
	if err != nil {
		t.Fatalf("释放后 b 应立即接管: %v", err)
	}
	if b.FencingToken != a.FencingToken+1 {
		t.Fatalf("易主 token 应 +1: got %d want %d", b.FencingToken, a.FencingToken+1)
	}
}
