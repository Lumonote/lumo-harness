package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestDelegationHTTPPagesValidateAndReauthorize(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	if _, err := pool.Exec(context.Background(), `INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,requester_user_id,assignee_user_id,state,created_at)
		SELECT 'http-page-'||lpad(n::text,3,'0'),'r1','Work','Work','u1','worker','QUEUED',
		'2026-01-01T00:00:00Z' FROM generate_series(1,205) n`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	request := func(path, user, role string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("X-Lumo-Realm", "r1")
		r.Header.Set("X-Lumo-User", user)
		r.Header.Set("X-Lumo-Roles", role)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	var page struct {
		Tasks []domain.DelegatedTask `json:"tasks"`
		Next  string                 `json:"next_cursor"`
	}
	first := request("/v1/delegations?limit=200&cursor=", "u1", "platform_admin")
	if first.Code != http.StatusOK || json.Unmarshal(first.Body.Bytes(), &page) != nil || len(page.Tasks) != 200 || page.Next == "" {
		t.Fatalf("first page: %d %s", first.Code, first.Body)
	}
	secondPath := "/v1/delegations?limit=200&cursor=" + url.QueryEscape(page.Next)
	seen := map[string]bool{}
	for _, task := range page.Tasks {
		seen[task.ID] = true
	}
	second := request(secondPath, "u1", "platform_admin")
	if second.Code != http.StatusOK || json.Unmarshal(second.Body.Bytes(), &page) != nil || len(page.Tasks) != 5 || page.Next != "" {
		t.Fatalf("second page: %d %s", second.Code, second.Body)
	}
	for _, task := range page.Tasks {
		if seen[task.ID] {
			t.Fatalf("duplicate across pages: %s", task.ID)
		}
	}
	for _, tc := range []struct {
		path, user, role string
		want             int
	}{
		{secondPath, "u1", "viewer", http.StatusForbidden},
		{secondPath, "u2", "platform_admin", http.StatusBadRequest},
		{"/v1/delegations?limit=0", "u1", "platform_admin", http.StatusBadRequest},
		{"/v1/delegations?limit=-1", "u1", "platform_admin", http.StatusBadRequest},
		{"/v1/delegations?limit=201", "u1", "platform_admin", http.StatusBadRequest},
		{"/v1/delegations?limit=wrong", "u1", "platform_admin", http.StatusBadRequest},
		{"/v1/delegations?cursor=wrong", "u1", "platform_admin", http.StatusBadRequest},
	} {
		got := request(tc.path, tc.user, tc.role)
		if got.Code != tc.want {
			t.Fatalf("%s user=%s role=%s: %d want %d: %s", tc.path, tc.user, tc.role, got.Code, tc.want, got.Body)
		}
	}
}

func TestDelegationHTTPDetailMatchesInheritedAndViewerAccess(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	// Membership is owned by Projects; only its public table shape is needed
	// here to prove task grants cannot bypass the project permission boundary.
	if _, err := pool.Exec(ctx, `CREATE TABLE projects(id TEXT PRIMARY KEY,realm TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO projects VALUES('p1','r1','active'),('p2','r1','active'); CREATE TABLE project_members (
		project_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,
		added_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(project_id,user_id));
		INSERT INTO project_members(project_id,user_id,role) VALUES
		('p1','u1','owner'),('p1','worker','editor'),('p1','u2','viewer');
		INSERT INTO governance_delegation_tasks
		(id,realm,title,intent,project_id,requester_user_id,assignee_user_id,state,intent_contract)
		VALUES
		('detail-root','r1','Root','Work','p1','u1','worker','QUEUED',NULL),
		('detail-child','r1','Child','Work','p1','other','other','QUEUED','{"parent_task_id":"detail-root"}'),
		('detail-grandchild','r1','Grandchild','Work','p1','other','other','QUEUED','{"parent_task_id":"detail-child"}'),
		('detail-shared','r1','Shared','Work','p1','other','other','QUEUED',NULL),
		('detail-project-denied','r1','No membership','Work','p2','other','other','QUEUED','{"parent_task_id":"detail-root"}');
		INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by)
		VALUES ('r1','detail-shared','user','u2','viewer','other')`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	request := func(method, path, user, realm, role string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(`{"event":"start"}`))
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-User", user)
		r.Header.Set("X-Lumo-Roles", role)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, user := range []string{"u1", "worker"} {
		for _, id := range []string{"detail-child", "detail-grandchild"} {
			got := request(http.MethodGet, "/v1/delegations/"+id, user, "r1", "manager")
			var task domain.DelegatedTask
			if got.Code != http.StatusOK || json.Unmarshal(got.Body.Bytes(), &task) != nil || task.ID != id {
				t.Fatalf("ancestor participant %s reading %s: %d %s", user, id, got.Code, got.Body)
			}
		}
		got := request(http.MethodGet, "/v1/delegations/detail-project-denied", user, "r1", "manager")
		if got.Code != http.StatusForbidden {
			t.Fatalf("ancestor participant %s bypassed project membership: %d %s", user, got.Code, got.Body)
		}
	}
	for _, tc := range []struct {
		method, path, user, realm, role string
		want                            int
	}{
		{http.MethodGet, "/v1/delegations/detail-shared", "u2", "r1", "manager", http.StatusOK},
		{http.MethodPost, "/v1/delegations/detail-shared/cancel", "u2", "r1", "manager", http.StatusForbidden},
		{http.MethodPost, "/v1/tasks/detail-shared/transition", "u2", "r1", "manager", http.StatusForbidden},
		{http.MethodGet, "/v1/delegations/detail-shared", "u2", "r2", "manager", http.StatusNotFound},
		{http.MethodGet, "/v1/delegations/detail-shared", "u2", "r1", "viewer", http.StatusForbidden},
		{http.MethodGet, "/v1/delegations/detail-shared", "u1", "r1", "manager", http.StatusNotFound},
	} {
		got := request(tc.method, tc.path, tc.user, tc.realm, tc.role)
		if got.Code != tc.want {
			t.Fatalf("%s %s user=%s realm=%s role=%s: %d want %d: %s", tc.method, tc.path, tc.user, tc.realm, tc.role, got.Code, tc.want, got.Body)
		}
	}
	if _, err := pool.Exec(ctx, `DELETE FROM project_members WHERE user_id='u2'`); err != nil {
		t.Fatal(err)
	}
	got := request(http.MethodGet, "/v1/delegations/detail-shared", "u2", "r1", "manager")
	if got.Code != http.StatusForbidden {
		t.Fatalf("explicit viewer bypassed revoked project membership: %d %s", got.Code, got.Body)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_members(project_id,user_id,role) VALUES ('p1','u2','viewer');
		DELETE FROM governance_task_collaborators WHERE task_id='detail-shared';
		UPDATE governance_delegation_tasks SET requester_user_id='other',assignee_user_id='other' WHERE id='detail-root'`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ id, user string }{
		{"detail-shared", "u2"}, {"detail-child", "u1"}, {"detail-grandchild", "u1"}, {"detail-child", "worker"}, {"detail-grandchild", "worker"},
	} {
		got := request(http.MethodGet, "/v1/delegations/"+tc.id, tc.user, "r1", "manager")
		if got.Code != http.StatusNotFound {
			t.Fatalf("revoked task access survives for %s on %s: %d %s", tc.user, tc.id, got.Code, got.Body)
		}
	}
}
