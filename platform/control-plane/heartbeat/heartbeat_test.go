package heartbeat

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordedCall struct {
	SQL  string
	Args []any
}

// fakeExecer records what the publisher wrote. It is the reason the publisher
// takes a narrow Execer instead of a pool: every behaviour below is asserted
// without a database, which is the only kind of verification this machine can do
// (no PostgreSQL, no container runtime).
type fakeExecer struct {
	mu    sync.Mutex
	calls []recordedCall
	err   error
}

type fakeTag struct{}

func (fakeTag) RowsAffected() int64 { return 1 }

func (f *fakeExecer) Exec(_ context.Context, sql string, args ...any) (CommandTag, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, recordedCall{SQL: sql, Args: args})
	if f.err != nil {
		return nil, f.err
	}
	return fakeTag{}, nil
}

func (f *fakeExecer) snapshot() []recordedCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedCall(nil), f.calls...)
}

func (f *fakeExecer) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等待 %s 超时", what)
}

func TestPublishWritesTheWholeIdentity(t *testing.T) {
	exec := &fakeExecer{}
	publisher := New(exec, Options{
		Service: "scheduler", Instance: "scheduler-0", Version: "1.2.3",
		Depends: func(context.Context) map[string]string { return map[string]string{"postgres": DependencyOK} },
	})
	if err := publisher.PublishOnce(context.Background(), StatusReady); err != nil {
		t.Fatalf("PublishOnce: %v", err)
	}

	calls := exec.snapshot()
	if len(calls) != 1 {
		t.Fatalf("写入次数 = %d，期望 1", len(calls))
	}
	// The statement must be the shared constant, otherwise the publisher and the
	// reader could drift apart without anything failing.
	if calls[0].SQL != UpsertSQL {
		t.Errorf("未使用 UpsertSQL 常量")
	}
	want := []any{"scheduler", "scheduler-0", StatusReady, "1.2.3", map[string]string{"postgres": DependencyOK}}
	if len(calls[0].Args) != len(want) {
		t.Fatalf("参数个数 = %d，期望 %d", len(calls[0].Args), len(want))
	}
	for i := range want {
		if !reflect.DeepEqual(calls[0].Args[i], want[i]) {
			t.Errorf("参数[%d] = %#v，期望 %#v", i, calls[0].Args[i], want[i])
		}
	}
}

// Readiness opens the management surface, so a fresh cluster must not spend a
// whole interval looking unready. Run therefore publishes before it waits.
func TestRunPublishesBeforeTheFirstInterval(t *testing.T) {
	exec := &fakeExecer{}
	// A one hour interval means a call can only come from the immediate publish.
	publisher := New(exec, Options{Service: "scheduler", Instance: "scheduler-0", Interval: time.Hour})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); publisher.Run(ctx) }()

	waitFor(t, "首次心跳", func() bool { return len(exec.snapshot()) >= 1 })
	if status := exec.snapshot()[0].Args[2]; status != StatusReady {
		t.Errorf("首次心跳状态 = %v，期望 %s", status, StatusReady)
	}
	cancel()
	<-done
}

// A rolling restart should read as a transition, not as a crash.
func TestRunMarksStoppingOnShutdown(t *testing.T) {
	exec := &fakeExecer{}
	publisher := New(exec, Options{Service: "scheduler", Instance: "scheduler-0", Interval: time.Hour})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); publisher.Run(ctx) }()
	waitFor(t, "首次心跳", func() bool { return len(exec.snapshot()) >= 1 })

	cancel()
	<-done

	calls := exec.snapshot()
	last := calls[len(calls)-1]
	if last.Args[2] != StatusStopping {
		t.Fatalf("停机状态 = %v，期望 %s", last.Args[2], StatusStopping)
	}
}

// A database outage lasts many intervals. Logging every attempt would bury the
// signal, so only the transition is logged — but the transition must appear.
func TestPublishFailureLogsOncePerStateChange(t *testing.T) {
	var buf bytes.Buffer
	exec := &fakeExecer{}
	publisher := New(exec, Options{
		Service: "scheduler", Instance: "scheduler-0",
		Logger: slog.New(slog.NewJSONHandler(&buf, nil)),
	})
	ctx := context.Background()
	outage := errors.New("connection refused")

	exec.setErr(outage)
	for i := 0; i < 3; i++ {
		if err := publisher.PublishOnce(ctx, StatusReady); err == nil {
			t.Fatal("期望上报失败")
		}
	}
	if got := strings.Count(buf.String(), "heartbeat publish failed"); got != 1 {
		t.Errorf("故障期日志条数 = %d，期望 1（只在状态变化时记一次）：%s", got, buf.String())
	}

	exec.setErr(nil)
	if err := publisher.PublishOnce(ctx, StatusReady); err != nil {
		t.Fatalf("恢复后仍失败: %v", err)
	}
	if got := strings.Count(buf.String(), "heartbeat publish recovered"); got != 1 {
		t.Errorf("恢复日志条数 = %d，期望 1：%s", got, buf.String())
	}

	// A second outage is a new transition and must be reported again.
	exec.setErr(outage)
	if err := publisher.PublishOnce(ctx, StatusReady); err == nil {
		t.Fatal("期望上报失败")
	}
	if got := strings.Count(buf.String(), "heartbeat publish failed"); got != 2 {
		t.Errorf("第二次故障后日志条数 = %d，期望 2：%s", got, buf.String())
	}
}

// A heartbeat failure must never be fatal: a database outage is exactly when the
// service has to stay up, and the missing heartbeat is itself the signal.
func TestPublishFailureIsNotFatal(t *testing.T) {
	exec := &fakeExecer{}
	exec.setErr(errors.New("down"))
	publisher := New(exec, Options{Service: "scheduler", Instance: "scheduler-0"})
	if err := publisher.PublishOnce(context.Background(), StatusReady); err == nil {
		t.Fatal("期望返回错误")
	}
}

func TestInstanceIdentity(t *testing.T) {
	t.Run("显式覆盖优先", func(t *testing.T) {
		t.Setenv("LUMO_INSTANCE", "scheduler-0")
		if got := resolveInstance(); got != "scheduler-0" {
			t.Errorf("实例名 = %q，期望 scheduler-0", got)
		}
	})

	t.Run("同进程内稳定且带进程号", func(t *testing.T) {
		t.Setenv("LUMO_INSTANCE", "")
		first, second := resolveInstance(), resolveInstance()
		if first != second {
			t.Errorf("同进程两次取值不同：%q vs %q", first, second)
		}
		// The process id is what keeps two replicas on one host from colliding on
		// the (service, instance) primary key.
		if !strings.HasSuffix(first, "-"+strconv.Itoa(os.Getpid())) {
			t.Errorf("实例名 %q 未以进程号结尾", first)
		}
	})
}

func TestVersionDefaultsToDev(t *testing.T) {
	t.Setenv("LUMO_SERVICE_VERSION", "")
	if got := resolveVersion(); got != "dev" {
		t.Errorf("版本 = %q，期望 dev", got)
	}
	t.Setenv("LUMO_SERVICE_VERSION", "9.9.9")
	if got := resolveVersion(); got != "9.9.9" {
		t.Errorf("版本 = %q，期望 9.9.9", got)
	}
}

func TestNewFillsDefaults(t *testing.T) {
	publisher := New(&fakeExecer{}, Options{Service: "scheduler"})
	if publisher.opts.Interval != DefaultInterval {
		t.Errorf("Interval = %v，期望 %v", publisher.opts.Interval, DefaultInterval)
	}
	if publisher.opts.Timeout != DefaultTimeout {
		t.Errorf("Timeout = %v，期望 %v", publisher.opts.Timeout, DefaultTimeout)
	}
	if publisher.opts.Instance == "" {
		t.Error("Instance 未填默认值")
	}
	if publisher.Service() != "scheduler" {
		t.Errorf("Service() = %q", publisher.Service())
	}
	if publisher.Instance() != publisher.opts.Instance {
		t.Errorf("Instance() = %q", publisher.Instance())
	}
}
