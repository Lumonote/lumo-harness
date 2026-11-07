package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/engine"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func TestManualDelegationKeyAndAuthorization(t *testing.T) {
	var keys []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"task": map[string]any{"id": "task", "realm": "r1", "project_id": "p1", "requester_user_id": r.Header.Get("X-Lumo-User")},
			"run":  map[string]any{"id": "run", "realm": "r1", "task_id": "task", "worker_id": "agent:worker"},
		})
	}))
	t.Cleanup(upstream.Close)
	ts, pool, seed := newTestServer(t, engine.RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "token"})
	seed("p1", map[string]string{"author": "owner", "other": "editor", "viewer": "viewer"})
	st := store.New(pool)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "manual-delegate", "p1", "r1", "Delegate", "author", json.RawMessage(`{"nodes":[{"id":"n0","operator":"delegation.create","config":{"projectId":"p1","assigneeWorkerId":"agent:worker","intent":"Analyze incident"}}],"edges":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		user, key string
		want      int
	}{
		{"author", "", 422}, {"author", "bad key", 400}, {"author", strings.Repeat("a", 201), 400},
		{"viewer", "key", 403}, {"author", "key", 200}, {"author", "key", 200}, {"other", "key", 200},
	} {
		res, body := do(t, http.MethodPost, ts.URL+"/v1/flows/"+f.ID+"/run", `{"input":{"user_id":"forged"}}`, auth(tc.user, "r1", map[string]string{"X-Lumo-Roles": "manager", "Idempotency-Key": tc.key}))
		if res.StatusCode != tc.want {
			t.Fatalf("%s key=%q: %d want %d: %s", tc.user, tc.key, res.StatusCode, tc.want, body)
		}
	}
	if len(keys) != 3 || keys[0] != keys[1] || keys[0] == keys[2] {
		t.Fatalf("manual scope: %v", keys)
	}
}
