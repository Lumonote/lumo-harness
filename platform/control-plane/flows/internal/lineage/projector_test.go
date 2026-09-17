package lineage

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeStore 复刻 ProjectorStore 的可观察行为。它是**测试**实现的，因此可以把
// 「被标记了什么」逐条记下来断言——投影器最危险的失效模式是「没投影成功却打了
// projected_at」，只有记录才能发现。
type fakeStore struct {
	mu        sync.Mutex
	pending   []PendingEdge
	claimErr  error
	batches   int
	projected [][]int64
	failedID  []int64
	fails     []failedMark
	markErr   error
	failErr   error
}

type failedMark struct {
	id       int64
	reason   string
	attempts int
	next     time.Time
}

func (f *fakeStore) ClaimPending(context.Context, int) ([]PendingEdge, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches++
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	out := f.pending
	f.pending = nil // 认领即取走：与 SQL 的 FOR UPDATE SKIP LOCKED 语义对齐
	return out, nil
}

func (f *fakeStore) MarkProjected(_ context.Context, ids []int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.markErr != nil {
		return f.markErr
	}
	f.projected = append(f.projected, ids)
	return nil
}

func (f *fakeStore) MarkFailed(_ context.Context, id int64, reason string, attempts int, next time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failErr != nil {
		return f.failErr
	}
	f.failedID = append(f.failedID, id)
	f.fails = append(f.fails, failedMark{id: id, reason: reason, attempts: attempts, next: next})
	return nil
}

func (f *fakeStore) projectedIDs() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []int64
	for _, batch := range f.projected {
		out = append(out, batch...)
	}
	return out
}

// fakeAdapter 按「哪些边该失败」可编程：失败用 map keyed by node 对，
// 便于在一批里同时造出成功与失败，而不必分两个测试。
type fakeAdapter struct {
	mu     sync.Mutex
	calls  []Edge
	failOn map[string]error
}

func (f *fakeAdapter) UpsertLineageEdge(_ context.Context, e Edge) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, e)
	if err, ok := f.failOn[e.FromNode+"->"+e.ToNode]; ok {
		return err
	}
	return nil
}

func (f *fakeAdapter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func pending(id int64, from, to string, attempts int) PendingEdge {
	return PendingEdge{ID: id, Attempts: attempts, Edge: Edge{FlowID: "f1", Version: 1, FromNode: from, ToNode: to, EdgeType: EdgeTypeData}}
}

func TestProjectorMarksOnlyProjectedEdges(t *testing.T) {
	st := &fakeStore{pending: []PendingEdge{pending(1, "a", "b", 0), pending(2, "b", "c", 0)}}
	ad := &fakeAdapter{}
	p := NewProjector(st, ad, discardLogger())
	p.drain(context.Background())

	if got := st.projectedIDs(); len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("两条边都该被标记投影完成，实际 %v", got)
	}
	if len(st.fails) != 0 {
		t.Fatalf("不该有失败标记，实际 %+v", st.fails)
	}
	if ad.count() != 2 {
		t.Fatalf("适配器应被调用两次，实际 %d", ad.count())
	}
}

// TestProjectorPartialFailureKeepsProgress 一批里部分失败不能让整批回滚：
// 否则一条毒边会把它后面所有边永久堵在 outbox 里（队头阻塞），而 Nebula 侧看不到进度。
func TestProjectorPartialFailureKeepsProgress(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	st := &fakeStore{pending: []PendingEdge{pending(1, "a", "b", 0), pending(2, "b", "c", 0), pending(3, "c", "d", 2)}}
	ad := &fakeAdapter{failOn: map[string]error{"b->c": errors.New("nebula 503")}}
	p := NewProjector(st, ad, discardLogger())
	p.now = func() time.Time { return now }
	p.drain(context.Background())

	got := st.projectedIDs()
	if len(got) != 2 || got[0] != 1 || got[1] != 3 {
		t.Fatalf("只有成功的两条该被标记，实际 %v", got)
	}
	if len(st.fails) != 1 {
		t.Fatalf("应恰好一条失败，实际 %+v", st.fails)
	}
	f := st.fails[0]
	if f.id != 2 {
		t.Fatalf("失败的是 2 号边，实际 %d", f.id)
	}
	if !strings.Contains(f.reason, "nebula 503") {
		t.Fatalf("失败原因必须可见（落库供巡检），实际 %q", f.reason)
	}
	// 原 attempts=0 → 本次落地计为第 1 次；另一条 attempts=2 下次为第 3 次。
	if f.attempts != 1 {
		t.Fatalf("attempts 应为 1（原 0 加本次），实际 %d", f.attempts)
	}
	if want := now.Add(Backoff(1)); !f.next.Equal(want) {
		t.Fatalf("下次尝试应退避到 %v，实际 %v", want, f.next)
	}
	if !f.next.After(now) {
		t.Fatalf("退避必须指向未来，否则投不上就成了热循环：%v", f.next)
	}
}

// TestProjectorClaimFailureDoesNotMarkAnyEdge 取件失败时绝不能顺手标记任何边。
func TestProjectorClaimFailureDoesNotMarkAnyEdge(t *testing.T) {
	st := &fakeStore{claimErr: errors.New("pg 连接断了")}
	ad := &fakeAdapter{}
	var reported []error
	p := NewProjector(st, ad, discardLogger())
	p.SetErrorHandler(func(err error) { reported = append(reported, err) })
	p.drain(context.Background())

	if ad.count() != 0 {
		t.Fatalf("取件都失败了不该调适配器，实际 %d 次", ad.count())
	}
	if len(st.projected) != 0 || len(st.fails) != 0 {
		t.Fatalf("不该有任何标记：projected=%v fails=%+v", st.projected, st.fails)
	}
	if len(reported) != 1 || !strings.Contains(reported[0].Error(), "pg 连接断了") {
		t.Fatalf("错误必须上报（不能吞），实际 %v", reported)
	}
}

// TestProjectorEmptyBatchIsSilent 空批次不做任何写：轮询多数时候是空的，
// 空 UPDATE 既无信息量又制造写放大。
func TestProjectorEmptyBatchIsSilent(t *testing.T) {
	st := &fakeStore{}
	ad := &fakeAdapter{}
	p := NewProjector(st, ad, discardLogger())
	p.drain(context.Background())
	if len(st.projected) != 0 || len(st.fails) != 0 || ad.count() != 0 {
		t.Fatalf("空批次应完全静默，实际 projected=%v fails=%+v adapter=%d", st.projected, st.fails, ad.count())
	}
}

// TestProjectorMarkErrorsAreReported 标记失败要上报而不是吞掉：
// 吞掉的话「边永远停在未投影」在日志里一个字都没有，面板只会显示「队列有点长」。
func TestProjectorMarkErrorsAreReported(t *testing.T) {
	st := &fakeStore{pending: []PendingEdge{pending(1, "a", "b", 0)}, markErr: errors.New("写回失败")}
	p := NewProjector(st, &fakeAdapter{}, discardLogger())
	var reported []error
	p.SetErrorHandler(func(err error) { reported = append(reported, err) })
	p.drain(context.Background())
	if len(reported) != 1 || !strings.Contains(reported[0].Error(), "写回失败") {
		t.Fatalf("标记失败必须上报，实际 %v", reported)
	}
}

// TestProjectorRunDrainsImmediatelyAndStops Run 必须先搬一轮再等 ticker，
// 且在 ctx 结束时干净返回（否则「部署后要等一个 poll 周期」会一直被当成「投影没生效」）。
func TestProjectorRunDrainsImmediatelyAndStops(t *testing.T) {
	st := &fakeStore{pending: []PendingEdge{pending(1, "a", "b", 0)}}
	first := make(chan struct{}, 1)
	ad := &countingAdapter{onCall: func() {
		select {
		case first <- struct{}{}:
		default:
		}
	}}
	p := NewProjector(st, ad, discardLogger())
	p.SetTiming(5*time.Millisecond, 10)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	select {
	case <-first:
	case <-time.After(2 * time.Second):
		t.Fatal("Run 未在启动后立即搬运一轮")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后 Run 未返回")
	}
}

type countingAdapter struct {
	mu     sync.Mutex
	n      int
	onCall func()
}

func (c *countingAdapter) UpsertLineageEdge(context.Context, Edge) error {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
	if c.onCall != nil {
		c.onCall()
	}
	return nil
}

// TestBackoff 退避必须单调、有下界、有上界。上界不是可选项：没有上界时一条长期失败的边
// 会在若干次之后被推到遥不可及的未来（等于永久静默丢弃）。
func TestBackoff(t *testing.T) {
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{-1, 2 * time.Second},
		{0, 2 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{4, 16 * time.Second},
		{5, 32 * time.Second},
		{6, 64 * time.Second},
		{7, 120 * time.Second}, // 2m 封顶：64s*2=128s 被截断
		{8, 120 * time.Second},
		{50, 120 * time.Second},
	}
	prev := time.Duration(0)
	for _, tc := range cases {
		got := Backoff(tc.attempts)
		if got != tc.want {
			t.Fatalf("Backoff(%d) 应为 %v，实际 %v", tc.attempts, tc.want, got)
		}
		if got < prev {
			t.Fatalf("退避必须单调不减：Backoff(%d)=%v 小于前一个 %v", tc.attempts, got, prev)
		}
		prev = got
	}
}
