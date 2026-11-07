package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
)

func TestBotAuthorizationRequiresServiceCredential(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, ControlPlaneToken: "bot-service"}).Register(mux)
	for _, token := range []string{"", "wrong"} {
		r := httptest.NewRequest(http.MethodPost, "/v1/runtime/bot-authorization", strings.NewReader(`{}`))
		r.Header.Set("X-Lumo-Realm", "r1")
		r.Header.Set("X-Lumo-Roles", "platform_admin")
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("credential %q: %d %s", token, w.Code, w.Body)
		}
	}
}

func TestBotAuthorizationCurrentSenderAuthorTeamProjectAndPreset(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	definition := `{"nodes":[{"id":"delegate","operator":"delegation.create","config":{"teamId":"team1","captainSessionRef":"captain1","projectId":"p1","assigneeWorkerId":"agent:helper"}}]}`
	if _, err := pool.Exec(ctx, `CREATE TABLE projects(id TEXT PRIMARY KEY,realm TEXT,status TEXT);
		CREATE TABLE project_members(project_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(project_id,user_id));
		CREATE TABLE flows(id TEXT PRIMARY KEY,realm TEXT,project_id TEXT,author TEXT,status TEXT);
		CREATE TABLE flow_versions(flow_id TEXT,version INTEGER,definition JSONB,PRIMARY KEY(flow_id,version));
		INSERT INTO projects VALUES ('p1','r1','active');
		INSERT INTO flows VALUES ('flow1','r1','p1','u2','published');
		INSERT INTO governance_roles(realm,id,name,status) VALUES ('r1','manager','Manager','active');`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO flow_versions VALUES ('flow1',1,$1)`, definition); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateAgentPreset(ctx, domain.AgentPreset{ID: "helper", Realm: "r1", ProjectID: "p1", Name: "Helper", OwnerUserID: "worker", Status: "active", Version: "1", Provider: "bridge", ModelRef: "tiny"}); err != nil {
		t.Fatal(err)
	}
	team := botTeam{Realm: "r1", ID: "team1", Owner: "worker", Captain: "captain1", Revision: "team-rev-1"}
	teamStatus := http.StatusOK
	teamCalls := 0
	var teamMu sync.Mutex
	teamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		teamMu.Lock()
		teamCalls++
		currentTeam, currentStatus := team, teamStatus
		teamMu.Unlock()
		if r.Method != http.MethodGet || r.URL.Path != "/lumo/runtime/teams/team1" || r.Header.Get("Authorization") != "Bearer bot-service" || r.Header.Get("X-Lumo-Realm") != "r1" {
			t.Errorf("untrusted team request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.WriteHeader(currentStatus)
		_ = json.NewEncoder(w).Encode(currentTeam)
	}))
	defer teamServer.Close()
	s, err := New(st, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster(), ControlPlaneToken: "bot-service", BotTeamsURL: teamServer.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	request := func(method, path, realm, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer bot-service")
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-User", "u1")
		r.Header.Set("X-Lumo-Roles", "platform_admin")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	grantBody := `{"team_id":"team1","project_id":"p1","agent_id":"helper","capability":"delegation.create","status":"active"}`
	baseline := func() {
		t.Helper()
		teamMu.Lock()
		team = botTeam{Realm: "r1", ID: "team1", Owner: "worker", Captain: "captain1", Revision: "team-rev-1"}
		teamStatus = http.StatusOK
		teamMu.Unlock()
		if _, err := pool.Exec(ctx, `UPDATE governance_users SET status='active';
			UPDATE governance_roles SET status='active'; DELETE FROM governance_user_roles;
			INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) SELECT 'r1',id,'manager','worker' FROM governance_users WHERE realm='r1';
			DELETE FROM project_members;
			INSERT INTO project_members SELECT 'p1',id,'editor' FROM governance_users WHERE realm='r1';
			UPDATE projects SET status='active',realm='r1';
			UPDATE flows SET author='u2',project_id='p1',status='published';
			UPDATE governance_agent_presets SET status='active',project_id='p1',owner_user_id='worker',revision=1;
			DELETE FROM governance_bot_grants; DELETE FROM governance_bot_subjects;`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE flow_versions SET definition=$1`, definition); err != nil {
			t.Fatal(err)
		}
		for _, entry := range []struct{ path, body string }{
			{"/v1/bot/channels/alerts/subjects/external-u1", `{"user_id":"u1","status":"active"}`},
			{"/v1/bot/channels/alerts/subjects/external-u1/grants", grantBody},
		} {
			w := request(http.MethodPut, entry.path, "r1", entry.body)
			if w.Code != http.StatusOK {
				t.Fatalf("setup %s: %d %s", entry.path, w.Code, w.Body)
			}
		}
	}
	valid := `{"channel":"alerts","subject":"external-u1","sender_user_id":"u1","binding_revision":1,"grant_revision":1,"flow_id":"flow1","flow_version":1,"node_id":"delegate","author_user_id":"u2","project_id":"p1","team_id":"team1","captain_session_ref":"captain1","agent_id":"helper","capability":"delegation.create"}`
	assertAllowed := func() {
		t.Helper()
		w := request(http.MethodPost, "/v1/runtime/bot-authorization", "r1", valid)
		var response struct {
			UserID         string   `json:"user_id"`
			Roles          []string `json:"roles"`
			TeamRevision   string   `json:"team_revision"`
			PresetRevision int      `json:"preset_revision"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.UserID != "u1" || strings.Join(response.Roles, ",") != "manager" || response.TeamRevision != "team-rev-1" || response.PresetRevision != 1 {
			t.Fatalf("authorization: %d %s", w.Code, w.Body)
		}
	}
	baseline()
	assertAllowed()
	for _, tc := range []struct {
		name, sql, body, realm string
		mutateTeam             func()
		want                   int
	}{
		{name: "sender disabled", sql: `UPDATE governance_users SET status='disabled' WHERE id='u1'`},
		{name: "sender roles revoked", sql: `DELETE FROM governance_user_roles WHERE user_id='u1'`},
		{name: "sender role expired", sql: `UPDATE governance_user_roles SET expires_at=now()-interval '1 second' WHERE user_id='u1'`},
		{name: "author disabled", sql: `UPDATE governance_users SET status='disabled' WHERE id='u2'`},
		{name: "author roles revoked", sql: `DELETE FROM governance_user_roles WHERE user_id='u2'`},
		{name: "team owner roles revoked", sql: `DELETE FROM governance_user_roles WHERE user_id='worker'`},
		{name: "team owner disabled", sql: `UPDATE governance_users SET status='disabled' WHERE id='worker'`},
		{name: "sender membership revoked", sql: `DELETE FROM project_members WHERE user_id='u1'`},
		{name: "author membership revoked", sql: `DELETE FROM project_members WHERE user_id='u2'`},
		{name: "team owner membership revoked", sql: `DELETE FROM project_members WHERE user_id='worker'`},
		{name: "role disabled", sql: `UPDATE governance_roles SET status='disabled' WHERE id='manager'`},
		{name: "mapping revoked", sql: `UPDATE governance_bot_subjects SET status='revoked'`},
		{name: "mapping rebound", sql: `UPDATE governance_bot_subjects SET user_id='u2',revision=2`},
		{name: "mapping renewed without grant", sql: `UPDATE governance_bot_subjects SET revision=2`, body: strings.Replace(valid, `"binding_revision":1`, `"binding_revision":2`, 1)},
		{name: "mapping rebound with forged new scope", sql: `UPDATE governance_bot_subjects SET user_id='u2',revision=2`, body: strings.Replace(strings.Replace(valid, `"binding_revision":1`, `"binding_revision":2`, 1), `"sender_user_id":"u1"`, `"sender_user_id":"u2"`, 1)},
		{name: "grant revoked", sql: `UPDATE governance_bot_grants SET status='revoked'`},
		{name: "grant renewed", sql: `UPDATE governance_bot_grants SET revision=2`},
		{name: "missing grant revision", body: strings.Replace(valid, `"grant_revision":1,`, "", 1)},
		{name: "project archived", sql: `UPDATE projects SET status='archived'`},
		{name: "project realm changed", sql: `UPDATE projects SET realm='r2'`},
		{name: "Flow withdrawn", sql: `UPDATE flows SET status='draft'`},
		{name: "Flow author changed", sql: `UPDATE flows SET author='worker'`},
		{name: "reviewed team differs", sql: `UPDATE flow_versions SET definition=jsonb_set(definition,'{nodes,0,config,teamId}','"another-team"')`},
		{name: "reviewed operator differs", sql: `UPDATE flow_versions SET definition=jsonb_set(definition,'{nodes,0,operator}','"connector.call"')`},
		{name: "preset disabled", sql: `UPDATE governance_agent_presets SET status='disabled'`},
		{name: "preset owner changed", sql: `UPDATE governance_agent_presets SET owner_user_id='u1'`},
		{name: "preset project changed", sql: `UPDATE governance_agent_presets SET project_id='p2'`},
		{name: "preset revision changed", sql: `UPDATE governance_agent_presets SET revision=2`},
		{name: "team revision changed", mutateTeam: func() { team.Revision = "team-rev-2" }},
		{name: "team owner changed", mutateTeam: func() { team.Owner = "u1" }},
		{name: "captain changed", mutateTeam: func() { team.Captain = "captain2" }},
		{name: "team realm inconsistent", mutateTeam: func() { team.Realm = "r2" }},
		{name: "team source unavailable", mutateTeam: func() { teamStatus = http.StatusServiceUnavailable }},
		{name: "foreign realm", realm: "r2"},
		{name: "forged roles body", body: strings.TrimSuffix(valid, "}") + `,"roles":["platform_admin"]}`, want: 400},
		{name: "forged sender body", body: strings.Replace(valid, `"sender_user_id":"u1"`, `"sender_user_id":"worker"`, 1)},
		{name: "missing realm", realm: "missing", want: 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			baseline()
			if tc.sql != "" {
				if _, err := pool.Exec(ctx, tc.sql); err != nil {
					t.Fatal(err)
				}
			}
			if tc.mutateTeam != nil {
				teamMu.Lock()
				tc.mutateTeam()
				teamMu.Unlock()
			}
			body, realm, want := tc.body, tc.realm, tc.want
			if body == "" {
				body = valid
			}
			if realm == "" {
				realm = "r1"
			}
			if realm == "missing" {
				realm = ""
			}
			if want == 0 {
				want = http.StatusForbidden
			}
			w := request(http.MethodPost, "/v1/runtime/bot-authorization", realm, body)
			if w.Code != want {
				t.Fatalf("got %d want %d: %s", w.Code, want, w.Body)
			}
		})
	}
	baseline()
	assertAllowed()
	// Revocation stays possible even while the authoritative team service is down.
	teamMu.Lock()
	teamStatus = http.StatusServiceUnavailable
	before := teamCalls
	teamMu.Unlock()
	w := request(http.MethodPut, "/v1/bot/channels/alerts/subjects/external-u1/grants", "r1", strings.Replace(grantBody, `"active"`, `"revoked"`, 1))
	teamMu.Lock()
	after := teamCalls
	teamMu.Unlock()
	if w.Code != http.StatusOK || after != before {
		t.Fatalf("offline revoke: %d %s calls=%d", w.Code, w.Body, after-before)
	}
	grant, err := st.BotGrant(ctx, "r1", "alerts", "external-u1", "team1", "p1", "helper")
	if err != nil || grant.Status != "revoked" || grant.SubjectUserID != "u1" || grant.SubjectRevision != 1 || grant.PresetRevision != 1 {
		t.Fatalf("frozen grant: %+v %v", grant, err)
	}
	// A rebind requires an explicit grant renewal; renewal never revives the old scope.
	baseline()
	if _, err := st.UpsertBotSubject(ctx, store.BotSubject{Realm: "r1", Channel: "alerts", Subject: "external-u1", UserID: "u1", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	w = request(http.MethodPut, "/v1/bot/channels/alerts/subjects/external-u1/grants", "r1", grantBody)
	if w.Code != 200 {
		t.Fatalf("renew grant: %d %s", w.Code, w.Body)
	}
	w = request(http.MethodPost, "/v1/runtime/bot-authorization", "r1", valid)
	if w.Code != 403 {
		t.Fatalf("old scope revived: %d %s", w.Code, w.Body)
	}
	w = request(http.MethodPost, "/v1/runtime/bot-authorization", "r1", strings.Replace(strings.Replace(valid, `"binding_revision":1`, `"binding_revision":2`, 1), `"grant_revision":1`, `"grant_revision":2`, 1))
	if w.Code != 200 {
		t.Fatalf("new scope denied: %d %s", w.Code, w.Body)
	}
}
