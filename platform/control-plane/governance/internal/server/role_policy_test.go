package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func rolePolicyRequest(handler http.Handler, method, path, roles, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Lumo-Realm", "r1")
	r.Header.Set("X-Lumo-User", "u1")
	r.Header.Set("X-Lumo-Roles", roles)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func TestRolePolicyHTTPMutationsAndAdministratorBoundary(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','realm_admin','Admin','active'),('r1','custom','Custom','active'); INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','realm_admin','u1')`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	for _, tc := range []struct {
		method, path, roles, body string
		want                      int
	}{
		{"GET", "/v1/permission-actions", "viewer", "", 200},
		{"GET", "/v1/roles/custom/permissions", "viewer", "", 200},
		{"PUT", "/v1/roles/custom/parent", "realm_admin", `{"expected_revision":1,"parent_role_id":"realm_admin"}`, 200},
		{"PUT", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":2,"permissions":[{"action":"task:delegate","effect":"deny"}]}`, 200},
		{"PUT", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":2,"permissions":[]}`, 409},
		{"PUT", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":3}`, 400},
		{"PUT", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":3,"permissions":null}`, 400},
		{"PUT", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":3,"permissions":[]} {}`, 400},
		{"PUT", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":3,"permissions":[],"actor":"forged"}`, 400},
		{"PUT", "/v1/roles/custom/parent", "realm_admin", `{"expected_revision":3}`, 400},
		{"DELETE", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":3}`, 200},
		{"PUT", "/v1/roles/custom/parent", "realm_admin", `{"expected_revision":4,"parent_role_id":null}`, 200},
		// Even an allowed custom action does not confer role/organization writes.
		{"PUT", "/v1/roles/custom/permissions", "custom", `{"expected_revision":5,"permissions":[]}`, 403},
	} {
		w := rolePolicyRequest(handler, tc.method, tc.path, tc.roles, tc.body)
		if w.Code != tc.want {
			t.Fatalf("%s %s roles=%s body=%s: %d want %d: %s", tc.method, tc.path, tc.roles, tc.body, w.Code, tc.want, w.Body)
		}
	}
	if _, err := st.SetRoleParent(ctx, "r1", "custom", "realm_admin", "u1", 5); err != nil {
		t.Fatal(err)
	}
	c := caller{realm: "r1", userID: "u1", roles: map[string]bool{"custom": true}}
	s, err := New(st, Config{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := s.permissionDecision(ctx, c, actionDelegate, domain.PermissionResource{})
	if err != nil || !decision.Allowed || isRealmAdmin(c) || len(decision.RoleResolution.DirectRoles) != 1 {
		t.Fatalf("inherited task authority vs direct admin: %+v %v", decision, err)
	}
	w := rolePolicyRequest(handler, "POST", "/v1/roles", "custom", `{"id":"elevated","name":"Elevated"}`)
	if w.Code != 403 {
		t.Fatalf("inherited administrator gained organization authority: %d %s", w.Code, w.Body)
	}
	w = rolePolicyRequest(handler, "GET", "/v1/users", "custom", "")
	if w.Code != 403 {
		t.Fatalf("custom task action opened organization directory: %d %s", w.Code, w.Body)
	}
	// A stale trusted header is insufficient for new high privilege policy writes.
	if _, err := pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='r1' AND user_id='u1'`); err != nil {
		t.Fatal(err)
	}
	w = rolePolicyRequest(handler, "DELETE", "/v1/roles/custom/permissions", "realm_admin", `{"expected_revision":6}`)
	if w.Code != 403 {
		t.Fatalf("revoked actor policy write: %d %s", w.Code, w.Body)
	}
}

func TestRolePolicyExecutionUsesAuthoritativeTaskProject(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE projects(id text PRIMARY KEY,realm text,status text); CREATE TABLE project_members(project_id text,user_id text);
 INSERT INTO projects VALUES('p1','r1','active'),('foreign','r2','active'),('archived','r1','archived');
 INSERT INTO project_members VALUES('p1','u1'),('foreign','u1'),('archived','u1');
 INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','custom','Custom','active');
 INSERT INTO governance_role_permissions VALUES('r1','custom','task:execution:update','allow')`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateDelegatedTask(ctx, domain.DelegatedTask{ID: "execution-task", Realm: "r1", Title: "Work", Intent: "Work", ProjectID: "p1", RequesterUserID: "u2", AssigneeUserID: "worker", State: domain.DelegationFailed}); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	path := "/v1/tasks/execution-task/runs?project_id=forged"
	w := rolePolicyRequest(handler, "POST", path, "custom", `{"worker_id":"user:worker","state":"ASSIGNED"}`)
	if w.Code != 201 {
		t.Fatalf("custom execution allow: %d %s", w.Code, w.Body)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM project_members WHERE project_id='p1'`); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"/runs", "/runs/missing", "/runs/missing/result"} {
		method := "POST"
		if suffix == "/runs/missing" {
			method = "PATCH"
		}
		if suffix == "/runs/missing/result" {
			method = "PUT"
		}
		w = rolePolicyRequest(handler, method, "/v1/tasks/execution-task"+suffix+"?project_id=foreign", "custom", `{}`)
		if w.Code != 403 {
			t.Fatalf("nonmember execution scope %s: %d %s", suffix, w.Code, w.Body)
		}
	}
	w = rolePolicyRequest(handler, "POST", "/v1/delegations/execution-task/status?project_id=foreign", "custom", `{}`)
	if w.Code != 403 {
		t.Fatalf("legacy status scope: %d %s", w.Code, w.Body)
	}
	s, err := New(st, Config{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"operator", "realm_admin"} {
		c := caller{realm: "r1", userID: "u1", roles: map[string]bool{role: true}}
		for _, project := range []string{"foreign", "archived", "missing"} {
			decision, err := s.permissionDecision(ctx, c, actionDelegate, domain.PermissionResource{ProjectID: project})
			if err != nil || decision.Allowed {
				t.Fatalf("project boundary role=%s project=%s: %+v %v", role, project, decision, err)
			}
		}
	}
}

func TestRolePolicyOPAUsesSameFactsAndCanOnlyNarrow(t *testing.T) {
	var called atomic.Int32
	var answer atomic.Value
	answer.Store(`{"result":true}`)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		var envelope struct {
			Input struct {
				Request  domain.PermissionRequest  `json:"request"`
				Roles    domain.RoleResolution     `json:"role_facts"`
				Proposed domain.PermissionDecision `json:"proposed"`
			} `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Error(err)
		}
		if envelope.Input.Request.Actor.Realm != "r1" || !envelope.Input.Roles.Actions[actionDelegate].Allowed || !envelope.Input.Proposed.Allowed || envelope.Input.Proposed.RoleResolution == nil {
			t.Error("OPA did not receive the authoritative local role/scope facts")
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "Bearer service-token" {
			t.Error("OPA request authentication mismatch")
		}
		_, _ = w.Write([]byte(answer.Load().(string)))
	}))
	defer upstream.Close()
	s, err := New(nil, Config{PermissionPolicyURL: upstream.URL + "/v1/data/lumo/governance/allow", ControlPlaneToken: "service-token", DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := caller{realm: "r1", userID: "u1", roles: map[string]bool{"operator": true}}
	decision, err := s.permissionDecision(context.Background(), c, actionDelegate, domain.PermissionResource{})
	if err != nil || !decision.Allowed || called.Load() != 1 || decision.PolicyAdapter != "opa:postgres-role-facts" {
		t.Fatalf("OPA allow: %+v %v", decision, err)
	}
	c.roles = map[string]bool{"viewer": true}
	decision, err = s.permissionDecision(context.Background(), c, actionDelegate, domain.PermissionResource{})
	if err != nil || decision.Allowed || called.Load() != 1 {
		t.Fatalf("OPA widened local deny: %+v %v", decision, err)
	}
	c.roles = map[string]bool{"operator": true}
	answer.Store(`{"result":false}`)
	decision, err = s.permissionDecision(context.Background(), c, actionDelegate, domain.PermissionResource{})
	if err != nil || decision.Allowed {
		t.Fatalf("OPA restriction ignored: %+v %v", decision, err)
	}
	for _, raw := range []string{`{}`, `{"result":null}`, `{"result":"true"}`, `bad-json`, strings.Repeat("x", 65<<10)} {
		answer.Store(raw)
		_, err = s.permissionDecision(context.Background(), c, actionDelegate, domain.PermissionResource{})
		if !errors.Is(err, errPermissionPolicyUnavailable) {
			t.Fatalf("invalid OPA accepted: %s %v", raw[:min(20, len(raw))], err)
		}
	}
	mux := http.NewServeMux()
	s.Register(mux)
	w := rolePolicyRequest(mux, "GET", "/v1/effective-permissions", "operator", "")
	if w.Code != 503 {
		t.Fatalf("OPA errors must be 503: %d %s", w.Code, w.Body)
	}
	upstream.Close()
	w = rolePolicyRequest(mux, "GET", "/v1/effective-permissions", "operator", "")
	if w.Code != 503 {
		t.Fatalf("OPA outage must fail closed: %d %s", w.Code, w.Body)
	}
}

func TestRolePolicyOPAURLValidation(t *testing.T) {
	for _, raw := range []string{"https://user:pass@opa/v1/data/allow", "https://opa/v1/data/allow?q=x", "https://opa/v1/data/allow#fragment", "file:///v1/data/allow", "https://opa/v1/data/", "https://opa/relative"} {
		if _, err := New(nil, Config{PermissionPolicyURL: raw}, nil); err == nil {
			t.Fatalf("accepted OPA URL %s", raw)
		}
	}
}
