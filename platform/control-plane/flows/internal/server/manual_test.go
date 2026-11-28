package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func TestManualRunsAreDurableAndIdempotent(t *testing.T) {
	ts, pool, seed := newTestServer(t)
	seed("p", map[string]string{"author": "owner", "other": "editor"})
	st := store.New(pool)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "manual-echo", "p", "r1", "Echo", "author", json.RawMessage(`{"nodes":[{"id":"n","operator":"echo"}],"edges":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	headers := auth("author", "r1", map[string]string{"Idempotency-Key": "manual-key"})
	var firstID string
	for i := 0; i < 2; i++ {
		response, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{"value":42}}`, headers)
		if response.StatusCode != 200 {
			t.Fatalf("run: %d %s", response.StatusCode, body)
		}
		if firstID == "" {
			firstID = response.Header.Get("X-Lumo-Flow-Run")
		}
		if firstID == "" || response.Header.Get("X-Lumo-Flow-Run") != firstID {
			t.Fatal("same key returned different run")
		}
	}
	response, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{"value":43}}`, headers)
	if response.StatusCode != 409 {
		t.Fatalf("changed input: %d %s", response.StatusCode, body)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM flow_runs WHERE flow_id=$1 AND status='succeeded'`, f.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("durable runs: %d %v", count, err)
	}
	resultURL := fmt.Sprintf("%s/v1/flows/%s/runs/%s/result", ts.URL, f.ID, firstID)
	response, body = do(t, http.MethodGet, resultURL, "", auth("author", "r1", nil))
	var result store.ManualRun
	if err := json.Unmarshal([]byte(body), &result); err != nil || response.StatusCode != 200 || result.Status != "succeeded" || len(result.Output) == 0 {
		t.Fatalf("result: %d %s %v", response.StatusCode, body, err)
	}
	response, _ = do(t, http.MethodGet, resultURL, "", auth("other", "r1", nil))
	if response.StatusCode != 404 {
		t.Fatal("another member read private manual output")
	}
	if _, err := pool.Exec(ctx, `UPDATE flow_runs SET status='running',claimed_at=0,finished_at=NULL WHERE id=$1`, result.ID); err != nil {
		t.Fatal(err)
	}
	response, body = do(t, http.MethodGet, resultURL, "", auth("author", "r1", nil))
	if err := json.Unmarshal([]byte(body), &result); err != nil || result.Status != "failed" {
		t.Fatalf("stale manual run: %s %v", body, err)
	}
	if _, err := st.EnqueueReplay(ctx, f.ID, "r1", result.ID); err != store.ErrRunNotReplayable {
		t.Fatalf("manual replay inherited automation identity: %v", err)
	}
}

func TestManualRunSurvivesDisconnectAndConcurrentRetry(t *testing.T) {
	testDSN(t)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	finish := func() { releaseOnce.Do(func() { close(release) }) }
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		_ = json.NewEncoder(w).Encode(map[string]any{"task": map[string]any{"id": "task", "realm": "r1", "project_id": "p", "requester_user_id": "author"}, "run": map[string]any{"id": "run", "realm": "r1", "task_id": "task", "worker_id": "agent:worker"}})
	}))
	defer upstream.Close()
	defer finish()
	ts, pool, seed := newTestServer(t, engine.RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "token"})
	seed("p", map[string]string{"author": "owner"})
	st := store.New(pool)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "disconnect", "p", "r1", "Disconnect", "author", json.RawMessage(`{"nodes":[{"id":"a","operator":"echo"},{"id":"n","operator":"delegation.create","config":{"projectId":"p","assigneeWorkerId":"agent:worker","intent":"analyze"}}],"edges":[{"from":"a","to":"n"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	request, _ := http.NewRequestWithContext(requestCtx, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", strings.NewReader(`{"input":{}}`))
	for key, value := range auth("author", "r1", map[string]string{"Idempotency-Key": "disconnect-key", "X-Lumo-Roles": "manager"}) {
		request.Header.Set(key, value)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, _ := http.DefaultClient.Do(request)
		if response != nil {
			response.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		finish()
		t.Fatal("operator not started")
	}
	cancel()
	<-done
	response, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{}}`, auth("author", "r1", map[string]string{"Idempotency-Key": "disconnect-key", "X-Lumo-Roles": "manager"}))
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("in-flight replay: %d %s", response.StatusCode, body)
	}
	resultURL := ts.URL + response.Header.Get("Location")
	partial := readManualResult(t, resultURL)
	if partial.Status != "running" || len(partial.Nodes) != 2 || partial.Nodes[0].Status != "succeeded" || partial.Nodes[1].Status != "running" {
		t.Fatalf("disconnected partial receipt: %+v", partial)
	}
	assertManualOutput(t, partial, "a")
	finish()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM flow_runs WHERE flow_id=$1`, f.ID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("disconnected run status=%s", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("same request executed %d times", calls.Load())
	}
	finished := readManualResult(t, resultURL)
	if finished.Status != "succeeded" || len(finished.Nodes) != 2 || finished.Nodes[1].Status != "succeeded" {
		t.Fatalf("disconnected final receipt: %+v", finished)
	}
	assertManualOutput(t, finished, "a", "n")
}

func readManualResult(t *testing.T, resultURL string) store.ManualRun {
	t.Helper()
	response, body := do(t, http.MethodGet, resultURL, "", auth("author", "r1", nil))
	var result store.ManualRun
	if err := json.Unmarshal([]byte(body), &result); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("manual result: %d %s %v", response.StatusCode, body, err)
	}
	return result
}

func assertManualOutput(t *testing.T, run store.ManualRun, ids ...string) {
	t.Helper()
	var result engine.Result
	if err := json.Unmarshal(run.Output, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Outputs) != len(ids) || len(result.Order) != len(ids) {
		t.Fatalf("partial output: %s", run.Output)
	}
	for i, id := range ids {
		if _, ok := result.Outputs[id]; !ok || result.Order[i] != id {
			t.Fatalf("missing durable output %s: %s", id, run.Output)
		}
	}
}

func TestManualRunPreservesCompletedNodesAfterFailureOrTimeout(t *testing.T) {
	for _, mode := range []string{"failure", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			testDSN(t)
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if mode == "timeout" {
					_, _ = io.Copy(io.Discard, r.Body)
					<-r.Context().Done()
					return
				}
				http.Error(w, "unavailable", http.StatusServiceUnavailable)
			}))
			defer upstream.Close()
			ts, pool, seed := newTestServer(t, engine.RuntimeConfig{LLMURL: upstream.URL, ControlToken: "token", Client: &http.Client{Timeout: 100 * time.Millisecond}})
			seed("p", map[string]string{"author": "owner"})
			st := store.New(pool)
			ctx := context.Background()
			f, err := st.CreateFlow(ctx, "partial-"+mode, "p", "r1", "Partial", "author", json.RawMessage(`{"nodes":[{"id":"a","operator":"echo"},{"id":"b","operator":"llm.answer","config":{"model":"test"}},{"id":"c","operator":"echo"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
				t.Fatal(err)
			}
			if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
				t.Fatal(err)
			}
			headers := auth("author", "r1", map[string]string{"Idempotency-Key": "partial-key", "X-Lumo-Roles": "manager"})
			response, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{"kept":42}}`, headers)
			if response.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("failed run: %d %s", response.StatusCode, body)
			}
			result := readManualResult(t, ts.URL+response.Header.Get("Location"))
			wantStatus := "failed"
			if mode == "timeout" {
				wantStatus = "unknown"
			}
			if result.Status != "failed" || len(result.Nodes) != 2 || result.Nodes[0].Status != "succeeded" || result.Nodes[1].Status != wantStatus {
				t.Fatalf("partial nodes: %+v", result)
			}
			var kept map[string]int
			if err := json.Unmarshal(result.Nodes[0].Output, &kept); err != nil || kept["kept"] != 42 || result.Nodes[0].NodeID != "a" || result.Nodes[1].Error == "" || result.Nodes[1].FinishedAt == nil {
				t.Fatalf("node receipts: %+v", result.Nodes)
			}
			assertManualOutput(t, result, "a")
			response, body = do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{"kept":42}}`, headers)
			if response.StatusCode != http.StatusUnprocessableEntity || calls.Load() != 1 {
				t.Fatalf("failed run was replayed: %d calls=%d %s", response.StatusCode, calls.Load(), body)
			}
		})
	}
}

func TestInterruptedManualRunKeepsCommittedNodesAndMarksUnknown(t *testing.T) {
	ts, pool, seed := newTestServer(t)
	seed("p", map[string]string{"author": "owner"})
	st := store.New(pool)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "interrupted", "p", "r1", "Interrupted", "author", json.RawMessage(`{"nodes":[{"id":"a","operator":"echo"},{"id":"b","operator":"echo"}],"edges":[{"from":"a","to":"b"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	run, started, err := st.StartManualRun(ctx, "r1", "author", f.ID, "key:interrupted", 1, json.RawMessage(`{}`))
	if err != nil || !started {
		t.Fatalf("start: %v", err)
	}
	if err := st.StartManualNode(ctx, run.ID, "a", "echo"); err != nil {
		t.Fatal(err)
	}
	if err := st.FinishManualNode(ctx, run.ID, "a", "succeeded", json.RawMessage(`{"confirmed":true}`), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.StartManualNode(ctx, run.ID, "b", "echo"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE flow_runs SET claimed_at=0 WHERE id=$1`, run.ID); err != nil {
		t.Fatal(err)
	}
	result := readManualResult(t, fmt.Sprintf("%s/v1/flows/%s/runs/%d/result", ts.URL, f.ID, run.ID))
	if result.Status != "failed" || len(result.Nodes) != 2 || result.Nodes[0].Status != "succeeded" || result.Nodes[1].Status != "unknown" || !strings.Contains(result.Nodes[1].Error, "inspect effects") {
		t.Fatalf("interrupted nodes: %+v", result)
	}
	assertManualOutput(t, result, "a")
	if err := st.FinishManualNode(ctx, run.ID, "b", "succeeded", json.RawMessage(`true`), nil); err != store.ErrRunFinalized {
		t.Fatalf("late receipt changed unknown outcome: %v", err)
	}
	response, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{}}`, auth("author", "r1", map[string]string{"Idempotency-Key": "interrupted"}))
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("interrupted run replayed: %d %s", response.StatusCode, body)
	}
}

func TestManualReceiptFailureStopsDependants(t *testing.T) {
	ts, pool, seed := newTestServer(t)
	seed("p", map[string]string{"author": "owner"})
	st := store.New(pool)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "receipt-failure", "p", "r1", "Receipt failure", "author", json.RawMessage(`{"nodes":[{"id":"a","operator":"echo"},{"id":"b","operator":"echo"}],"edges":[{"from":"a","to":"b"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE flow_manual_node_attempts ADD CONSTRAINT reject_receipt CHECK(status<>'succeeded')`); err != nil {
		t.Fatal(err)
	}
	response, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{"kept":42}}`, auth("author", "r1", nil))
	if response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("receipt failure: %d %s", response.StatusCode, body)
	}
	result := readManualResult(t, ts.URL+response.Header.Get("Location"))
	if result.Status != "failed" || len(result.Nodes) != 1 || result.Nodes[0].NodeID != "a" || result.Nodes[0].Status != "unknown" {
		t.Fatalf("receipt failure nodes: %+v", result)
	}
	assertManualOutput(t, result)
}
