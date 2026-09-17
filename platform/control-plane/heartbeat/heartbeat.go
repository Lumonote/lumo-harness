// Package heartbeat publishes per-instance liveness rows and derives cluster
// readiness from them.
//
// Two decisions shape everything here:
//
//  1. **Readiness is derived, not declared.** `LUMO_CLUSTER_STATUS` stays as the
//     operator's *intent* ("this deployment is a cluster"). Whether the cluster
//     is actually ready is computed from fresh heartbeats plus each instance's
//     self-reported dependency status. A declared-only value keeps the
//     management surface open while the scheduler is dead, which is the defect
//     this package exists to close.
//
//  2. **The required service set is closed and explicit.** Readiness is never
//     inferred from "whoever happened to report", because a service that never
//     started would then be silently absent from the check instead of counted as
//     missing. Absence must read as failure.
//
// Staleness is always computed with the **database** clock (`now() - observed_at`).
// Comparing `observed_at` against Go's `time.Now()` would compare two machines'
// clocks, and heartbeats arrive from many hosts, so the skew is unbounded and the
// resulting readiness signal would be flaky in a way no test could pin down.
package heartbeat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Schema constants. Table, columns and statements live here so the publisher and
// the reader cannot drift apart; the migration that creates the table is
// platform/deploy/migrations/004_service_heartbeats.sql.
const (
	// Table is the platform-owned heartbeat table.
	Table = "lumo_service_heartbeats"

	// StatusReady means the instance is serving.
	StatusReady = "ready"
	// StatusStopping means the instance is shutting down. It is written once on
	// graceful shutdown so a rolling restart is visible as a transition instead
	// of looking like a crash.
	StatusStopping = "stopping"

	// DependencyOK is the value an instance reports for a dependency it can
	// reach. Any other value counts against that instance.
	DependencyOK = "ok"
)

// CreateTableSQL creates the heartbeat table in its current shape.
//
// Services carry their own idempotent DDL because no Compose file runs
// platform/deploy/migrate.sh; the versioned migration
// 004_service_heartbeats.sql exists for production upgrades and produces the
// same shape.
const CreateTableSQL = `CREATE TABLE IF NOT EXISTS ` + Table + ` (
  service      TEXT NOT NULL,
  instance     TEXT NOT NULL,
  status       TEXT NOT NULL,
  version      TEXT NOT NULL,
  dependencies JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service, instance)
)`

// UpgradeSQL corrects a table created by an earlier revision, which keyed on
// `service` alone and had no `dependencies`.
//
// It exists because `CREATE TABLE IF NOT EXISTS` does nothing to a table that
// already exists: without this, a database that once ran migration 001 would keep
// the single-column key and every upsert would fail with "no unique or exclusion
// constraint matching the ON CONFLICT specification". The statements mirror
// 004_service_heartbeats.sql, and both are idempotent so the two paths converge.
const UpgradeSQL = `ALTER TABLE ` + Table + ` DROP CONSTRAINT IF EXISTS ` + Table + `_pkey;
ALTER TABLE ` + Table + ` ADD CONSTRAINT ` + Table + `_pkey PRIMARY KEY (service, instance);
ALTER TABLE ` + Table + ` ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '{}'::jsonb`

// SchemaSQL is what a service executes at startup: create, then upgrade.
const SchemaSQL = CreateTableSQL + ";\n" + UpgradeSQL

// UpsertSQL writes one instance heartbeat. `observed_at` is assigned by the
// database so every row in the table shares a single clock.
const UpsertSQL = `INSERT INTO ` + Table + ` (service, instance, status, version, dependencies, observed_at)
VALUES ($1, $2, $3, $4, $5, now())
ON CONFLICT (service, instance) DO UPDATE
   SET status = EXCLUDED.status,
       version = EXCLUDED.version,
       dependencies = EXCLUDED.dependencies,
       observed_at = now()`

// SelectSQL returns every heartbeat with its age measured against the database
// clock. `age_seconds` is computed in SQL on purpose — see the package comment.
const SelectSQL = `SELECT service, instance, status, version, dependencies,
       EXTRACT(EPOCH FROM (now() - observed_at))::float8 AS age_seconds
  FROM ` + Table

// PruneSQL drops rows that have been silent for longer than the given number of
// seconds. Without it a pod name that changes on every restart would accumulate
// rows forever, and the "quiet replica" report would cry wolf.
const PruneSQL = `DELETE FROM ` + Table + ` WHERE observed_at < now() - make_interval(secs => $1)`

// Defaults. The interval is deliberately much smaller than the age limit: three
// consecutive failures must not be enough to declare a service unhealthy.
const (
	DefaultInterval = 10 * time.Second
	DefaultTimeout  = 5 * time.Second
	DefaultMaxAge   = 45 * time.Second
	// DefaultPruneAfter bounds the table. A replica quiet for longer than this is
	// dropped from the report rather than reported forever.
	DefaultPruneAfter = time.Hour
)

// Heartbeat is one instance's last report.
type Heartbeat struct {
	Service      string
	Instance     string
	Status       string
	Version      string
	Dependencies map[string]string
	// Age is how long ago the database last saw this instance.
	Age time.Duration
}

// Execer is the narrow slice of pgx the publisher needs, so a test can pass a
// fake.
//
// Note that `*pgxpool.Pool` does **not** satisfy this directly: its Exec returns
// the concrete `pgconn.CommandTag` while the interface declares the CommandTag
// interface, and Go requires the return types to match exactly. PoolExecer does
// the adaptation, which is also what keeps this package from forcing every
// caller to import pgconn.
type Execer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (CommandTag, error)
}

// CommandTag mirrors the pgx command tag.
type CommandTag = interface{ RowsAffected() int64 }

// Options configures a Publisher. Only Service is required.
type Options struct {
	// Service is the logical service name, e.g. "scheduler". Every replica of a
	// service reports the same value; the required-service list is written in
	// these terms.
	Service string
	// Instance identifies one replica. Defaults to LUMO_INSTANCE (the name the
	// scheduler and collaborator already use for this purpose), then
	// "hostname-processid", then a random suffix. Two replicas must not share it:
	// the table is keyed on (service, instance) and a shared value would make them
	// overwrite each other, hiding one of them.
	Instance string
	// Version is reported for visibility only. It never gates readiness.
	Version string
	// Interval between heartbeats. Defaults to DefaultInterval.
	Interval time.Duration
	// Timeout bounds a single publish. Defaults to DefaultTimeout.
	Timeout time.Duration
	// Depends reports this instance's view of the dependencies it actually uses.
	// Nil means the instance reports none, which is honest rather than a claim
	// that they are healthy.
	Depends func(ctx context.Context) map[string]string
	// Logger receives publish failures. Defaults to slog.Default().
	Logger *slog.Logger
}

// Publisher writes one instance's heartbeat on a loop.
type Publisher struct {
	exec Execer
	opts Options
	log  *slog.Logger

	// lastFailure holds the previous failure message so a database outage logs a
	// transition rather than one warning per interval. Comparing messages is
	// crude but it keeps the signal ("this started failing") without a counter.
	lastFailure string
}

// PoolExecer adapts a pgx pool to Execer.
func PoolExecer(pool *pgxpool.Pool) Execer { return poolExecer{pool: pool} }

type poolExecer struct{ pool *pgxpool.Pool }

func (p poolExecer) Exec(ctx context.Context, sql string, args ...any) (CommandTag, error) {
	tag, err := p.pool.Exec(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return tag, nil
}

// New builds a Publisher. It does not start anything; call Run.
func New(exec Execer, opts Options) *Publisher {
	if opts.Interval <= 0 {
		opts.Interval = DefaultInterval
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.Instance == "" {
		opts.Instance = resolveInstance()
	}
	if opts.Version == "" {
		opts.Version = resolveVersion()
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Publisher{exec: exec, opts: opts, log: log}
}

// EnsureSchema creates the heartbeat table, or upgrades an earlier shape.
//
// Every service calls this at startup and they may race: PostgreSQL's
// IF NOT EXISTS does not serialize creation of the backing relation/type, so the
// DDL runs in one transaction holding a cluster-wide advisory lock. That is the
// same pattern the scheduler and governance stores use; the lock key is derived
// from a name rather than being a magic integer.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("heartbeat: 开启建表事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('lumo:heartbeat:ddl', 0))`); err != nil {
		return fmt.Errorf("heartbeat: 获取建表锁失败: %w", err)
	}
	if _, err := tx.Exec(ctx, SchemaSQL); err != nil {
		return fmt.Errorf("heartbeat: 建表失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("heartbeat: 提交建表事务失败: %w", err)
	}
	return nil
}

// StartPg builds a publisher bound to a pool and runs it in the background. It
// returns the publisher so the caller can stop it explicitly; Run also stops on
// context cancellation.
func StartPg(ctx context.Context, pool *pgxpool.Pool, opts Options) *Publisher {
	publisher := New(PoolExecer(pool), opts)
	go func() {
		// Schema first, so the very first heartbeat is not a wasted round trip.
		// A failure is not fatal: the publish-failure log and the resulting
		// staleness are the visible signal, and the service must keep serving.
		if err := EnsureSchema(ctx, pool); err != nil {
			publisher.log.Error("heartbeat schema not ready", "service", opts.Service, "err", err)
		}
		publisher.Run(ctx)
	}()
	return publisher
}

// PgDependency reports PostgreSQL reachability. Services that depend on more than
// PostgreSQL should compose their own map and merge this in, reporting only what
// they can genuinely probe — an unprobed dependency must not be reported as ok.
func PgDependency(pool *pgxpool.Pool) func(ctx context.Context) map[string]string {
	return func(ctx context.Context) map[string]string {
		probe, cancel := context.WithTimeout(ctx, DefaultTimeout)
		defer cancel()
		if err := pool.Ping(probe); err != nil {
			return map[string]string{"postgres": "unreachable"}
		}
		return map[string]string{"postgres": DependencyOK}
	}
}

// Run publishes immediately, then on every interval, and finally records a
// stopping heartbeat.
//
// Publishing immediately matters: a fresh cluster would otherwise spend a full
// interval looking unready, and readiness is what opens the management surface.
func (p *Publisher) Run(ctx context.Context) {
	p.publish(ctx, StatusReady)

	ticker := time.NewTicker(p.opts.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			// Best effort: the context is already cancelled, so this write gets
			// its own. If it fails the instance simply goes stale, which is the
			// same signal as a crash.
			stopCtx, cancel := context.WithTimeout(context.Background(), p.opts.Timeout)
			p.publish(stopCtx, StatusStopping)
			cancel()
			return
		case <-ticker.C:
			p.publish(ctx, StatusReady)
		}
	}
}

// PublishOnce writes a single heartbeat.
//
// A failure is both reported through the publisher's logger (transitions only, so
// an outage does not log once per interval) and returned, so a caller managing
// its own loop gets the same signal without reimplementing transition tracking.
func (p *Publisher) PublishOnce(ctx context.Context, status string) error {
	attempt, cancel := context.WithTimeout(ctx, p.opts.Timeout)
	defer cancel()
	err := p.write(attempt, status)
	p.report(err)
	return err
}

func (p *Publisher) publish(ctx context.Context, status string) {
	// The loop deliberately ignores the error: a heartbeat failure must never be
	// fatal, and PublishOnce has already reported it.
	_ = p.PublishOnce(ctx, status)
}

func (p *Publisher) write(ctx context.Context, status string) error {
	dependencies := map[string]string{}
	if p.opts.Depends != nil {
		if reported := p.opts.Depends(ctx); reported != nil {
			dependencies = reported
		}
	}
	_, err := p.exec.Exec(ctx, UpsertSQL, p.opts.Service, p.opts.Instance, status, p.opts.Version, dependencies)
	return err
}

// report logs a failure once per distinct message. A heartbeat failure is never
// fatal: the database being down is exactly when the service must keep running,
// and the missing heartbeat is itself the signal that readiness will degrade.
func (p *Publisher) report(err error) {
	if err == nil {
		if p.lastFailure != "" {
			p.lastFailure = ""
			p.log.Info("heartbeat publish recovered", "service", p.opts.Service, "instance", p.opts.Instance)
		}
		return
	}
	if message := err.Error(); message != p.lastFailure {
		p.lastFailure = message
		p.log.Warn("heartbeat publish failed",
			"service", p.opts.Service, "instance", p.opts.Instance, "err", err)
	}
}

// Instance returns the identity this publisher reports under.
func (p *Publisher) Instance() string { return p.opts.Instance }

// Service returns the service name this publisher reports under.
func (p *Publisher) Service() string { return p.opts.Service }

// resolveInstance picks an identity that is unique per running process.
//
// The hostname alone is not enough: two replicas of one service on the same host
// would collide on the (service, instance) primary key and overwrite each other,
// which would hide one of them. The process id separates them.
//
// LUMO_INSTANCE is reused rather than introducing a second variable for the same
// idea: the scheduler and the collaborator already read it for instance
// identity, and Compose already sets it to values like "scheduler-0".
func resolveInstance() string {
	if value := strings.TrimSpace(os.Getenv("LUMO_INSTANCE")); value != "" {
		return value
	}
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		// Last resort: a random identity is still better than a shared one.
		var buf [8]byte
		if _, err := rand.Read(buf[:]); err != nil {
			return fmt.Sprintf("unknown-%d", os.Getpid())
		}
		return "unknown-" + hex.EncodeToString(buf[:])
	}
	return fmt.Sprintf("%s-%d", hostname, os.Getpid())
}

func resolveVersion() string {
	if value := strings.TrimSpace(os.Getenv("LUMO_SERVICE_VERSION")); value != "" {
		return value
	}
	return "dev"
}
