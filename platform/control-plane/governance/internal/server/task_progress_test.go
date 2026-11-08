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

func TestTaskProgressHTTPPermissionsAndScope(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	for _, id := range []string{"shared", "private"} {
		_, _, err := st.CreateDelegatedTaskWithRun(ctx, domain.DelegatedTask{ID: id, Realm: "r1", Title: id, Intent: id, RequesterUserID: "u1", AssigneeUserID: "worker", AssigneeWorkerID: "user:worker", State: domain.DelegationRunning, BusinessState: domain.BusinessExecuting}, domain.TaskRun{ID: id + "-run", WorkerID: "user:worker", State: domain.DelegationRunning})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by) VALUES('r1','shared','user','u2','viewer','u1')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','operator','Operator','active');
	 INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','operator','u1')`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	body := `{"run_id":"shared-run","expected_revision":0,"status":"blocked","percent":60,"summary":"Waiting for approval","next_step":"Obtain grant","blocked_reason":"Missing staging permission"}`
	request := func(method, path, user, realm, role, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-User", user)
		r.Header.Set("X-Lumo-Roles", role)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		method, path, user, realm, role string
		want                            int
	}{
		{http.MethodGet, "/v1/tasks/shared/progress", "u2", "r1", "manager", http.StatusOK},
		{http.MethodPut, "/v1/tasks/shared/progress", "u2", "r1", "manager", http.StatusForbidden},
		{http.MethodGet, "/v1/tasks/private/progress", "u2", "r1", "manager", http.StatusForbidden},
		{http.MethodGet, "/v1/tasks/shared/progress", "u1", "r2", "manager", http.StatusNotFound},
		{http.MethodPut, "/v1/tasks/shared/progress", "u1", "r1", "operator", http.StatusOK},
		{http.MethodPut, "/v1/tasks/shared/progress", "u1", "r1", "operator", http.StatusConflict},
		{http.MethodGet, "/v1/workforce/progress?scope=all", "u2", "r1", "manager", http.StatusForbidden},
		{http.MethodGet, "/v1/workforce/progress?scope=department", "u2", "r1", "manager", http.StatusForbidden},
		{http.MethodGet, "/v1/workforce/progress?scope=bad", "u1", "r1", "platform_admin", http.StatusBadRequest},
		{http.MethodGet, "/v1/workforce/progress?limit=201", "u1", "r1", "platform_admin", http.StatusBadRequest},
		{http.MethodGet, "/v1/workforce/progress?cursor=bad", "u1", "r1", "platform_admin", http.StatusBadRequest},
	} {
		got := request(tc.method, tc.path, tc.user, tc.realm, tc.role, body)
		if got.Code != tc.want {
			t.Fatalf("%s %s %s: got %d want %d: %s", tc.method, tc.path, tc.user, got.Code, tc.want, got.Body)
		}
	}
	got := request(http.MethodGet, "/v1/tasks/shared/progress", "u2", "r1", "manager", "")
	var view domain.TaskProgressView
	if json.Unmarshal(got.Body.Bytes(), &view) != nil || view.CanUpdate || view.Revision != 1 || view.Progress == nil || view.Progress.UpdatedBy != "u1" {
		t.Fatalf("read-only viewer: %s", got.Body)
	}
	var page struct {
		Items   []domain.WorkforceProgressItem  `json:"items"`
		Summary domain.WorkforceProgressSummary `json:"summary"`
		Next    string                          `json:"next_cursor"`
	}
	got = request(http.MethodGet, "/v1/workforce/progress?scope=mine", "u2", "r1", "manager", "")
	if got.Code != http.StatusOK || json.Unmarshal(got.Body.Bytes(), &page) != nil || len(page.Items) != 1 || page.Items[0].Task.ID != "shared" || page.Summary.Total != 1 || page.Summary.Blocked != 1 {
		t.Fatalf("summary leaked private task: %d %s", got.Code, got.Body)
	}
	got = request(http.MethodGet, "/v1/workforce/progress?scope=all&limit=1", "u1", "r1", "platform_admin", "")
	if got.Code != http.StatusOK || json.Unmarshal(got.Body.Bytes(), &page) != nil || page.Next == "" {
		t.Fatalf("pagination: %d %s", got.Code, got.Body)
	}
	got = request(http.MethodGet, "/v1/workforce/progress?scope=mine&limit=1&cursor="+url.QueryEscape(page.Next), "u1", "r1", "platform_admin", "")
	if got.Code != http.StatusBadRequest {
		t.Fatalf("cursor crossed scope: %d %s", got.Code, got.Body)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM governance_task_collaborators WHERE task_id='shared'`); err != nil {
		t.Fatal(err)
	}
	got = request(http.MethodGet, "/v1/workforce/progress?scope=mine", "u2", "r1", "manager", "")
	if got.Code != http.StatusOK || json.Unmarshal(got.Body.Bytes(), &page) != nil || len(page.Items) != 0 || page.Summary.Total != 0 {
		t.Fatalf("revoked access remained: %d %s", got.Code, got.Body)
	}
}

func TestTaskProgressHTTPRequiresExecutionUpdatePermission(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	_, _, err := st.CreateDelegatedTaskWithRun(ctx, domain.DelegatedTask{ID: "task", Realm: "r1", Title: "Task", Intent: "Report progress", RequesterUserID: "u1", AssigneeUserID: "worker", AssigneeWorkerID: "user:worker", State: domain.DelegationRunning, BusinessState: domain.BusinessExecuting}, domain.TaskRun{ID: "run", WorkerID: "user:worker", State: domain.DelegationRunning})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','manager','Manager','active');
	 INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','manager','u1')`); err != nil {
		t.Fatal(err)
	}
	handler := receiptHTTPHandler(t, st)
	request := func(method, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/v1/tasks/task/progress", strings.NewReader(body))
		r.Header.Set("X-Lumo-Realm", "r1")
		r.Header.Set("X-Lumo-User", "u1")
		r.Header.Set("X-Lumo-Roles", "manager")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	canUpdate := func(want bool) {
		t.Helper()
		response := request(http.MethodGet, "")
		var view domain.TaskProgressView
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &view) != nil || view.CanUpdate != want {
			t.Fatalf("can_update want %v: %d %s", want, response.Code, response.Body)
		}
	}
	body := `{"run_id":"run","expected_revision":0,"status":"on_track","percent":30,"summary":"Draft ready","next_step":"Review draft"}`
	canUpdate(false)
	if got := request(http.MethodPut, body); got.Code != http.StatusForbidden {
		t.Fatalf("manager without execution update wrote progress: %d %s", got.Code, got.Body)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO governance_role_permissions(realm,role_id,action,effect) VALUES('r1','manager','task:execution:update','allow')`); err != nil {
		t.Fatal(err)
	}
	canUpdate(true)
	if got := request(http.MethodPut, body); got.Code != http.StatusOK {
		t.Fatalf("explicit execution update grant refused: %d %s", got.Code, got.Body)
	}
	if _, err = pool.Exec(ctx, `UPDATE governance_role_permissions SET effect='deny' WHERE realm='r1' AND role_id='manager' AND action='task:execution:update'`); err != nil {
		t.Fatal(err)
	}
	canUpdate(false)
	if got := request(http.MethodPut, strings.Replace(body, `"expected_revision":0`, `"expected_revision":1`, 1)); got.Code != http.StatusForbidden {
		t.Fatalf("execution update deny ignored: %d %s", got.Code, got.Body)
	}
	if _, err = pool.Exec(ctx, `UPDATE governance_role_permissions SET effect='allow' WHERE realm='r1' AND role_id='manager' AND action='task:execution:update';
	 DELETE FROM governance_user_roles WHERE realm='r1' AND user_id='u1'`); err != nil {
		t.Fatal(err)
	}
	// The request still carries manager, but current grants have been revoked.
	canUpdate(false)
	if got := request(http.MethodPut, strings.Replace(body, `"expected_revision":0`, `"expected_revision":1`, 1)); got.Code != http.StatusForbidden {
		t.Fatalf("stale role header retained write authority: %d %s", got.Code, got.Body)
	}
}

func TestProgressRoutesRequireClusterAndIdentity(t *testing.T) {
	for _, mode := range []domain.DeploymentMode{domain.ModeLocal, domain.ModeCluster} {
		api := newTestServer(t, Config{DeploymentMode: mode, ClusterStatus: "ready"})
		mux := http.NewServeMux()
		api.Register(mux)
		for _, route := range []struct{ method, path string }{{http.MethodGet, "/v1/workforce/progress"}, {http.MethodGet, "/v1/tasks/task/progress"}, {http.MethodPut, "/v1/tasks/task/progress"}} {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
			want := http.StatusForbidden
			if mode == domain.ModeCluster {
				want = http.StatusUnauthorized
			}
			if w.Code != want {
				t.Fatalf("%s %s: got %d want %d", mode, route.path, w.Code, want)
			}
		}
	}
}
