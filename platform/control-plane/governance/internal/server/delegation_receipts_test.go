package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func receiptHTTPStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN is required")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	schema := pgx.Identifier{"receipt_http_" + hex.EncodeToString(suffix[:])}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); admin.Close() })
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = strings.Trim(schema, `"`)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	st := store.New(pool)
	if err := st.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,status) VALUES ('r1','u1','Requester','active'),('r1','u2','Other requester','active'),('r1','worker','Worker','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_user_tags(realm,user_id,tag) VALUES ('r1','worker','report')`); err != nil {
		t.Fatal(err)
	}
	return st, pool
}

func receiptHTTPHandler(t *testing.T, st *store.Store) http.Handler {
	t.Helper()
	s, err := New(st, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	return mux
}

func TestDelegationHTTPReceiptRetryConflictAndAuthority(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	handler := receiptHTTPHandler(t, st)
	body := `{"title":"Work","intent":"Produce a report","project_id":"p1","assignee_worker_id":"user:worker","auto_assign":false}`
	request := func(handler http.Handler, user, roles, key, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/delegations", strings.NewReader(body))
		r.Header.Set("X-Lumo-Realm", "r1")
		r.Header.Set("X-Lumo-User", user)
		r.Header.Set("X-Lumo-Roles", roles)
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	first := request(handler, "u1", "platform_admin", "flow:retry", body)
	if first.Code != http.StatusCreated {
		t.Fatalf("first: %d %s", first.Code, first.Body)
	}
	var original struct {
		Task domain.DelegatedTask `json:"task"`
		Run  domain.TaskRun       `json:"run"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &original); err != nil || original.Task.ID == "" || original.Run.ID == "" {
		t.Fatalf("receipt: %+v %v", original, err)
	}
	// A replay must not rematch a worker whose availability has since changed.
	if _, err := pool.Exec(context.Background(), `UPDATE governance_users SET status='suspended' WHERE id='worker'`); err != nil {
		t.Fatal(err)
	}
	replay := request(receiptHTTPHandler(t, store.New(pool)), "u1", "platform_admin", "flow:retry", body)
	if replay.Code != http.StatusOK {
		t.Fatalf("reopened retry: %d %s", replay.Code, replay.Body)
	}
	var got struct {
		Task domain.DelegatedTask `json:"task"`
		Run  domain.TaskRun       `json:"run"`
	}
	if err := json.Unmarshal(replay.Body.Bytes(), &got); err != nil || got.Task.ID != original.Task.ID || got.Run.ID != original.Run.ID {
		t.Fatalf("duplicate receipt: %+v %v", got, err)
	}
	for _, tc := range []struct {
		user, role, key, body string
		want                  int
	}{
		{"u1", "platform_admin", "flow:retry", strings.Replace(body, "a report", "a different report", 1), http.StatusConflict},
		{"u1", "viewer", "flow:retry", body, http.StatusForbidden},
		{"u1", "manager", "flow:retry", body, http.StatusForbidden},
		{"u2", "platform_admin", "flow:retry", body, http.StatusUnprocessableEntity},
		{"u1", "platform_admin", "bad key", body, http.StatusBadRequest},
	} {
		res := request(handler, tc.user, tc.role, tc.key, tc.body)
		if res.Code != tc.want {
			t.Fatalf("user=%s role=%s key=%s: %d want %d: %s", tc.user, tc.role, tc.key, res.Code, tc.want, res.Body)
		}
	}
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM governance_delegation_tasks`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("task count=%d err=%v", n, err)
	}
}

func TestDelegationHTTPConcurrentReceipts(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	handler := receiptHTTPHandler(t, st)
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest(http.MethodPost, "/v1/delegations", strings.NewReader(`{"title":"Work","intent":"Produce a report","assignee_worker_id":"user:worker","auto_assign":false}`))
			r.Header.Set("X-Lumo-Realm", "r1")
			r.Header.Set("X-Lumo-User", "u1")
			r.Header.Set("X-Lumo-Roles", "platform_admin")
			r.Header.Set("Idempotency-Key", "concurrent")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 201 && w.Code != 200 {
				t.Errorf("concurrent request: %d %s", w.Code, w.Body)
				return
			}
			var out struct {
				Task domain.DelegatedTask `json:"task"`
				Run  domain.TaskRun       `json:"run"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Error(err)
				return
			}
			ids <- out.Task.ID + "/" + out.Run.ID
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		seen[id] = true
	}
	if len(seen) != 1 {
		t.Fatalf("duplicate task/run pairs: %v", seen)
	}
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM governance_delegation_receipts`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("receipt count=%d err=%v", n, err)
	}
}
