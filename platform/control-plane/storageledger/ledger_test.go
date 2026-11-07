package storageledger

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN not set")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 8)
	if _, err = rand.Read(id); err != nil {
		t.Fatal(err)
	}
	schema := "storage_ledger_" + hex.EncodeToString(id)
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
		admin.Close()
	})
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = Ensure(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return pool
}

func charge(pool *pgxpool.Pool, c Charge) error {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = Register(ctx, tx, c); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func TestConcurrentProjectsShareRealmQuota(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO platform_storage_limits(realm,scope,scope_id,limit_bytes) VALUES('r','realm','',100),('r','project','p',30)`); err != nil {
		t.Fatal(err)
	}
	var ok, denied atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			kind := "run-file"
			project := "q"
			if i%2 == 0 {
				project = "p"
			}
			err := charge(pool, Charge{Realm: "r", ProjectID: project, Kind: kind, ReferenceID: hex.EncodeToString([]byte{byte(i)}), Bytes: 10})
			if err == nil {
				ok.Add(1)
			} else if errors.Is(err, ErrQuota) {
				denied.Add(1)
			} else {
				t.Errorf("charge: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if ok.Load() != 10 || denied.Load() != 40 {
		t.Fatalf("accepted=%d denied=%d", ok.Load(), denied.Load())
	}
	var total, p int64
	if err := pool.QueryRow(ctx, `SELECT sum(bytes),sum(bytes) FILTER(WHERE project_id='p') FROM platform_storage_charges`).Scan(&total, &p); err != nil {
		t.Fatal(err)
	}
	if total != 100 || p > 30 {
		t.Fatalf("over quota: total=%d project=%d", total, p)
	}
}

func TestChargeRollbackIdempotencyAndIsolation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	c := Charge{Realm: "r", ProjectID: "p", Kind: "session-attachment", ReferenceID: "session/receipt", Bytes: 5, ObjectKey: "r/content/hash"}
	tx, _ := pool.Begin(ctx)
	if err := Register(ctx, tx, c); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM platform_storage_charges`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback=%d %v", count, err)
	}
	if err := charge(pool, c); err != nil {
		t.Fatal(err)
	}
	if err := charge(pool, c); err != nil {
		t.Fatal(err)
	}
	changed := c
	changed.Bytes++
	if err := charge(pool, changed); err == nil {
		t.Fatal("mutable charge")
	}
	changed = c
	changed.Realm = "other"
	if err := charge(pool, changed); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE platform_storage_charges SET released_at=clock_timestamp() WHERE realm='r'`); err != nil {
		t.Fatal(err)
	}
	if err := charge(pool, c); err == nil {
		t.Fatal("released reference revived")
	}
}

func TestHistoricalBackfillDoesNotDeleteOrHideOverage(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO platform_storage_limits(realm,scope,scope_id,limit_bytes) VALUES('r','realm','',0)`); err != nil {
		t.Fatal(err)
	}
	tx, _ := pool.Begin(ctx)
	c := Charge{Realm: "r", Kind: "task-artifact", ReferenceID: "legacy", Bytes: 10}
	if err := register(ctx, tx, c, true); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	c.ReferenceID = "new"
	if err := charge(pool, c); !errors.Is(err, ErrQuota) {
		t.Fatalf("overage not enforced: %v", err)
	}
	var size int64
	if err := pool.QueryRow(ctx, `SELECT sum(bytes) FROM platform_storage_charges`).Scan(&size); err != nil || size != 10 {
		t.Fatalf("history lost: %d %v", size, err)
	}
}

func TestConfiguredLimitWaitsForPresentProducerCoverage(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE session_attachment_receipts(id text); INSERT INTO platform_storage_limits(realm,scope,scope_id,limit_bytes) VALUES('r','realm','',100)`); err != nil {
		t.Fatal(err)
	}
	c := Charge{Realm: "r", Kind: "run-file", ReferenceID: "new", Bytes: 1}
	if err := charge(pool, c); !errors.Is(err, ErrCoverage) {
		t.Fatalf("incomplete backfill accepted: %v", err)
	}
	tx, _ := pool.Begin(ctx)
	if err := CompleteCoverage(ctx, tx, "session-attachment"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := charge(pool, c); err != nil {
		t.Fatal(err)
	}
}

func TestInitializeReleasesLedgerDDLLocksBeforeBackfillWaitsForWriter(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx, `CREATE TABLE legacy_storage_sources(realm text,project_id text,reference_id text,bytes bigint,object_key text);
INSERT INTO legacy_storage_sources VALUES('r','p','historical',5,'legacy-object')`); err != nil {
		t.Fatal(err)
	}
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if err = Lock(ctx, writer, "r", "p"); err != nil {
		t.Fatal(err)
	}
	writerPID := writer.Conn().PgConn().PID()
	started := make(chan uint32, 1)
	outcome := make(chan error, 1)
	go func() {
		outcome <- Initialize(ctx, pool, func(tx pgx.Tx) error {
			started <- tx.Conn().PgConn().PID()
			if err := Backfill(ctx, tx, `SELECT s.realm,s.project_id,'run-file',s.reference_id,s.bytes,s.object_key
FROM legacy_storage_sources s WHERE NOT EXISTS(SELECT 1 FROM platform_storage_charges c WHERE c.realm=s.realm AND c.kind='run-file' AND c.reference_id=s.reference_id)
ORDER BY s.realm,s.reference_id`); err != nil {
				return err
			}
			return CompleteCoverage(ctx, tx, "run-file")
		})
	}()
	var startupPID uint32
	select {
	case startupPID = <-started:
	case err = <-outcome:
		t.Fatalf("initialization ended before backfill: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for {
		var blocked bool
		if err = pool.QueryRow(ctx, `SELECT $1=ANY(pg_blocking_pids($2))`, writerPID, startupPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("initialization never reached the live writer's realm lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The upload has acquired its realm lock but has not registered its charge.
	// Startup must let this insert finish while its historical backfill waits.
	if err = Register(ctx, writer, Charge{Realm: "r", ProjectID: "p", Kind: "run-file", ReferenceID: "live", Bytes: 7, ObjectKey: "live-object"}); err != nil {
		t.Fatal(err)
	}
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-outcome; err != nil {
		t.Fatalf("initialization failed alongside the live writer: %v", err)
	}
	var count int
	var total int64
	if err = pool.QueryRow(ctx, `SELECT count(*),sum(bytes) FROM platform_storage_charges WHERE realm='r' AND released_at IS NULL`).Scan(&count, &total); err != nil || count != 2 || total != 12 {
		t.Fatalf("historical/live accounting count=%d total=%d err=%v", count, total, err)
	}
}
