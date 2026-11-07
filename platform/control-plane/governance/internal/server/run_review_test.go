package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func reviewHTTPRequest(handler http.Handler, method, path, token, realm, user, roles, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Lumo-Realm", realm)
	r.Header.Set("X-Lumo-User", user)
	r.Header.Set("X-Lumo-Roles", roles)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestRunReviewHTTPRequiresRuntimeCredentialAndStrictInput(t *testing.T) {
	mux := http.NewServeMux()
	newTestServer(t, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, ControlPlaneToken: "review-service"}).Register(mux)
	for _, tc := range []struct {
		token, realm, body string
		want               int
	}{
		{realm: "r1", body: `{}`, want: 401},
		{token: "bad", realm: "r1", body: `{}`, want: 401},
		{token: "review-service", body: `{}`, want: 401},
		{token: "review-service", realm: "r1", body: `{"proven":true}`, want: 400},
		{token: "review-service", realm: "r1", body: `{} {}`, want: 400},
		{token: "review-service", realm: "r1", body: `{"node_id":"` + strings.Repeat("x", 16384) + `"}`, want: 400},
	} {
		w := reviewHTTPRequest(mux, http.MethodPut, "/v1/runtime/task-runs/run/prepare", tc.token, tc.realm, "forged-admin", "platform_admin", tc.body)
		if w.Code != tc.want {
			t.Fatalf("token=%q realm=%q: got %d %s", tc.token, tc.realm, w.Code, w.Body)
		}
	}
}

func TestRunReviewHTTPBindsImmutableRuntimeEvidence(t *testing.T) {
	st, pool := receiptHTTPStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE project_members(project_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
	 INSERT INTO project_members VALUES('p1','u1','editor');
	 INSERT INTO governance_agent_presets(realm,id,project_id,name,owner_user_id,status,provider,model_ref,connector_ids,knowledge_space_ids,revision,max_concurrency)
	 VALUES('r1','producer-agent','p1','Producer','worker','active','provider','model-a','[]','[]',1,2),('r1','review-agent','p1','Reviewer','worker','active','provider','model-b','[]','[]',1,2);
	 INSERT INTO governance_worker_heartbeats(realm,worker_id,node_id,instance_id,preset_revision,max_concurrency,status)
	 VALUES('r1','agent:producer-agent','node-producer','boot',1,2,'active'),('r1','agent:review-agent','node-review','boot',1,2,'active')`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"producer", "review"} {
		requester := "u1"
		if id == "review" {
			requester = "u2"
		}
		_, _, err := st.CreateDelegatedTaskWithRun(ctx, domain.DelegatedTask{ID: id, Realm: "r1", Title: id, Intent: id, ProjectID: "p1", RequesterUserID: requester, AssigneeUserID: "worker", AssigneeWorkerID: "agent:" + id + "-agent", State: "RUNNING", BusinessState: domain.BusinessExecuting}, domain.TaskRun{ID: id + "-run", WorkerID: "agent:" + id + "-agent", State: "RUNNING", AssignedNodeID: "node-" + id, SessionRef: "session-" + id, SchedulerTaskID: id + "-run"})
		if err != nil {
			t.Fatal(err)
		}
	}
	s, err := New(st, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster(), ControlPlaneToken: "review-service", SchedulerURL: "http://scheduler.invalid"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	prepare := func(id, model string) *httptest.ResponseRecorder {
		return reviewHTTPRequest(mux, http.MethodPut, "/v1/runtime/task-runs/"+id+"-run/prepare", "review-service", "r1", "", "", fmt.Sprintf(`{"node_id":"node-%s","session_ref":"session-%s","preset_revision":1,"provider":"provider","model":%q}`, id, id, model))
	}
	w := prepare("producer", "model-a")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("prepare producer: %d %s", w.Code, w.Body)
	}
	producer := domain.TaskResult{TaskID: "producer", RunID: "producer-run", State: "COMPLETED", NodeID: "node-producer", SessionRef: "session-producer", Summary: "delivery", Output: json.RawMessage(`[{"type":"text","text":"complete report"}]`)}
	raw, _ := json.Marshal(producer)
	w = reviewHTTPRequest(mux, http.MethodPut, "/v1/runtime/task-runs/producer-run/result", "review-service", "r1", "", "", string(raw))
	if w.Code != 200 {
		t.Fatalf("runtime output: %d %s", w.Code, w.Body)
	}
	createReview := func(key, worker string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/tasks/producer/runs/producer-run/review-tasks", strings.NewReader(fmt.Sprintf(`{"reviewer_worker_id":%q}`, worker)))
		r.Header.Set("X-Lumo-Realm", "r1")
		r.Header.Set("X-Lumo-User", "u1")
		r.Header.Set("X-Lumo-Roles", "manager")
		r.Header.Set("Idempotency-Key", key)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w = createReview("review:self", "agent:producer-agent")
	if w.Code != 409 {
		t.Fatalf("self review created: %d %s", w.Code, w.Body)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM governance_delegation_tasks`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("invalid review leaked task rows: %d %v", count, err)
	}
	w = createReview("review:atomic", "agent:review-agent")
	var atomic struct {
		Task domain.DelegatedTask `json:"task"`
		Run  domain.TaskRun       `json:"run"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &atomic) != nil || atomic.Run.State != domain.DelegationQueued {
		t.Fatalf("atomic review creation: %d %s", w.Code, w.Body)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM governance_run_reviews b JOIN governance_task_scheduling q ON q.run_id=b.review_run_id WHERE b.review_run_id=$1 AND b.producer_run_id='producer-run'`, atomic.Run.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("queued Run lacks committed binding: %d %v", count, err)
	}
	w = createReview("review:atomic", "agent:review-agent")
	if w.Code != 200 || !strings.Contains(w.Body.String(), atomic.Run.ID) {
		t.Fatalf("review creation replay: %d %s", w.Code, w.Body)
	}
	w = createReview("review:atomic", "agent:producer-agent")
	if w.Code != 409 {
		t.Fatalf("review creation receipt accepted changed worker: %d %s", w.Code, w.Body)
	}
	path, body := "/v1/tasks/producer/runs/producer-run/reviews", `{"review_task_id":"review","review_run_id":"review-run"}`
	w = reviewHTTPRequest(mux, http.MethodPost, path, "", "r1", "u1", "manager", body)
	if w.Code != 403 {
		t.Fatalf("review task access bypassed: %d %s", w.Code, w.Body)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,created_by) VALUES('r1','review','user','u1','contributor','u2')`); err != nil {
		t.Fatal(err)
	}
	w = reviewHTTPRequest(mux, http.MethodPost, path, "", "r1", "u1", "manager", strings.TrimSuffix(body, "}")+`,"proven":true}`)
	if w.Code != 400 {
		t.Fatalf("caller impact accepted: %d %s", w.Code, w.Body)
	}
	w = reviewHTTPRequest(mux, http.MethodPost, path, "", "r1", "u1", "manager", body)
	var bound domain.RunReviewContext
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &bound) != nil || len(bound.Manifest.Entries) != 1 || len(bound.ManifestDigest) != 64 {
		t.Fatalf("bind exact evidence: %d %s", w.Code, w.Body)
	}
	w = prepare("review", "model-b")
	var prepared domain.PreparedRunExecution
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &prepared) != nil || prepared.Review == nil || prepared.Review.ManifestDigest != bound.ManifestDigest {
		t.Fatalf("review runtime context: %d %s", w.Code, w.Body)
	}
	// The reviewer task need not reach business DONE to provide an execution
	// receipt; otherwise accepting reviews would create an infinite chain.
	review := domain.TaskResult{TaskID: "review", RunID: "review-run", State: "COMPLETED", NodeID: "node-review", SessionRef: "session-review", Summary: "approved"}
	review.Output, _ = json.Marshal([]map[string]string{{"type": "text", "text": fmt.Sprintf(`{"verdict":"approve","manifest_digest":%q}`, bound.ManifestDigest)}})
	raw, _ = json.Marshal(review)
	w = reviewHTTPRequest(mux, http.MethodPut, "/v1/runtime/task-runs/review-run/result", "review-service", "r1", "", "", string(raw))
	if w.Code != 200 {
		t.Fatalf("review runtime receipt: %d %s", w.Code, w.Body)
	}
	gate := domain.IntegrationGateFacts{ContractTestsPass: true, SmokePass: true}
	if _, err = st.TransitionBusinessTask(ctx, "r1", "producer", "submit_review", "u1", gate); err != nil {
		t.Fatal(err)
	}
	if task, err := st.TransitionBusinessTask(ctx, "r1", "producer", "complete", "u1", gate); err != nil || task.BusinessState != domain.BusinessDone {
		t.Fatalf("verified HTTP evidence did not permit acceptance: %+v %v", task, err)
	}
}
