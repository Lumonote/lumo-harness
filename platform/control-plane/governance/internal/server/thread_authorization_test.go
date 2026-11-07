package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestThreadAuthorizationRequiresServiceCredential(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, ControlPlaneToken: "thread-service"}).Register(mux)
	for _, token := range []string{"", "wrong-token"} {
		r := httptest.NewRequest(http.MethodPost, "/v1/runtime/tasks/task/thread-authorization", strings.NewReader(`{}`))
		r.Header.Set("X-Lumo-Realm", "r1")
		r.Header.Set("X-Lumo-User", "u1")
		r.Header.Set("X-Lumo-Roles", "platform_admin")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("token=%q: %d %s", token, w.Code, w.Body)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/runtime/tasks/task/thread-authorization", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer thread-service")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("missing realm: %d %s", w.Code, w.Body)
	}
}

func TestThreadAuthorizationHTTPUsesCurrentDatabaseFacts(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE projects(id TEXT PRIMARY KEY,realm TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO projects VALUES('p1','r1','active'),('p2','r1','active'); CREATE TABLE project_members (
		project_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,
		PRIMARY KEY(project_id,user_id));
		INSERT INTO governance_roles(realm,id,name,status) VALUES ('r1','manager','Manager','active');
		INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,project_id,requester_user_id,assignee_user_id,assignee_worker_id,state,business_state)
		VALUES ('thread-task','r1','Coordinated work','Produce a report','p1','worker','worker','user:worker','RUNNING','EXECUTING');
		INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by)
		VALUES ('r1','thread-task','user','u1','contributor','worker')`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateAgentPreset(ctx, domain.AgentPreset{
		ID: "helper", Realm: "r1", ProjectID: "p1", Name: "Thread helper", OwnerUserID: "u1",
		Status: "active", Version: "1", Provider: "bridge", ModelRef: "tiny", TimeoutSeconds: 60,
	}); err != nil {
		t.Fatal(err)
	}
	s, err := New(st, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster(), ControlPlaneToken: "thread-service"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	baseline := func() {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE governance_users SET status='active' WHERE realm='r1' AND id='u1';
			UPDATE governance_roles SET status='active' WHERE realm='r1' AND id='manager';
			DELETE FROM governance_user_roles WHERE realm='r1' AND user_id='u1';
			INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES ('r1','u1','manager','worker');
			DELETE FROM project_members WHERE user_id='u1';
			INSERT INTO project_members(project_id,user_id,role) VALUES ('p1','u1','editor');
			UPDATE governance_delegation_tasks SET project_id='p1',state='RUNNING',business_state='EXECUTING'
			WHERE realm='r1' AND id='thread-task';
			DELETE FROM governance_task_collaborators WHERE realm='r1' AND task_id='thread-task';
			INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by)
			VALUES ('r1','thread-task','user','u1','contributor','worker');
			UPDATE governance_agent_presets SET status='active',owner_user_id='u1',project_id='p1',revision=1,
			provider='bridge',model_ref='tiny',connector_ids='[]',knowledge_space_ids='[]',system_prompt_ref='',max_budget_cents=0
			WHERE realm='r1' AND id='helper'`); err != nil {
			t.Fatal(err)
		}
	}
	request := func(realm, taskID, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/runtime/tasks/"+taskID+"/thread-authorization", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer thread-service")
		r.Header.Set("X-Lumo-Realm", realm)
		// These headers deliberately disagree with the database owner and roles.
		r.Header.Set("X-Lumo-User", "forged-user")
		r.Header.Set("X-Lumo-Roles", "platform_admin")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	validBody := `{"owner_user_id":"u1","project_id":"p1","agent_id":"helper","preset_revision":1,"provider":"bridge","model":"tiny"}`
	baseline()
	assertAllowed := func() {
		t.Helper()
		w := request("r1", "thread-task", validBody)
		var response struct {
			Realm     string             `json:"realm"`
			UserID    string             `json:"user_id"`
			ProjectID string             `json:"project_id"`
			TaskID    string             `json:"task_id"`
			Preset    domain.AgentPreset `json:"preset"`
			Facts     struct {
				UserStatus string                    `json:"user_status"`
				Roles      []string                  `json:"roles"`
				TaskAccess string                    `json:"task_access"`
				Permission domain.PermissionDecision `json:"permission"`
			} `json:"current_authorization"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil {
			t.Fatalf("authorization: %d %s", w.Code, w.Body)
		}
		if response.Realm != "r1" || response.UserID != "u1" || response.ProjectID != "p1" || response.TaskID != "thread-task" ||
			response.Preset.ID != "helper" || response.Preset.Revision != 1 || response.Preset.TimeoutSeconds != 60 ||
			response.Facts.UserStatus != "active" || strings.Join(response.Facts.Roles, ",") != "manager" ||
			response.Facts.TaskAccess != "contributor" || !response.Facts.Permission.Allowed {
			t.Fatalf("wrong current facts: %+v", response)
		}
	}
	// The helper is not the assigned task worker: authorization is for a
	// coordinator's child round and must neither reassign nor create a Run.
	assertAllowed()
	for _, tc := range []struct {
		name, mutation, realm, taskID, body string
		want                                int
	}{
		{name: "suspended owner", mutation: `UPDATE governance_users SET status='suspended' WHERE id='u1'`, want: 404},
		{name: "disabled owner", mutation: `UPDATE governance_users SET status='disabled' WHERE id='u1'`, want: 404},
		{name: "role revoked", mutation: `DELETE FROM governance_user_roles WHERE user_id='u1'`, want: 403},
		{name: "role expired", mutation: `UPDATE governance_user_roles SET expires_at=now()-interval '1 second' WHERE user_id='u1'`, want: 403},
		{name: "role disabled", mutation: `UPDATE governance_roles SET status='disabled' WHERE id='manager'`, want: 403},
		{name: "project membership revoked", mutation: `DELETE FROM project_members WHERE user_id='u1'`, want: 403},
		{name: "task contributor revoked", mutation: `DELETE FROM governance_task_collaborators WHERE subject_id='u1'`, want: 403},
		{name: "task viewer only", mutation: `UPDATE governance_task_collaborators SET access='viewer' WHERE subject_id='u1'`, want: 403},
		{name: "task project changed", mutation: `UPDATE governance_delegation_tasks SET project_id='p2' WHERE id='thread-task'`, want: 403},
		{name: "preset disabled", mutation: `UPDATE governance_agent_presets SET status='disabled' WHERE id='helper'`, want: 403},
		{name: "preset owner changed", mutation: `UPDATE governance_agent_presets SET owner_user_id='u2' WHERE id='helper'`, want: 403},
		{name: "preset project changed", mutation: `UPDATE governance_agent_presets SET project_id='p2' WHERE id='helper'`, want: 403},
		{name: "global preset refused", mutation: `UPDATE governance_agent_presets SET project_id='' WHERE id='helper'`, want: 403},
		{name: "preset revision changed", mutation: `UPDATE governance_agent_presets SET revision=2 WHERE id='helper'`, want: 403},
		{name: "preset provider changed", mutation: `UPDATE governance_agent_presets SET provider='other' WHERE id='helper'`, want: 403},
		{name: "preset model changed", mutation: `UPDATE governance_agent_presets SET model_ref='other' WHERE id='helper'`, want: 403},
		{name: "connector unsupported", mutation: `UPDATE governance_agent_presets SET connector_ids='["private"]' WHERE id='helper'`, want: 422},
		{name: "knowledge unsupported", mutation: `UPDATE governance_agent_presets SET knowledge_space_ids='["private"]' WHERE id='helper'`, want: 422},
		{name: "protected prompt unsupported", mutation: `UPDATE governance_agent_presets SET system_prompt_ref='protected:prompt' WHERE id='helper'`, want: 422},
		{name: "monetary cap unsupported", mutation: `UPDATE governance_agent_presets SET max_budget_cents=1 WHERE id='helper'`, want: 422},
		{name: "completed task", mutation: `UPDATE governance_delegation_tasks SET state='COMPLETED' WHERE id='thread-task'`, want: 409},
		{name: "failed task", mutation: `UPDATE governance_delegation_tasks SET state='FAILED' WHERE id='thread-task'`, want: 409},
		{name: "cancelled task", mutation: `UPDATE governance_delegation_tasks SET state='CANCELLED' WHERE id='thread-task'`, want: 409},
		{name: "cancelling task", mutation: `UPDATE governance_delegation_tasks SET state='CANCELLING' WHERE id='thread-task'`, want: 409},
		{name: "business done", mutation: `UPDATE governance_delegation_tasks SET business_state='DONE' WHERE id='thread-task'`, want: 409},
		{name: "business rejected", mutation: `UPDATE governance_delegation_tasks SET business_state='REJECTED' WHERE id='thread-task'`, want: 409},
		{name: "business archived", mutation: `UPDATE governance_delegation_tasks SET business_state='ARCHIVED' WHERE id='thread-task'`, want: 409},
		{name: "foreign realm", realm: "r2", want: 404},
		{name: "missing task", taskID: "missing", want: 404},
		{name: "empty binding", body: `{}`, want: 400},
		{name: "invalid JSON", body: `{`, want: 400},
		{name: "roles in body", body: strings.TrimSuffix(validBody, "}") + `,"roles":["admin"]}`, want: 400},
		{name: "stale requested revision", body: strings.Replace(validBody, `"preset_revision":1`, `"preset_revision":2`, 1), want: 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			baseline()
			if tc.mutation != "" {
				if _, err := pool.Exec(ctx, tc.mutation); err != nil {
					t.Fatal(err)
				}
			}
			realm, taskID, body := tc.realm, tc.taskID, tc.body
			if realm == "" {
				realm = "r1"
			}
			if taskID == "" {
				taskID = "thread-task"
			}
			if body == "" {
				body = validBody
			}
			w := request(realm, taskID, body)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body)
			}
		})
	}
	baseline()
	assertAllowed() // Restore permissions without restarting either service.
	var runs int
	var assigned string
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_runs`).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("authorization created a TaskRun: count=%d err=%v", runs, err)
	}
	if err := pool.QueryRow(ctx, `SELECT assignee_worker_id FROM governance_delegation_tasks WHERE id='thread-task'`).Scan(&assigned); err != nil || assigned != "user:worker" {
		t.Fatalf("authorization reassigned task: worker=%q err=%v", assigned, err)
	}
}
