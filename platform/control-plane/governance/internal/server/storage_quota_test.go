package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func storageQuotaRequest(handler http.Handler, method, path, realm, user, roles, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Lumo-Realm", realm)
	r.Header.Set("X-Lumo-User", user)
	r.Header.Set("X-Lumo-Roles", roles)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func requireStorageQuotaHTTPError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != status || body.Error != code {
		t.Fatalf("response = %d %s, want %d %s (decode: %v)", w.Code, w.Body, status, code, err)
	}
}

func storageQuotaHTTPStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	st, pool := receiptHTTPStore(t)
	if _, err := pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','realm_admin','Admin','active');
 INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','realm_admin','u1')`); err != nil {
		t.Fatal(err)
	}
	return st, pool
}

func storageQuotaHTTPState(t *testing.T, w *httptest.ResponseRecorder) store.StorageQuota {
	t.Helper()
	var body struct {
		Quota                store.StorageQuota `json:"quota"`
		Accounting           string             `json:"accounting"`
		Coverage             []string           `json:"coverage"`
		Excluded             []string           `json:"excluded"`
		PhysicalGCAuthorized *bool              `json:"physical_gc_authorized"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 {
		t.Fatalf("quota response = %d %s (decode: %v)", w.Code, w.Body, err)
	}
	if w.Header().Get("Cache-Control") != "no-store" || body.Accounting != "retained-logical-reference-bytes" ||
		!reflect.DeepEqual(body.Coverage, []string{"session-attachment", "run-file", "task-artifact", "knowledge-file"}) ||
		!reflect.DeepEqual(body.Excluded, []string{"session-log", "spill", "backup", "unregistered-legacy-content"}) ||
		body.PhysicalGCAuthorized == nil || *body.PhysicalGCAuthorized {
		t.Fatalf("missing quota accounting/privacy contract: headers=%v body=%s", w.Header(), w.Body)
	}
	return body.Quota
}

func TestStorageQuotaHTTPGateIdentityAndMethods(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			for _, tc := range []struct {
				name, realm, user, roles, code string
				cfg                            Config
				status                         int
			}{
				{"local", "r1", "u1", "realm_admin", domain.ErrClusterOnly.Error(), Config{DeploymentMode: domain.ModeLocal}, 403},
				{"degraded", "r1", "u1", "realm_admin", domain.ErrClusterNotReady.Error(), Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: &mutableHealth{}}, 503},
				{"missing-user", "r1", "", "realm_admin", "missing_identity", Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, 401},
				{"missing-realm", "", "u1", "realm_admin", "missing_identity", Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, 401},
				{"viewer", "r1", "u1", "viewer", "forbidden", Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, 403},
				{"inherited-admin-header", "r1", "u1", "custom", "forbidden", Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, 403},
			} {
				t.Run(tc.name, func(t *testing.T) {
					mux := http.NewServeMux()
					newTestServer(t, tc.cfg).Register(mux)
					w := storageQuotaRequest(mux, method, "/v1/storage/quota", tc.realm, tc.user, tc.roles, `{"expected_revision":1,"limit_bytes":0}`)
					requireStorageQuotaHTTPError(t, w, tc.status, tc.code)
					if (w.Header().Get("Retry-After") != "") != (tc.status == 503) {
						t.Fatalf("incorrect retry semantics: %v", w.Header())
					}
				})
			}
		})
	}
	handler := receiptHTTPHandler(t, nil)
	w := storageQuotaRequest(handler, http.MethodPost, "/v1/storage/quota", "r1", "u1", "realm_admin", `{}`)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unregistered mutation accepted: %d %s", w.Code, w.Body)
	}
}

func TestStorageQuotaHTTPReadsIsolateScopeAndRequireCurrentAdmin(t *testing.T) {
	st, pool := storageQuotaHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO platform_storage_charges(realm,kind,reference_id,project_id,bytes,released_at) VALUES
 ('r1','run-file','file-1','p1',11,NULL),('r1','knowledge-file','file-2','p2',7,NULL),
 ('r1','run-file','released-file','p1',100,now()),('r2','run-file','foreign-file','p1',999,NULL)`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	for _, tc := range []struct {
		path, scope, project string
		used                 int64
		byKind               map[string]int64
	}{
		{"/v1/storage/quota", "realm", "", 18, map[string]int64{"run-file": 11, "knowledge-file": 7}},
		{"/v1/storage/quota?project_id=p1", "project", "p1", 11, map[string]int64{"run-file": 11}},
		{"/v1/storage/quota?project_id=p2", "project", "p2", 7, map[string]int64{"knowledge-file": 7}},
	} {
		state := storageQuotaHTTPState(t, storageQuotaRequest(handler, "GET", tc.path, "r1", "u1", "realm_admin", ""))
		if state.Scope != tc.scope || state.ProjectID != tc.project || state.Revision != 1 || state.LimitBytes != nil || state.UsedBytes != tc.used || !reflect.DeepEqual(state.ByKind, tc.byKind) {
			t.Fatalf("incorrect scoped logical usage for %s: %+v", tc.path, state)
		}
	}
	for _, method := range []string{"GET", "PUT"} {
		for _, identity := range []struct{ realm, user string }{{"r1", "u2"}, {"r2", "u1"}} {
			w := storageQuotaRequest(handler, method, "/v1/storage/quota?project_id=p1", identity.realm, identity.user, "realm_admin", `{"expected_revision":1,"limit_bytes":0}`)
			requireStorageQuotaHTTPError(t, w, 403, "forbidden")
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='r1' AND user_id='u1'`); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT"} {
		w := storageQuotaRequest(handler, method, "/v1/storage/quota?project_id=p1", "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":0}`)
		requireStorageQuotaHTTPError(t, w, 403, "forbidden")
	}
	var revision, events int64
	if err := pool.QueryRow(ctx, `SELECT revision,(SELECT count(*) FROM governance_auth_security_events WHERE event='storage_quota_updated') FROM platform_storage_limits WHERE realm='r1' AND scope='project' AND scope_id='p1'`).Scan(&revision, &events); err != nil || revision != 1 || events != 0 {
		t.Fatalf("denied quota writes changed state: revision=%d events=%d err=%v", revision, events, err)
	}
}

func TestStorageQuotaHTTPValidatesPutEnvelopeAndCAS(t *testing.T) {
	st, pool := storageQuotaHTTPStore(t)
	handler := receiptHTTPHandler(t, st)
	path := "/v1/storage/quota?project_id=p1"
	initial := storageQuotaHTTPState(t, storageQuotaRequest(handler, "GET", path, "r1", "u1", "realm_admin", ""))
	for _, body := range []string{
		`{}`, `{"limit_bytes":0}`, `{"expected_revision":null,"limit_bytes":0}`,
		`{"expected_revision":0,"limit_bytes":0}`, `{"expected_revision":-1,"limit_bytes":0}`,
		`{"expected_revision":1.5,"limit_bytes":0}`, `{"expected_revision":"1","limit_bytes":0}`,
		`{"expected_revision":9007199254740992,"limit_bytes":0}`,
		`{"expected_revision":9223372036854775808,"limit_bytes":0}`, `{"expected_revision":1}`,
		`{"expected_revision":1,"limit_bytes":-1}`, `{"expected_revision":1,"limit_bytes":1.5}`,
		`{"expected_revision":1,"limit_bytes":"0"}`, `{"expected_revision":1,"limit_bytes":false}`,
		`{"expected_revision":1,"limit_bytes":[]}`, `{"expected_revision":1,"limit_bytes":{}}`,
		`{"expected_revision":1,"limit_bytes":9007199254740992}`,
		`{"expected_revision":1,"limit_bytes":9223372036854775808}`,
		`{"expected_revision":1,"limit_bytes":0,"actor":"u2"}`,
		`{"expected_revision":1,"limit_bytes":0} {}`, `{"expected_revision":1,"limit_bytes":0} trailing`,
		`{"expected_revision":1,"limit_bytes":`,
	} {
		t.Run(body, func(t *testing.T) {
			w := storageQuotaRequest(handler, "PUT", path, "r1", "u1", "realm_admin", body)
			requireStorageQuotaHTTPError(t, w, 400, "bad_request")
		})
	}
	for _, query := range []string{"?unexpected=p1", "?project_id=p1&project_id=p2", "?project_id=%20p1", "?project_id=p1%20", "?project_id=%ZZ", "?project_id=p1;unexpected=true", "?project_id=" + strings.Repeat("p", 257)} {
		for _, method := range []string{"GET", "PUT"} {
			w := storageQuotaRequest(handler, method, "/v1/storage/quota"+query, "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":0}`)
			requireStorageQuotaHTTPError(t, w, 400, "bad_request")
		}
	}
	w := storageQuotaRequest(handler, "PUT", path, "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":0}`+strings.Repeat(" ", 64<<10))
	requireStorageQuotaHTTPError(t, w, 400, "bad_request")
	state := storageQuotaHTTPState(t, storageQuotaRequest(handler, "GET", path, "r1", "u1", "realm_admin", ""))
	if !reflect.DeepEqual(state, initial) {
		t.Fatalf("invalid input changed quota: before=%+v after=%+v", initial, state)
	}
	state = storageQuotaHTTPState(t, storageQuotaRequest(handler, "PUT", path, "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":0}`))
	if state.Revision != 2 || state.LimitBytes == nil || *state.LimitBytes != 0 {
		t.Fatalf("zero limit was not committed: %+v", state)
	}
	requireStorageQuotaHTTPError(t, storageQuotaRequest(handler, "PUT", path, "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":null}`), 409, "conflict")
	state = storageQuotaHTTPState(t, storageQuotaRequest(handler, "GET", path, "r1", "u1", "realm_admin", ""))
	if state.Revision != 2 || state.LimitBytes == nil || *state.LimitBytes != 0 {
		t.Fatalf("stale revision changed the limit: %+v", state)
	}
	state = storageQuotaHTTPState(t, storageQuotaRequest(handler, "PUT", path, "r1", "u1", "realm_admin", `{"expected_revision":2,"limit_bytes":null}`))
	if state.Revision != 3 || state.LimitBytes != nil {
		t.Fatalf("explicit null did not remove the limit: %+v", state)
	}
	realm := storageQuotaHTTPState(t, storageQuotaRequest(handler, "PUT", "/v1/storage/quota", "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":1024}`))
	if realm.Scope != "realm" || realm.ProjectID != "" || realm.Revision != 2 || realm.LimitBytes == nil || *realm.LimitBytes != 1024 {
		t.Fatalf("realm limit updated wrong scope: %+v", realm)
	}
	var events int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM governance_auth_security_events WHERE realm='r1' AND user_id='u1' AND event='storage_quota_updated' AND detail->>'actor'='u1'`).Scan(&events); err != nil || events != 3 {
		t.Fatalf("successful writes must produce exactly one audit each: events=%d err=%v", events, err)
	}
}

func TestStorageQuotaHTTPStoreFailureReturnsBoundedError(t *testing.T) {
	st, pool := storageQuotaHTTPStore(t)
	handler := receiptHTTPHandler(t, st)
	pool.Close()
	for _, method := range []string{"GET", "PUT"} {
		w := storageQuotaRequest(handler, method, "/v1/storage/quota", "r1", "u1", "realm_admin", `{"expected_revision":1,"limit_bytes":0}`)
		requireStorageQuotaHTTPError(t, w, 500, "internal")
		if strings.Contains(w.Body.String(), "pool") || strings.Contains(w.Body.String(), "postgres") || strings.Contains(w.Body.String(), "closed") {
			t.Fatalf("storage failure leaked internals: %s", w.Body)
		}
	}
}
