package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/catalog"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
	"github.com/lumo-harness/platform/scheduler/internal/election"
	"github.com/lumo-harness/platform/scheduler/internal/server"
)

func TestGovernedRunDeliveryNeverRestartsTerminalExecution(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "node", Realm: "realm", ClusterID: "cluster", Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	lease, err := st.Acquire(ctx, "leader", 30_000)
	if err != nil {
		t.Fatal(err)
	}
	task := domain.Task{TaskID: "run-1", Realm: "realm", ClusterID: "cluster", WorkerID: "agent:analyst"}
	first, err := st.PlaceTask(ctx, lease, task, "node")
	if err != nil {
		t.Fatal(err)
	}
	// Idempotency must also work when this execution occupies the last slot.
	if replay, err := st.PlaceTask(ctx, lease, task, "node"); err != nil || replay != first {
		t.Fatalf("placement replay: %#v, %v", replay, err)
	}
	if _, err := st.CompleteTaskAttempt(ctx, task.TaskID, first.Attempt, domain.StateCompleted); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if replay, err := st.PlaceTask(ctx, lease, task, "missing-node"); err != nil || replay.State != domain.StateCompleted || replay.Attempt != first.Attempt {
			t.Fatalf("terminal placement restarted: %#v, %v", replay, err)
		}
		if state, err := st.QueueTask(ctx, lease, task); err != nil || state != domain.StateCompleted {
			t.Fatalf("terminal queue restarted: %s, %v", state, err)
		}
	}
	if count := outboxCount(t, st, task.TaskID); count != 1 {
		t.Fatalf("replayed run produced %d dispatches", count)
	}
	task.WorkerID = "agent:other"
	if _, err := st.PlaceTask(ctx, lease, task, "node"); err == nil {
		t.Fatal("replay changed worker")
	}
	if _, err := st.QueueTask(ctx, lease, task); err == nil {
		t.Fatal("queued replay changed worker")
	}
	task.TaskID = "run-2"
	if next, err := st.PlaceTask(ctx, lease, task, "node"); err != nil || next.State != domain.StatePlaced || next.Attempt != 1 {
		t.Fatalf("explicit new run did not start: %#v, %v", next, err)
	}
}

func TestGovernedHTTPReplayDoesNotRequireWorkerDirectoryOrLeader(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	cat := &catalog.Pg{Pool: st.Pool()}
	if err := cat.Upsert(ctx, domain.Node{NodeID: "node", Realm: "realm", ClusterID: "cluster", Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	lease, err := st.Acquire(ctx, "leader", 30_000)
	if err != nil {
		t.Fatal(err)
	}
	task := domain.Task{TaskID: "run", Realm: "realm", ClusterID: "cluster", WorkerID: "agent:analyst", ProjectID: "project"}
	first, err := st.PlaceTask(ctx, lease, task, "node")
	if err != nil {
		t.Fatal(err)
	}
	// An empty election and nil catalog intentionally make any new placement
	// impossible. Replaying the existing execution only needs its durable row.
	handler := server.New(st, &election.State{}, nil, discardLogger()).Routes()
	for _, state := range []domain.TaskState{domain.StatePlaced, domain.StateCompleted} {
		if state.Terminal() {
			if _, err := st.CompleteTaskAttempt(ctx, task.TaskID, first.Attempt, state); err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(http.MethodPost, "/v1/placements", strings.NewReader(`{"task_id":"run","worker_id":"agent:analyst","project_id":"project"}`))
		req.Header.Set("X-Lumo-Realm", "realm")
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		var actual domain.Placement
		if err := json.Unmarshal(res.Body.Bytes(), &actual); err != nil || res.Code != http.StatusCreated || actual.State != state || actual.NodeID != "node" || actual.Attempt != first.Attempt {
			t.Fatalf("replay lost placement: HTTP %d, %s, %v", res.Code, res.Body.String(), err)
		}
	}
	for _, payload := range []string{
		`{"task_id":"run","worker_id":"agent:other","project_id":"project"}`,
		`{"task_id":"run","worker_id":"agent:analyst","project_id":"other"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/placements", strings.NewReader(payload))
		req.Header.Set("X-Lumo-Realm", "realm")
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusConflict {
			t.Fatalf("identity changed on replay: HTTP %d", res.Code)
		}
	}
	if count := outboxCount(t, st, task.TaskID); count != 1 {
		t.Fatalf("replay produced %d dispatches", count)
	}
}
