package election

import (
	"context"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 续租与请求共用连接池。库变慢时一次续租若无限期挂着，后面的续租都发不出去，
// 租约会在本进程毫不知情的情况下过期——所以每次尝试必须自带期限。
func TestAcquireAttemptIsBoundedByRenewInterval(t *testing.T) {
	ttl := 300 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan time.Duration, 1)
	go run(ctx, &State{}, func(ctx context.Context, _ string, _ int64) (*domain.Lease, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			got <- -1
		} else {
			got <- time.Until(deadline)
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}, "h", ttl, func(bool) {})

	select {
	case d := <-got:
		if d < 0 || d > ttl/3 {
			t.Fatalf("续租尝试的期限应不超过 ttl/3，实际 %v", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("acquire 未被调用")
	}
}
