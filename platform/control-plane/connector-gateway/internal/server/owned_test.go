package server_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
	"github.com/lumo-harness/platform/connector-gateway/internal/breaker"
	"github.com/lumo-harness/platform/connector-gateway/internal/credentials"
	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
	"github.com/lumo-harness/platform/connector-gateway/internal/gateway"
	"github.com/lumo-harness/platform/connector-gateway/internal/owned"
	"github.com/lumo-harness/platform/connector-gateway/internal/policy"
	"github.com/lumo-harness/platform/connector-gateway/internal/ratelimit"
	"github.com/lumo-harness/platform/connector-gateway/internal/server"
	"github.com/lumo-harness/platform/observability"
)

func TestOwnedConnectorExactConsentAndUnknownOutcome(t *testing.T) {
	previousMetrics := observability.Default
	observability.Default = &observability.Metrics{}
	t.Cleanup(func() { observability.Default = previousMetrics })
	var calls atomic.Int32
	var fail, revoked atomic.Bool
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"created":true}`)
	}))
	defer up.Close()
	_, pool, reg := setup(t, up.URL, domain.WebEgress{}, ratelimit.New(&fakeScripter{allow: 99}))
	ctx := context.Background()
	for _, name := range []string{"017_session_owners.sql", "027_session_execution_leases.sql"} {
		raw, err := os.ReadFile(filepath.Join("../../../../deploy/migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_owners(session_ref,realm,owner_user_id,project_id,node_id,state,creation_token_hash)VALUES('s','r','alice','p','n','active','hash');
 INSERT INTO session_execution_nodes VALUES('r','n','p','process','','hash',1,clock_timestamp()+interval '1 minute');
 INSERT INTO session_execution_leases VALUES('s','r','n','p','process',1,1,'writer',clock_timestamp()+interval '1 minute')`); err != nil {
		t.Fatal(err)
	}
	if err := reg.Upsert(ctx, domain.Connector{ID: "issues", Realm: "r", Name: "Issues", Protocol: domain.ProtocolREST, BaseURL: up.URL, Auth: domain.Auth{Kind: domain.AuthNone}, Roles: []string{"operator"}, Enabled: true, Egress: domain.Egress{AllowPrivateNetwork: true}, Operations: map[string]domain.Operation{"create": {Name: "create", Method: "POST", Path: "/create", Write: true}, "high": {Name: "high", Method: "POST", Path: "/high", Write: true, Sensitivity: "high"}}}); err != nil {
		t.Fatal(err)
	}
	gov := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer service-secret" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/auth/session" {
			if r.Header.Get("X-Lumo-Session") != "login-secret" || revoked.Load() {
				w.WriteHeader(401)
				return
			}
			io.WriteString(w, `{"principal":{"realm":"r","user_id":"alice","roles":["operator"]}}`)
			return
		}
		if r.URL.Query().Get("project_id") != "p" || r.Header.Get("X-Lumo-User") != "alice" {
			w.WriteHeader(403)
			return
		}
		io.WriteString(w, `{"decisions":[{"action":"task:delegate","allowed":true}]}`)
	}))
	defer gov.Close()
	store := owned.New(pool)
	if err := store.Init(ctx); err != nil {
		t.Fatal(err)
	}
	authority, err := owned.NewAuthority(store, gov.URL, "service-secret", []owned.Grant{{Realm: "r", ProjectID: "p", ConnectorID: "issues", Operation: "create"}, {Realm: "r", ProjectID: "p", ConnectorID: "issues", Operation: "high"}})
	if err != nil {
		t.Fatal(err)
	}
	gw := gateway.New(gateway.Options{Registry: reg, Creds: credentials.NewEnvStore("NO_"), Policy: policy.DefaultRules(), Limiter: ratelimit.New(&fakeScripter{allow: 99}), Breakers: breaker.NewGroup(breaker.DefaultConfig()), Audit: audit.NewPg(pool), Logger: discardLogger()})
	ts := httptest.NewServer(server.New(server.Options{Gateway: gw, Registry: reg, Owned: authority, Auth: testAuth{}}).Routes())
	defer ts.Close()
	call := func(action string, input map[string]any) (int, string) {
		t.Helper()
		input["project_id"] = "p"
		input["execution"] = map[string]any{"node_id": "n", "process_id": "process", "node_fence": 1, "writer_holder": "writer", "fencing_token": 1, "user_id": "forged-admin"}
		raw, _ := json.Marshal(input)
		res, body := post(t, ts, "/owned/sessions/s/"+action, string(raw), map[string]string{"X-Lumo-Login-Session": "login-secret", "X-Lumo-User": "forged-admin", "X-Lumo-Roles": "admin"})
		return res.StatusCode, body
	}
	prepare := func() owned.Receipt {
		t.Helper()
		status, body := call("prepare", map[string]any{"connector_id": "issues", "invocation": map[string]any{"operation": "create", "body": map[string]any{"title": "private business"}}})
		var value struct {
			Receipt owned.Receipt `json:"receipt"`
		}
		if status != 200 || json.Unmarshal([]byte(body), &value) != nil || value.Receipt.ID == "" {
			t.Fatalf("prepare %d %s", status, body)
		}
		return value.Receipt
	}
	decide := func(r owned.Receipt) owned.Receipt {
		t.Helper()
		status, body := call("decide", map[string]any{"receipt_id": r.ID, "digest": r.Digest, "revision": r.Revision, "approve": true})
		var value struct {
			Receipt owned.Receipt `json:"receipt"`
		}
		if status != 200 || json.Unmarshal([]byte(body), &value) != nil {
			t.Fatalf("decide %d %s", status, body)
		}
		return value.Receipt
	}
	execute := func(r owned.Receipt) (int, string) {
		return call("execute", map[string]any{"receipt_id": r.ID, "digest": r.Digest, "revision": r.Revision})
	}
	pending := prepare()
	if calls.Load() != 0 {
		t.Fatal("write before consent")
	}
	if status, _ := call("decide", map[string]any{"receipt_id": pending.ID, "digest": "forged", "revision": 1, "approve": true}); status != 409 {
		t.Fatal("forged digest accepted", status)
	}
	approved := decide(pending)
	status, body := execute(approved)
	if status != 200 || !strings.Contains(body, `"succeeded"`) || calls.Load() != 1 {
		t.Fatalf("execute %d %s calls %d", status, body, calls.Load())
	}
	if status, _ = execute(approved); status != 409 || calls.Load() != 1 {
		t.Fatal("receipt replayed", status, calls.Load())
	}
	fail.Store(true)
	unknown := decide(prepare())
	status, body = execute(unknown)
	if status != 502 || !strings.Contains(body, "connector_outcome_unknown") {
		t.Fatalf("unknown %d %s", status, body)
	}
	var outcome, payload string
	if err = pool.QueryRow(ctx, `SELECT status,payload FROM owned_connector_receipts WHERE id=$1`, unknown.ID).Scan(&outcome, &payload); err != nil || outcome != "unknown" || payload != "null" {
		t.Fatal(outcome, payload, err)
	}
	if status, _ = execute(unknown); status != 409 {
		t.Fatal("unknown replayed", status)
	}
	if status, _ = call("prepare", map[string]any{"connector_id": "issues", "invocation": map[string]any{"operation": "high"}}); status != 403 {
		t.Fatal("high write bypassed independent admin", status)
	}
	revoked.Store(true)
	if status, _ = call("list", map[string]any{}); status != 403 {
		t.Fatal("revoked login", status)
	}
	revoked.Store(false)
	if _, err = pool.Exec(ctx, `UPDATE session_execution_nodes SET expires_at=clock_timestamp()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if status, _ = call("list", map[string]any{}); status != 403 {
		t.Fatal("expired owner process", status)
	}
	metrics := httptest.NewRecorder()
	observability.Default.Write(metrics)
	if !strings.Contains(metrics.Body.String(), `lumo_business_requests_total{operation="connector_invoke",outcome="unknown"} 1`) ||
		!strings.Contains(metrics.Body.String(), `lumo_business_requests_total{operation="connector_request",outcome="unknown"} 1`) {
		t.Fatalf("actual unknown invocation was not counted: %s", metrics.Body)
	}
}
