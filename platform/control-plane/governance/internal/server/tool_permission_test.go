package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/permission"
)

const projectToolBody = `{"realm":"r1","principal":{"kind":"user","id":"u1"},"action":"project:read","resource":{"realm":"r1","kind":"dual-tool","id":"project/project_context","project_id":"p1"},"risk":"low","approval":"never"}`

func toolResponse(mux *http.ServeMux, token, user, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/v1/permissions/decide", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Lumo-Realm", "r1")
	r.Header.Set("X-Lumo-User", user)
	r.Header.Set("X-Lumo-Roles", "platform_admin") // Never a source of grants.
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestToolDecisionBoundary(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t, Config{ControlPlaneToken: "svc"}).Register(mux)
	for _, tc := range []struct {
		token, user, body string
		status            int
		code              string
	}{
		{"wrong", "u1", projectToolBody, 401, ""}, {"svc", "", projectToolBody, 401, ""},
		{"svc", "u1", projectToolBody + ` {}`, 400, ""}, {"svc", "u1", strings.Replace(projectToolBody, `"risk":`, `"roles":[],"risk":`, 1), 400, ""},
		{"svc", "u2", projectToolBody, 200, "subject_incomplete"}, {"svc", "u1", projectToolBody, 503, "policy_unavailable"},
	} {
		w := toolResponse(mux, tc.token, tc.user, tc.body)
		if w.Code != tc.status {
			t.Fatalf("status %d want %d: %s", w.Code, tc.status, w.Body)
		}
		if tc.code != "" {
			var d permission.Decision
			if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil || d.Effect != "deny" || d.ReasonCode != tc.code {
				t.Fatalf("wrong deny: %s", w.Body)
			}
		}
	}
}

func TestToolDecisionCurrentGrants(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	exec := func(sql string) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE TABLE projects(id text primary key, realm text, status text); CREATE TABLE project_members(project_id text, user_id text);
		INSERT INTO projects VALUES('p1','r1','active'); INSERT INTO project_members VALUES('p1','u1')`)
	s, err := New(st, Config{ControlPlaneToken: "svc"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	check := func(body, effect string) {
		t.Helper()
		w := toolResponse(mux, "svc", "u1", body)
		var d struct {
			permission.Decision
			ID string `json:"decision_id"`
		}
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(w.Body.Bytes(), &d) != nil || d.Effect != effect || d.ID == "" || d.Matched == nil {
			t.Fatalf("want %s: %d %s", effect, w.Code, w.Body)
		}
	}
	check(projectToolBody, "allow")
	check(strings.Replace(projectToolBody, `"never"`, `"always"`, 1), "ask")
	engineBody := strings.NewReplacer("project/project_context", "acp-engines/acp_engines_list", "project:read", "agent:engine:list").Replace(projectToolBody)
	check(engineBody, "deny")
	exec(`INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','admin','Admin','active'); INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','admin','test')`)
	check(engineBody, "allow")
	exec(`UPDATE governance_user_roles SET expires_at=now()-interval '1 second'`)
	check(engineBody, "deny")
	opa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"result": false}) }))
	defer opa.Close()
	s.cfg.PermissionPolicyURL = opa.URL
	check(projectToolBody, "deny")
	s.cfg.PermissionPolicyURL = ""
	exec(`DELETE FROM project_members`)
	check(projectToolBody, "deny")
	exec(`INSERT INTO project_members VALUES('p1','u1'); UPDATE projects SET realm='other'`)
	check(projectToolBody, "deny")
	exec(`UPDATE projects SET realm='r1'; UPDATE governance_users SET status='disabled' WHERE id='u1'`)
	check(projectToolBody, "deny")
}
