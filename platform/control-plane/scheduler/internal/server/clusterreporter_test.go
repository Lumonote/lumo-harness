package server

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// 自报循环是「集群不会被自己判成 down」的唯一保障：它停一次，本集群就会在
// down 阈值之后拒绝自己的新放置。所以这几个用例盯的不是「它能上报」，
// 而是**它在失败之后还继续上报**，以及它的日志不会把真正的预警埋掉。

type reportingStub struct {
	mu     sync.Mutex
	calls  int
	last   domain.Cluster
	failed bool
}

func (s *reportingStub) RegisterCluster(_ context.Context, c domain.Cluster) (domain.Cluster, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.last = c
	if s.failed {
		return domain.Cluster{}, errors.New("pg 不可用")
	}
	return c, nil
}

func (s *reportingStub) ClusterAges(context.Context) ([]domain.Cluster, error) { return nil, nil }

func (s *reportingStub) ClusterByID(context.Context, string) (domain.Cluster, error) {
	return domain.Cluster{}, errors.New("unused")
}

func (s *reportingStub) snapshot() (int, domain.Cluster) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls, s.last
}

func (s *reportingStub) setFailed(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failed = v
}

// syncBuffer 供 slog 在并发下写入（日志由后台 goroutine 产出，断言在主 goroutine 读）。
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// waitForCalls 轮询到自报次数达标（循环是后台 goroutine，断言前先等它就位）。
func waitForCalls(t *testing.T, stub *reportingStub, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if calls, _ := stub.snapshot(); calls >= want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	calls, _ := stub.snapshot()
	t.Fatalf("自报次数未达到 %d（实际 %d）", want, calls)
}

// TestRunClusterReporterReportsImmediatelyAndRepeatedly 首轮立即上报，且周期重试。
//
// 「立即」这条不是小事：若只在第一个 tick 之后才报，一次重启就会让本集群在启动
// 后的一个周期内处于「刚注册过、但还没续报」之外的状态——注册行的 last_seen_at
// 由第一轮写语句产生，晚一轮上报只是延迟，但**一次都不报**会让集群直接判 down。
func TestRunClusterReporterReportsImmediatelyAndRepeatedly(t *testing.T) {
	stub := &reportingStub{}
	srv := &Server{log: slog.New(slog.DiscardHandler), clusters: stub}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.RunClusterReporter(ctx, ClusterIdentity{ClusterID: "c1", Realm: "dev", Version: "1.0"}, 5*time.Millisecond)
	}()

	waitForCalls(t, stub, 3)
	_, last := stub.snapshot()
	if last.ClusterID != "c1" || last.Realm != "dev" || last.Version != "1.0" {
		t.Fatalf("自报内容不符: %+v", last)
	}
	// 周期为 0 时用兜底周期而不是忙循环。
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后自报循环未退出")
	}
}

// TestRunClusterReporterKeepsTryingAfterFailure 上报失败不能让它停手。
//
// 停手的后果不是「少一条数据」，而是本集群在 down 阈值之后被闸门挡住自己的新放置——
// 一次瞬时数据库故障会因此变成持续的调度停摆。
func TestRunClusterReporterKeepsTryingAfterFailure(t *testing.T) {
	stub := &reportingStub{failed: true}
	srv := &Server{log: slog.New(slog.DiscardHandler), clusters: stub}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.RunClusterReporter(ctx, ClusterIdentity{ClusterID: "c1"}, 5*time.Millisecond)

	waitForCalls(t, stub, 3)
}

// TestRunClusterReporterLogsOnlyTransitions 失败日志只打状态跃迁，不逐轮刷屏。
//
// 周期是秒级的，逐轮刷屏会让真正要看的预警被埋掉；而「一条都不打」更坏——那时
// 集群被判 down 会毫无征兆。所以判据是：N 次失败恰好一条 Error，恢复时恰好一条 Info。
func TestRunClusterReporterLogsOnlyTransitions(t *testing.T) {
	stub := &reportingStub{failed: true}
	out := &syncBuffer{}
	srv := &Server{log: slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo})), clusters: stub}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go srv.RunClusterReporter(ctx, ClusterIdentity{ClusterID: "c1"}, 5*time.Millisecond)

	waitForCalls(t, stub, 5)
	if got := strings.Count(out.String(), "集群自报失败"); got != 1 {
		t.Fatalf("连续 %d 次失败应只打一条失败日志, got %d 条:\n%s", mustCalls(t, stub), got, out.String())
	}

	stub.setFailed(false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && strings.Count(out.String(), "集群自报已恢复") == 0 {
		time.Sleep(2 * time.Millisecond)
	}
	logs := out.String()
	if got := strings.Count(logs, "集群自报已恢复"); got != 1 {
		t.Fatalf("恢复应恰好一条日志, got %d 条:\n%s", got, logs)
	}
	if strings.Contains(logs, "集群自报失败") && strings.Count(logs, "集群自报失败") != 1 {
		t.Fatalf("失败日志不应重复:\n%s", logs)
	}
}

func mustCalls(t *testing.T, stub *reportingStub) int {
	t.Helper()
	calls, _ := stub.snapshot()
	return calls
}

// TestRunClusterReporterWithoutDirectory 未装配注册表时拒绝启动并留下日志（不 panic）。
func TestRunClusterReporterWithoutDirectory(t *testing.T) {
	out := &syncBuffer{}
	srv := &Server{log: slog.New(slog.NewTextHandler(out, nil))}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.RunClusterReporter(context.Background(), ClusterIdentity{ClusterID: "c1"}, time.Millisecond)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("未装配注册表时应立即返回而不是进入循环")
	}
	if !strings.Contains(out.String(), "联邦注册表未装配") {
		t.Fatalf("应留下明确日志:\n%s", out.String())
	}
}
