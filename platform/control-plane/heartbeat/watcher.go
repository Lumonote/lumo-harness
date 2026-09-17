package heartbeat

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultStaleFactor is how many refresh intervals may be missed before a cached
// snapshot stops being trusted.
const DefaultStaleFactor = 3

// DefaultPruneInterval is how often PruneLoop sweeps replicas that are gone.
const DefaultPruneInterval = 10 * time.Minute

// WatcherOptions configures the background readiness refresher.
type WatcherOptions struct {
	// Required is the closed set of services that must be serving. Empty means
	// DefaultRequiredServices.
	Required []string
	// MaxAge is how old a heartbeat may be before its instance stops counting.
	MaxAge time.Duration
	// Refresh is how often the heartbeat table is re-evaluated.
	Refresh time.Duration
	// StaleAfter is how long a cached snapshot stays usable. It must exceed
	// Refresh, otherwise the gate would close between two successful refreshes.
	StaleAfter time.Duration
	// Timeout bounds a single refresh query, so a hung database surfaces as a
	// failure instead of a snapshot that quietly never updates.
	Timeout time.Duration
	Logger  *slog.Logger
}

// Snapshot is the cached outcome of one readiness evaluation.
//
// Every field is already fail-closed with respect to the gate: Ready is false
// whenever the last refresh failed or the snapshot has gone stale, so a caller
// never has to re-derive safety from the details.
type Snapshot struct {
	// Ready is the value a gate must use.
	Ready bool
	// Reason explains Ready=false and is empty when Ready is true.
	Reason string
	// Unhealthy names the required services that are not serving.
	Unhealthy []string
	// Unknown names services that reported but are not required.
	Unknown []string
	// Services lists every required service, including the ones that never
	// reported.
	Services []ServiceState
	// Dependencies merges the dependency reports of serving instances.
	Dependencies map[string]string
	// EvaluatedAt is when the last refresh ran. It is set even when that refresh
	// failed, so an operator can see how fresh the attempt was.
	EvaluatedAt time.Time
	// Stale marks a snapshot older than StaleAfter. The details are kept, because
	// "this held a minute ago" is still useful for diagnosis.
	Stale bool
	// Err is the last refresh error and is empty when the last refresh succeeded.
	// It survives staleness, so the original cause is never overwritten by "the
	// snapshot is old".
	Err string
}

// Watcher keeps a cached readiness evaluation up to date.
//
// The cache exists because the gate it feeds is consulted on every management
// request. Querying on demand would turn each API call into a database round
// trip, so a slow database would stall the whole surface, and a caller could
// amplify load by simply retrying.
type Watcher struct {
	reader Reader
	opts   WatcherOptions
	log    *slog.Logger

	mu       sync.Mutex
	snapshot Snapshot
}

// NewWatcher fills defaults and returns a watcher that has not evaluated yet.
// Its first Snapshot is not ready, so a gate wired to it starts closed.
func NewWatcher(reader Reader, opts WatcherOptions) *Watcher {
	if len(opts.Required) == 0 {
		opts.Required = append([]string(nil), DefaultRequiredServices...)
	}
	if opts.MaxAge <= 0 {
		opts.MaxAge = DefaultMaxAge
	}
	if opts.Refresh <= 0 {
		opts.Refresh = DefaultInterval
	}
	if opts.StaleAfter <= opts.Refresh {
		opts.StaleAfter = DefaultStaleFactor * opts.Refresh
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Watcher{reader: reader, opts: opts, log: log}
}

// Run refreshes readiness until ctx is cancelled. The first evaluation happens
// immediately: a gate that waited for the first tick would report "unknown" for
// a whole interval after every restart.
func (w *Watcher) Run(ctx context.Context) {
	w.RefreshOnce(ctx)
	ticker := time.NewTicker(w.opts.Refresh)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		w.refresh(ctx)
	}
}

// RefreshOnce evaluates readiness immediately, blocking until the query returns.
//
// Run already does this before its first tick. The method exists so a caller can
// make the first evaluation happen *before* it starts serving, which is what
// turns "the process reported ready at startup" into a statement about the
// cluster rather than about the default value of an empty cache.
func (w *Watcher) RefreshOnce(ctx context.Context) { w.refresh(ctx) }

// Snapshot returns the current readiness. It is cheap and never touches the
// database, which is what makes it safe to call on every request.
func (w *Watcher) Snapshot() Snapshot { return w.SnapshotAt(time.Now()) }

// SnapshotAt is Snapshot with an explicit clock, so staleness is testable.
func (w *Watcher) SnapshotAt(now time.Time) Snapshot {
	w.mu.Lock()
	snapshot := w.snapshot
	w.mu.Unlock()

	if snapshot.EvaluatedAt.IsZero() {
		return Snapshot{Reason: "集群就绪态尚未求值"}
	}
	if age := now.Sub(snapshot.EvaluatedAt); age > w.opts.StaleAfter {
		snapshot.Stale = true
		snapshot.Ready = false
		snapshot.Reason = fmt.Sprintf("集群就绪态快照过期 %s（上限 %s）",
			roundDuration(age), roundDuration(w.opts.StaleAfter))
	}
	return snapshot
}

// Options exposes the resolved options, so a caller can report the interval it
// actually runs at instead of the value it hoped to set.
func (w *Watcher) Options() WatcherOptions { return w.opts }

func (w *Watcher) refresh(ctx context.Context) {
	queryCtx, cancel := context.WithTimeout(ctx, w.opts.Timeout)
	defer cancel()
	rows, err := ReadAll(queryCtx, w.reader)
	if err != nil {
		// Fail closed and drop the details: the previous service list is exactly
		// what we can no longer vouch for, and showing it beside a "cannot
		// evaluate" reason invites reading it as current.
		w.store(Snapshot{
			EvaluatedAt: time.Now(),
			Err:         err.Error(),
			Reason:      "读取心跳失败，集群就绪态不可判定：" + err.Error(),
		})
		if ctx.Err() == nil {
			w.log.Error("readiness refresh failed", "err", err)
		}
		return
	}
	readiness := Evaluate(rows, w.opts.Required, w.opts.MaxAge)
	w.store(Snapshot{
		Ready:        readiness.Ready,
		Reason:       readiness.Reason,
		Unhealthy:    readiness.Unhealthy,
		Unknown:      readiness.Unknown,
		Services:     readiness.Services,
		Dependencies: readiness.Dependencies,
		EvaluatedAt:  readiness.EvaluatedAt,
	})
}

func (w *Watcher) store(snapshot Snapshot) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.snapshot = snapshot
}

// PruneLoop drops heartbeats from replicas that have been gone for `after`.
//
// The table is keyed by (service, instance), so it stays bounded while instance
// identities are stable. Deployments that mint a new identity per rollout —
// random pod suffixes, or the pid-based fallback in resolveInstance — accumulate
// one row per replica per rollout, and nothing else would ever remove them.
func PruneLoop(ctx context.Context, pool *pgxpool.Pool, interval, after time.Duration, log *slog.Logger) {
	if interval <= 0 {
		interval = DefaultPruneInterval
	}
	if log == nil {
		log = slog.Default()
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		removed, err := Prune(ctx, pool, after)
		if err != nil {
			if ctx.Err() == nil {
				log.Warn("prune heartbeats", "err", err)
			}
			continue
		}
		if removed > 0 {
			log.Info("pruned stale heartbeats", "rows", removed)
		}
	}
}
