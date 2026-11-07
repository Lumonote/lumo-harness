package integration_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The acceptance DSN also serves the live topology. Tests truncate lease and
// task tables, so they must never share the running schedulers' search path.
func TestMain(m *testing.M) {
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		os.Exit(m.Run())
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		fmt.Fprintln(os.Stderr, "scheduler tests require a PostgreSQL URL")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, "scheduler test database connection:", err)
		os.Exit(1)
	}
	schema := fmt.Sprintf("scheduler_acceptance_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	_, err = admin.Exec(ctx, "CREATE SCHEMA "+identifier)
	cancel()
	if err != nil {
		admin.Close()
		fmt.Fprintln(os.Stderr, "scheduler test schema creation:", err)
		os.Exit(1)
	}
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	_ = os.Setenv("LUMO_TEST_PG_DSN", u.String())
	code := m.Run()
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	_, err = admin.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE")
	cancel()
	admin.Close()
	if err != nil {
		fmt.Fprintln(os.Stderr, "scheduler test schema cleanup:", err)
		code = 1
	}
	os.Exit(code)
}
