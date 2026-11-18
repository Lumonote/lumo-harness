package store

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestLeaseTTLBoundsWorkTransactions(t *testing.T) {
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("requires PostgreSQL via LUMO_TEST_PG_DSN")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	params := u.Query()
	params.Set("pool_max_conns", "2")
	params.Set("statement_timeout", "0")
	params.Set("idle_in_transaction_session_timeout", "350ms")
	u.RawQuery = params.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	st, err := NewWithLeaseTTL(ctx, u.String(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	tx, err := st.beginWork(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const timeouts = `SELECT current_setting('statement_timeout'), current_setting('idle_in_transaction_session_timeout')`
	var statement, idle string
	if err := tx.QueryRow(ctx, timeouts).Scan(&statement, &idle); err != nil {
		t.Fatal(err)
	}
	if statement != "500ms" || idle != "350ms" {
		t.Fatalf("work transaction timeouts = (%q, %q), want (500ms, 350ms)", statement, idle)
	}
	_, err = tx.Exec(ctx, `SELECT pg_sleep(5)`)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "57014" {
		t.Fatalf("expected server statement timeout, got %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.Pool().QueryRow(ctx, timeouts).Scan(&statement, &idle); err != nil {
		t.Fatal(err)
	}
	if statement != "0" || idle != "350ms" {
		t.Fatalf("connection timeouts after rollback = (%q, %q), want (0, 350ms)", statement, idle)
	}

	// A suspended client cannot call Rollback. Verify that the database still
	// releases its transaction lock so that a second connection can acquire it.
	params.Set("idle_in_transaction_session_timeout", "0")
	u.RawQuery = params.Encode()
	idleStore, err := NewWithLeaseTTL(ctx, u.String(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	defer idleStore.Close()
	victim, err := idleStore.beginWork(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = victim.Rollback(ctx) }()
	pid := int32(victim.Conn().PgConn().PID())
	if _, err := victim.Exec(ctx, `SELECT pg_advisory_xact_lock(781234569, $1)`, pid); err != nil {
		t.Fatal(err)
	}
	waitCtx, stopWait := context.WithTimeout(ctx, 3*time.Second)
	defer stopWait()
	if _, err := idleStore.Pool().Exec(waitCtx, `SELECT pg_advisory_xact_lock(781234569, $1)`, pid); err != nil {
		t.Fatalf("idle work transaction retained its lock: %v", err)
	}
}
