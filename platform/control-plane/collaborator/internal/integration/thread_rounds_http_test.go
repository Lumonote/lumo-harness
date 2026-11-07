package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/server"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

type threadRoundHTTPAuth struct{}

func (threadRoundHTTPAuth) Authenticate(r *http.Request) (server.Identity, error) {
	if r.Header.Get("X-Lumo-Realm") == "" || r.Header.Get("X-Lumo-User") == "" {
		return server.Identity{}, errors.New("missing trusted identity")
	}
	return server.Identity{UserID: r.Header.Get("X-Lumo-User"), Realm: domain.RealmID(r.Header.Get("X-Lumo-Realm"))}, nil
}

func roundHTTPRequest(handler http.Handler, method, path, realm, user string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("X-Lumo-Realm", realm)
	r.Header.Set("X-Lumo-User", user)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func roundHTTPBody(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func roundHTTPAdmission(thread domain.Thread, runID string, attempt int) map[string]any {
	return map[string]any{
		"node_id": thread.NodeID, "coordinator_session_ref": thread.CoordinatorSessionRef,
		"task_id": thread.TaskID, "attempt": attempt, "request_hash": strings.Repeat("a", 64), "run_id": runID,
		"owner_user_id": "owner", "agent_id": "agent", "preset_revision": 1, "max_concurrency": 2, "provider": "provider", "model": "model",
	}
}

func roundHTTPStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("HTTP %d, want %d: %s", response.Code, want, response.Body)
	}
}

func TestThreadRoundHTTPAuthStrictRequestsAndOwnership(t *testing.T) {
	st, _ := newPGStore(t)
	thread, err := st.CreateThread(context.Background(), threadRow("round-http-auth", "round-http-session", "node-1"))
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(nil, st, nil, threadRoundHTTPAuth{}, slog.Default()).Routes()
	path := "/threads/" + thread.ID + "/rounds"
	valid := roundHTTPAdmission(thread, "run-1", 1)
	validRaw := roundHTTPBody(t, valid)
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, path}, {http.MethodGet, path + "/run-1"}, {http.MethodPost, path + "/run-1/finish"},
	} {
		for _, missing := range []string{"realm", "user"} {
			realm, user := thread.Realm, "owner"
			if missing == "realm" {
				realm = ""
			} else {
				user = ""
			}
			roundHTTPStatus(t, roundHTTPRequest(handler, route.method, route.path, realm, user, validRaw), http.StatusUnauthorized)
		}
	}
	roundHTTPStatus(t, roundHTTPRequest(handler, http.MethodPost, path, thread.Realm, "other-owner", validRaw), http.StatusForbidden)
	roundHTTPStatus(t, roundHTTPRequest(handler, http.MethodPost, path, "other-realm", "owner", validRaw), http.StatusNotFound)
	for _, invalid := range [][]byte{
		[]byte(`{"unknown":true}`),
		append(append([]byte{}, validRaw...), []byte(` {"extra":true}`)...),
		[]byte(`{"owner_user_id":"owner","summary":"` + strings.Repeat("x", 100*1024) + `"}`),
		[]byte(`{"owner_user_id":"owner","realm":"another-realm"}`),
		[]byte(`{"owner_user_id":"owner","attempt":1.5}`),
	} {
		roundHTTPStatus(t, roundHTTPRequest(handler, http.MethodPost, path, thread.Realm, "owner", invalid), http.StatusBadRequest)
	}
	admitted := roundHTTPRequest(handler, http.MethodPost, path, thread.Realm, "owner", validRaw)
	roundHTTPStatus(t, admitted, http.StatusCreated)
	var admission struct {
		Admitted bool                     `json:"admitted"`
		Token    string                   `json:"token"`
		Receipt  store.ThreadRoundReceipt `json:"receipt"`
	}
	if err := json.Unmarshal(admitted.Body.Bytes(), &admission); err != nil || !admission.Admitted || len(admission.Token) != 64 || admission.Receipt.SessionMode != "create" {
		t.Fatalf("new admission response: %s, %v", admitted.Body, err)
	}
	if admitted.Header().Get("Cache-Control") != "no-store" || strings.Count(admitted.Body.String(), `"token"`) != 1 {
		t.Fatal("admission must disclose its token only once and forbid caching")
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, path + "/run-1"}, {http.MethodPost, path + "/run-1/finish"},
	} {
		body := roundHTTPBody(t, map[string]any{"token": admission.Token, "state": "completed", "summary": "deliverable"})
		roundHTTPStatus(t, roundHTTPRequest(handler, route.method, route.path, thread.Realm, "other-owner", body), http.StatusNotFound)
		roundHTTPStatus(t, roundHTTPRequest(handler, route.method, route.path, "other-realm", "owner", body), http.StatusNotFound)
	}
	finishPath := path + "/run-1/finish"
	for _, invalid := range [][]byte{
		[]byte(`{"unknown":true}`),
		[]byte(`{"token":"` + admission.Token + `","state":"completed","summary":"` + strings.Repeat("x", 100*1024) + `"}`),
		[]byte(`{"token":"` + admission.Token + `","state":"completed","summary":"ok"} {}`),
	} {
		roundHTTPStatus(t, roundHTTPRequest(handler, http.MethodPost, finishPath, thread.Realm, "owner", invalid), http.StatusBadRequest)
	}
	read := roundHTTPRequest(handler, http.MethodGet, path+"/run-1", thread.Realm, "owner", nil)
	roundHTTPStatus(t, read, http.StatusOK)
	if strings.Contains(read.Body.String(), "token") || read.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("read disclosed the token or allowed caching")
	}
}

func TestThreadRoundHTTPConcurrentAdmissionRestartAndFinish(t *testing.T) {
	st, pool := newPGStore(t)
	ctx := context.Background()
	thread, err := st.CreateThread(ctx, threadRow("round-http-race", "round-http-race-session", "node-1"))
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(nil, st, nil, threadRoundHTTPAuth{}, slog.Default()).Routes()
	path := "/threads/" + thread.ID + "/rounds"
	body := roundHTTPBody(t, roundHTTPAdmission(thread, "run-7", 7))
	const n = 10
	responses := make(chan *httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			responses <- roundHTTPRequest(handler, http.MethodPost, path, thread.Realm, "owner", body)
		}()
	}
	wg.Wait()
	close(responses)
	winners := 0
	token := ""
	for response := range responses {
		var result struct {
			Admitted bool   `json:"admitted"`
			Token    string `json:"token"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code == http.StatusCreated {
			winners++
			token = result.Token
			if !result.Admitted || len(token) != 64 {
				t.Fatalf("missing admission authority: %s", response.Body)
			}
		} else {
			roundHTTPStatus(t, response, http.StatusOK)
			if result.Admitted || result.Token != "" || strings.Contains(response.Body.String(), "token") {
				t.Fatalf("replay granted execution authority: %s", response.Body)
			}
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent HTTP admission executed %d times", winners)
	}
	// Build a new Store and route set around the same PG state to simulate a
	// collaborator process restart, without depending on in-memory dedup maps.
	handler = server.New(nil, store.NewPGOnly(pool), nil, threadRoundHTTPAuth{}, slog.Default()).Routes()
	replay := roundHTTPRequest(handler, http.MethodPost, path, thread.Realm, "owner", body)
	roundHTTPStatus(t, replay, http.StatusOK)
	if strings.Contains(replay.Body.String(), "token") || !strings.Contains(replay.Body.String(), `"admitted":false`) {
		t.Fatal("restart replay reacquired execution authority")
	}
	state := roundHTTPRequest(handler, http.MethodPost, "/threads/"+thread.ID+"/state", thread.Realm, "owner", []byte(`{"to":"awaiting"}`))
	roundHTTPStatus(t, state, http.StatusConflict)
	finishPath := path + "/run-7/finish"
	finish := func(candidateToken, outcome, summary string) *httptest.ResponseRecorder {
		return roundHTTPRequest(handler, http.MethodPost, finishPath, thread.Realm, "owner", roundHTTPBody(t,
			map[string]string{"token": candidateToken, "state": outcome, "summary": summary}))
	}
	roundHTTPStatus(t, finish(strings.Repeat("0", 64), "completed", "deliverable"), http.StatusConflict)
	firstFinish := finish(token, "completed", "deliverable")
	roundHTTPStatus(t, firstFinish, http.StatusOK)
	repeatedFinish := finish(token, "completed", "deliverable")
	roundHTTPStatus(t, repeatedFinish, http.StatusOK)
	if firstFinish.Body.String() != repeatedFinish.Body.String() || strings.Contains(firstFinish.Body.String(), "token") {
		t.Fatal("finished receipt was mutable or disclosed the execution capability")
	}
	roundHTTPStatus(t, finish(token, "completed", "changed"), http.StatusConflict)
	current, err := st.GetThread(ctx, thread.Realm, thread.ID)
	if err != nil || current.State != domain.ThreadStateIdle {
		t.Fatalf("finished thread was not released: %+v %v", current, err)
	}
	next := roundHTTPRequest(handler, http.MethodPost, path, thread.Realm, "owner", roundHTTPBody(t, roundHTTPAdmission(thread, "run-8", 8)))
	roundHTTPStatus(t, next, http.StatusCreated)
	if !strings.Contains(next.Body.String(), `"session_mode":"resume"`) {
		t.Fatal("continuation lost its required session mode")
	}
}

func TestThreadRoundHTTPNodeLossRejectsLateSuccess(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	thread, err := st.CreateThread(ctx, threadRow("round-http-lost", "round-http-lost-session", "lost-node"))
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(nil, st, nil, threadRoundHTTPAuth{}, slog.Default()).Routes()
	path := "/threads/" + thread.ID
	admission := roundHTTPRequest(handler, http.MethodPost, path+"/rounds", thread.Realm, "owner", roundHTTPBody(t, roundHTTPAdmission(thread, "lost-run", 1)))
	roundHTTPStatus(t, admission, http.StatusCreated)
	var authority struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(admission.Body.Bytes(), &authority); err != nil {
		t.Fatal(err)
	}
	loss := roundHTTPRequest(handler, http.MethodPost, path+"/node-loss", thread.Realm, "owner", roundHTTPBody(t, map[string]string{"node_id": thread.NodeID}))
	roundHTTPStatus(t, loss, http.StatusOK)
	lateSuccess := roundHTTPRequest(handler, http.MethodPost, path+"/rounds/lost-run/finish", thread.Realm, "owner", roundHTTPBody(t,
		map[string]string{"token": authority.Token, "state": "completed", "summary": "late success"}))
	roundHTTPStatus(t, lateSuccess, http.StatusConflict)
	current, err := st.GetThread(ctx, thread.Realm, thread.ID)
	if err != nil || current.State != domain.ThreadStateFailed {
		t.Fatalf("late success revived terminated thread: %+v %v", current, err)
	}
}

func TestThreadRoundHTTPEnforcesAgentConcurrencySnapshot(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()
	threads := make([]domain.Thread, 2)
	for i, id := range []string{"round-http-slot-a", "round-http-slot-b"} {
		var err error
		threads[i], err = st.CreateThread(ctx, threadRow(id, "session-"+id, "node-1"))
		if err != nil {
			t.Fatal(err)
		}
	}
	handler := server.New(nil, st, nil, threadRoundHTTPAuth{}, slog.Default()).Routes()
	admit := func(thread domain.Thread, limit int) *httptest.ResponseRecorder {
		body := roundHTTPAdmission(thread, "run-"+thread.ID, 1)
		body["max_concurrency"] = limit
		return roundHTTPRequest(handler, http.MethodPost, "/threads/"+thread.ID+"/rounds", thread.Realm, "owner", roundHTTPBody(t, body))
	}
	roundHTTPStatus(t, admit(threads[0], 0), http.StatusBadRequest)
	first := admit(threads[0], 1)
	roundHTTPStatus(t, first, http.StatusCreated)
	var admission struct {
		Token   string                   `json:"token"`
		Receipt store.ThreadRoundReceipt `json:"receipt"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &admission); err != nil || admission.Receipt.MaxConcurrency != 1 {
		t.Fatalf("preset concurrency snapshot missing: %s %v", first.Body, err)
	}
	roundHTTPStatus(t, admit(threads[0], 2), http.StatusConflict)
	roundHTTPStatus(t, admit(threads[1], 1), http.StatusConflict)
	waiting, err := st.GetThread(ctx, threads[1].Realm, threads[1].ID)
	if err != nil || waiting.State != domain.ThreadStateIdle {
		t.Fatalf("capacity refusal changed waiting Thread: %+v %v", waiting, err)
	}
	finish := roundHTTPRequest(handler, http.MethodPost, "/threads/"+threads[0].ID+"/rounds/"+admission.Receipt.RunID+"/finish", threads[0].Realm, "owner", roundHTTPBody(t,
		map[string]string{"token": admission.Token, "state": "completed", "summary": "complete"}))
	roundHTTPStatus(t, finish, http.StatusOK)
	roundHTTPStatus(t, admit(threads[1], 1), http.StatusCreated)
}
