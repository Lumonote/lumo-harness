package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeRows replays Heartbeat values through the pgx.Rows contract, so the
// watcher's state machine and ReadAll's column parsing are both exercised
// without a database.
type fakeRows struct {
	rows      []Heartbeat
	index     int
	err       error
	scanErrAt int
	scans     int
}

func (r *fakeRows) Close()                                       {}
func (r *fakeRows) Err() error                                   { return r.err }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Values() ([]any, error)                       { return nil, nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeRows) Next() bool {
	if r.index >= len(r.rows) {
		return false
	}
	r.index++
	return true
}

// Scan writes the same columns and in the same order as SelectSQL, which is what
// makes it able to catch a column reordering.
func (r *fakeRows) Scan(dest ...any) error {
	r.scans++
	if r.scanErrAt > 0 && r.scans == r.scanErrAt {
		return errors.New("scan failed")
	}
	row := r.rows[r.index-1]
	dependencies, err := json.Marshal(row.Dependencies)
	if err != nil {
		return err
	}
	*dest[0].(*string) = row.Service
	*dest[1].(*string) = row.Instance
	*dest[2].(*string) = row.Status
	*dest[3].(*string) = row.Version
	*dest[4].(*[]byte) = dependencies
	*dest[5].(*float64) = row.Age.Seconds()
	return nil
}

type fakeReader struct {
	rows []Heartbeat
	err  error
	// scanErrAt fails the Nth Scan of each result set.
	scanErrAt int
	calls     int
}

func (f *fakeReader) Query(ctx context.Context, _ string, _ ...any) (pgx.Rows, error) {
	f.calls++
	// Honour the context, as a real driver does. Without this the timeout and
	// cancellation paths would look like successes.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.err != nil {
		return nil, f.err
	}
	return &fakeRows{rows: f.rows, scanErrAt: f.scanErrAt}, nil
}

func watcherWith(reader Reader, opts WatcherOptions) *Watcher {
	if opts.Required == nil {
		opts.Required = []string{"scheduler"}
	}
	if opts.MaxAge == 0 {
		opts.MaxAge = time.Minute
	}
	return NewWatcher(reader, opts)
}

func servingRows() []Heartbeat {
	return []Heartbeat{{Service: "scheduler", Instance: "scheduler-0", Status: StatusReady, Version: "dev", Age: time.Second}}
}

func TestNewWatcherFillsDefaults(t *testing.T) {
	w := NewWatcher(&fakeReader{}, WatcherOptions{})
	opts := w.Options()
	if opts.Refresh != DefaultInterval {
		t.Fatalf("refresh = %s, want %s", opts.Refresh, DefaultInterval)
	}
	if opts.MaxAge != DefaultMaxAge {
		t.Fatalf("max age = %s, want %s", opts.MaxAge, DefaultMaxAge)
	}
	if opts.Timeout != DefaultTimeout {
		t.Fatalf("timeout = %s, want %s", opts.Timeout, DefaultTimeout)
	}
	if len(opts.Required) != len(DefaultRequiredServices) {
		t.Fatalf("required = %v, want the default set", opts.Required)
	}
	// The staleness bound must exceed the refresh interval, or the gate would
	// close between two successful refreshes.
	if opts.StaleAfter <= opts.Refresh {
		t.Fatalf("stale after %s must exceed refresh %s", opts.StaleAfter, opts.Refresh)
	}
}

func TestWatcherStartsClosedBeforeItsFirstEvaluation(t *testing.T) {
	w := watcherWith(&fakeReader{rows: servingRows()}, WatcherOptions{})
	snapshot := w.Snapshot()
	if snapshot.Ready {
		t.Fatal("a watcher that has never evaluated must not report ready")
	}
	if snapshot.Reason == "" {
		t.Fatal("a closed gate must explain itself")
	}
	if snapshot.EvaluatedAt.IsZero() != true {
		t.Fatal("evaluated_at must be zero before the first evaluation")
	}
}

func TestRefreshOncePublishesTheEvaluation(t *testing.T) {
	w := watcherWith(&fakeReader{rows: servingRows()}, WatcherOptions{})
	w.RefreshOnce(context.Background())

	snapshot := w.Snapshot()
	if !snapshot.Ready {
		t.Fatalf("snapshot = %+v, want ready", snapshot)
	}
	if len(snapshot.Services) != 1 || !snapshot.Services[0].Healthy {
		t.Fatalf("services = %+v", snapshot.Services)
	}
	if snapshot.EvaluatedAt.IsZero() {
		t.Fatal("a successful evaluation must stamp its time")
	}
	if snapshot.Err != "" {
		t.Fatalf("err = %q, want empty", snapshot.Err)
	}
}

func TestRefreshParsesTheStoredColumns(t *testing.T) {
	reader := &fakeReader{rows: []Heartbeat{{
		Service: "scheduler", Instance: "scheduler-1", Status: StatusReady, Version: "1.2.3",
		Dependencies: map[string]string{"postgres": DependencyOK},
		Age:          2500 * time.Millisecond,
	}}}
	w := watcherWith(reader, WatcherOptions{})
	w.RefreshOnce(context.Background())

	state := w.Snapshot().Services[0]
	if len(state.Instances) != 1 {
		t.Fatalf("instances = %+v", state.Instances)
	}
	instance := state.Instances[0]
	if instance.Instance != "scheduler-1" || instance.Version != "1.2.3" {
		t.Fatalf("instance = %+v", instance)
	}
	// The age travels as float seconds and must survive the round trip, because a
	// units mistake here would silently mark every replica fresh or stale.
	if instance.Age != 2500*time.Millisecond {
		t.Fatalf("age = %s, want 2.5s", instance.Age)
	}
	if instance.Dependencies["postgres"] != DependencyOK {
		t.Fatalf("dependencies = %v", instance.Dependencies)
	}
}

func TestRefreshFailureFailsClosedAndDropsStaleDetails(t *testing.T) {
	reader := &fakeReader{rows: servingRows()}
	w := watcherWith(reader, WatcherOptions{})
	w.RefreshOnce(context.Background())
	if !w.Snapshot().Ready {
		t.Fatal("precondition: the first evaluation should be ready")
	}

	reader.err = errors.New("connection refused")
	w.RefreshOnce(context.Background())

	snapshot := w.Snapshot()
	if snapshot.Ready {
		t.Fatal("a failed refresh must close the gate")
	}
	if snapshot.Err == "" {
		t.Fatal("the failure must be recorded")
	}
	// The previous service list is exactly what can no longer be vouched for.
	if len(snapshot.Services) != 0 || len(snapshot.Unhealthy) != 0 {
		t.Fatalf("details must be dropped on failure, got %+v", snapshot)
	}
	if snapshot.EvaluatedAt.IsZero() {
		t.Fatal("a failed refresh must still stamp the attempt")
	}
}

func TestSnapshotGoesStaleAndClosesTheGate(t *testing.T) {
	w := watcherWith(&fakeReader{rows: servingRows()}, WatcherOptions{
		Refresh: time.Second, StaleAfter: 3 * time.Second,
	})
	w.RefreshOnce(context.Background())
	taken := w.Snapshot()
	if !taken.Ready {
		t.Fatal("precondition: the evaluation should be ready")
	}

	// Just inside the window: still trustworthy.
	if fresh := w.SnapshotAt(taken.EvaluatedAt.Add(2 * time.Second)); !fresh.Ready || fresh.Stale {
		t.Fatalf("snapshot inside the window = %+v, want ready and not stale", fresh)
	}

	stale := w.SnapshotAt(taken.EvaluatedAt.Add(4 * time.Second))
	if stale.Ready {
		t.Fatal("a stale snapshot must close the gate")
	}
	if !stale.Stale {
		t.Fatal("stale must be reported so a caller can tell it apart from a failure")
	}
	if stale.Reason == "" {
		t.Fatal("a closed gate must explain itself")
	}
	// Details survive staleness: "this held a minute ago" is still diagnostic.
	if len(stale.Services) != 1 {
		t.Fatalf("services = %+v, want the last known set kept", stale.Services)
	}
	if stale.Err != "" {
		t.Fatalf("err = %q, want empty: staleness is not a query failure", stale.Err)
	}
}

func TestStalenessDoesNotEraseTheOriginalFailure(t *testing.T) {
	reader := &fakeReader{err: errors.New("connection refused")}
	w := watcherWith(reader, WatcherOptions{Refresh: time.Second, StaleAfter: 3 * time.Second})
	w.RefreshOnce(context.Background())

	snapshot := w.SnapshotAt(w.Snapshot().EvaluatedAt.Add(time.Minute))
	if snapshot.Ready {
		t.Fatal("must stay closed")
	}
	if snapshot.Err == "" {
		t.Fatal("staleness must not overwrite the cause of the failure")
	}
}

func TestRunEvaluatesImmediatelyThenKeepsRefreshing(t *testing.T) {
	reader := &fakeReader{rows: servingRows()}
	w := watcherWith(reader, WatcherOptions{Refresh: 20 * time.Millisecond})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); w.Run(ctx) }()

	// The first evaluation must not wait for the first tick, otherwise every
	// restart would leave the gate unknown for a whole interval.
	waitFor(t, "first evaluation", func() bool { return w.Snapshot().Ready })
	waitFor(t, "a second evaluation", func() bool { return reader.calls >= 2 })

	cancel()
	<-done
}

func TestRefreshTimeoutIsReportedAsAFailure(t *testing.T) {
	// A cancelled context stands in for the query timeout firing: both must land
	// on the failure path rather than leaving the previous verdict in place.
	w := watcherWith(&fakeReader{rows: servingRows()}, WatcherOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.RefreshOnce(ctx)
	if w.Snapshot().Ready {
		t.Fatal("a cancelled query must not leave the gate open")
	}
	if w.Snapshot().Err == "" {
		t.Fatal("a cancelled query must be recorded")
	}
}

func TestReadAllReportsScanAndRowErrors(t *testing.T) {
	if _, err := ReadAll(context.Background(), &fakeReader{scanErrAt: 1, rows: servingRows()}); err == nil {
		t.Fatal("a scan failure must surface")
	}
	if _, err := ReadAll(context.Background(), &fakeReader{err: errors.New("boom")}); err == nil {
		t.Fatal("a query failure must surface")
	}
}

func TestReadAllTreatsMissingDependenciesAsEmpty(t *testing.T) {
	rows, err := ReadAll(context.Background(), &fakeReader{rows: []Heartbeat{
		{Service: "scheduler", Instance: "scheduler-0", Status: StatusReady, Age: time.Second},
	}})
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	// A null or absent column must not become a nil map, because every consumer
	// indexes it without a nil check.
	if rows[0].Dependencies == nil {
		t.Fatal("dependencies must default to an empty map")
	}
	if len(rows[0].Dependencies) != 0 {
		t.Fatalf("dependencies = %v, want empty", rows[0].Dependencies)
	}
}
