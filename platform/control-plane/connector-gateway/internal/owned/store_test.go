package owned

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

func testStore(t *testing.T) (*Store, Scope) {
	t.Helper()
	base := os.Getenv("LUMO_TEST_PG_DSN")
	if base == "" {
		t.Skip("LUMO_TEST_PG_DSN required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("owned_connector_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, name := range []string{"017_session_owners.sql", "027_session_execution_leases.sql"} {
		raw, err := os.ReadFile(filepath.Join("../../../../deploy/migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	store := New(pool)
	if err = store.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO session_owners(session_ref,realm,owner_user_id,project_id,node_id,state,creation_token_hash)VALUES('s','r','alice','p','n','active','hash');
 INSERT INTO session_execution_nodes VALUES('r','n','p','process','','hash',1,clock_timestamp()+interval '1 minute');
 INSERT INTO session_execution_leases VALUES('s','r','n','p','process',1,1,'writer',clock_timestamp()+interval '1 minute')`); err != nil {
		t.Fatal(err)
	}
	return store, Scope{Realm: "r", UserID: "alice", ProjectID: "p", SessionRef: "s", NodeID: "n", ProcessID: "process", NodeFence: 1, WriterHolder: "writer", FencingToken: 1}
}
func TestExactOneUseReceiptAndOwnerBoundaries(t *testing.T) {
	store, scope := testStore(t)
	ctx := context.Background()
	inv := domain.Invocation{ConnectorID: "billing", Operation: "write", Body: json.RawMessage(`{"amount":12}`)}
	if err := store.Authorize(ctx, scope); err != nil {
		t.Fatal(err)
	}
	receipt, err := store.Create(ctx, scope, inv, 3)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Status != "pending" || receipt.Revision != 1 {
		t.Fatal(receipt)
	}
	if _, err = store.Consume(ctx, scope, receipt.ID, receipt.Digest, 1); !errors.Is(err, ErrChanged) {
		t.Fatal("unapproved consumed", err)
	}
	for _, kind := range []string{"owner", "project", "realm", "session"} {
		bad := scope
		switch kind {
		case "owner":
			bad.UserID = "bob"
		case "project":
			bad.ProjectID = "foreign"
		case "realm":
			bad.Realm = "foreign"
		case "session":
			bad.SessionRef = "foreign"
		}
		if _, err = store.Get(ctx, bad, receipt.ID); !errors.Is(err, ErrChanged) {
			t.Fatal(kind, err)
		}
	}
	if _, err = store.Decide(ctx, scope, receipt.ID, "forged", 1, true); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
	approved, err := store.Decide(ctx, scope, receipt.ID, receipt.Digest, 1, true)
	if err != nil || approved.Revision != 2 {
		t.Fatal(approved, err)
	}
	var wg sync.WaitGroup
	wins := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.Consume(ctx, scope, receipt.ID, receipt.Digest, 2)
			wins <- err == nil
		}()
	}
	wg.Wait()
	close(wins)
	count := 0
	for won := range wins {
		if won {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("consumers %d", count)
	}
	if err = store.Complete(ctx, receipt.ID, "unknown"); err != nil {
		t.Fatal(err)
	}
	finished, err := store.Get(ctx, scope, receipt.ID)
	if err != nil || finished.Status != "unknown" || string(finished.Payload) != "null" {
		t.Fatal(finished, err)
	}
	if _, err = store.Consume(ctx, scope, receipt.ID, receipt.Digest, finished.Revision); !errors.Is(err, ErrChanged) {
		t.Fatal("unknown replay", err)
	}
}
func TestLeaseFenceAndPayloadExpiry(t *testing.T) {
	store, scope := testStore(t)
	ctx := context.Background()
	bad := scope
	bad.WriterHolder = "wrong"
	if err := store.Authorize(ctx, bad); !errors.Is(err, ErrDenied) {
		t.Fatal(err)
	}
	bad = scope
	bad.NodeFence++
	if err := store.Authorize(ctx, bad); !errors.Is(err, ErrDenied) {
		t.Fatal(err)
	}
	bad = scope
	bad.FencingToken++
	if err := store.Authorize(ctx, bad); !errors.Is(err, ErrDenied) {
		t.Fatal("stale session lease generation accepted", err)
	}
	receipt, err := store.Create(ctx, scope, domain.Invocation{ConnectorID: "x", Operation: "write", Body: json.RawMessage(`{"private":"business"}`)}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.pool.Exec(ctx, `UPDATE owned_connector_receipts SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Decide(ctx, scope, receipt.ID, receipt.Digest, 1, true); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
	if err = store.Expire(ctx); err != nil {
		t.Fatal(err)
	}
	r, err := store.Get(ctx, scope, receipt.ID)
	if err != nil || r.Status != "rejected" || string(r.Payload) != "null" {
		t.Fatal(r, err)
	}
	if _, err = store.pool.Exec(ctx, `UPDATE session_execution_nodes SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err = store.Authorize(ctx, scope); !errors.Is(err, ErrDenied) {
		t.Fatal("expired execution accepted", err)
	}
}

func waitReceiptLock(t *testing.T, ctx context.Context, tx pgx.Tx) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := tx.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		var waiting bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE pg_backend_pid()=ANY(pg_blocking_pids(a.pid)))`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("receipt mutation did not reach its held database lock")
}

func TestReceiptLockWaitRechecksExecutionAndExpiry(t *testing.T) {
	for _, action := range []string{"decide", "consume"} {
		for _, change := range []string{"node-expiry", "lease-expiry", "owner-revoked", "receipt-expiry"} {
			t.Run(action+"/"+change, func(t *testing.T) {
				store, scope := testStore(t)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				r, err := store.Create(ctx, scope, domain.Invocation{ConnectorID: "issues", Operation: "write", Body: json.RawMessage(`{"title":"exact"}`)}, 1)
				if err != nil {
					t.Fatal(err)
				}
				if action == "consume" {
					r, err = store.Decide(ctx, scope, r.ID, r.Digest, r.Revision, true)
					if err != nil {
						t.Fatal(err)
					}
				}
				tx, err := store.pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				if _, err = tx.Exec(ctx, `SELECT 1 FROM owned_connector_receipts WHERE id=$1 FOR UPDATE`, r.ID); err != nil {
					t.Fatal(err)
				}
				result := make(chan error, 1)
				go func() {
					var err error
					if action == "consume" {
						_, err = store.Consume(ctx, scope, r.ID, r.Digest, r.Revision)
					} else {
						_, err = store.Decide(ctx, scope, r.ID, r.Digest, r.Revision, true)
					}
					result <- err
				}()
				waitReceiptLock(t, ctx, tx)
				expected := ErrDenied
				switch change {
				case "node-expiry":
					_, err = tx.Exec(ctx, `UPDATE session_execution_nodes SET expires_at=clock_timestamp()-interval '1 second'`)
				case "lease-expiry":
					_, err = tx.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()-interval '1 second'`)
				case "owner-revoked":
					_, err = tx.Exec(ctx, `UPDATE session_owners SET state='failed'`)
				case "receipt-expiry":
					_, err = tx.Exec(ctx, `UPDATE owned_connector_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, r.ID)
					expected = ErrChanged
				}
				if err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if err = <-result; !errors.Is(err, expected) {
					t.Fatalf("lock wait revived %s: %v", change, err)
				}
				var status string
				if err = store.pool.QueryRow(ctx, `SELECT status FROM owned_connector_receipts WHERE id=$1`, r.ID).Scan(&status); err != nil {
					t.Fatal(err)
				}
				if status != r.Status {
					t.Fatalf("receipt changed after authority loss: %s", status)
				}
			})
		}
	}
}

func TestReceiptAdmissionIsBoundedAcrossConcurrentCalls(t *testing.T) {
	store, scope := testStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	results := make(chan Receipt, 16)
	failures := make(chan error, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := store.Create(ctx, scope, domain.Invocation{ConnectorID: "issues", Operation: "create", Body: json.RawMessage(`{"title":"bounded"}`)}, 1)
			if err != nil {
				failures <- err
			} else {
				results <- r
			}
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	if len(results) != 8 || len(failures) != 8 {
		t.Fatalf("admission allowed %d, rejected %d", len(results), len(failures))
	}
	for err := range failures {
		if !errors.Is(err, ErrDenied) {
			t.Fatal(err)
		}
	}
	first := <-results
	if _, err := store.Decide(ctx, scope, first.ID, first.Digest, first.Revision, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(ctx, scope, domain.Invocation{ConnectorID: "issues", Operation: "create", Body: json.RawMessage(`{}`)}, 1); err != nil {
		t.Fatal("reject did not release capacity", err)
	}
}

func TestReceiptCreationRechecksScopeAfterOwnerLock(t *testing.T) {
	store, scope := testStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT 1 FROM session_owners WHERE session_ref=$1 FOR UPDATE`, scope.SessionRef); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := store.Create(ctx, scope, domain.Invocation{ConnectorID: "issues", Operation: "create", Body: json.RawMessage(`{}`)}, 1)
		result <- err
	}()
	waitReceiptLock(t, ctx, tx)
	if _, err = tx.Exec(ctx, `UPDATE session_execution_leases SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, ErrDenied) {
		t.Fatal("created receipt after execution expiry", err)
	}
}
