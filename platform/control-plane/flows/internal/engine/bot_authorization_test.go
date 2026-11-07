package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

func TestBotSenderIntersectionRecheckedForEveryDelegationNode(t *testing.T) {
	var checks, effects atomic.Int32
	var revoked atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer service" {
			t.Error("missing service credential")
		}
		switch r.URL.Path {
		case "/v1/runtime/bot-authorization":
			checks.Add(1)
			var req map[string]any
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Error(err)
			}
			if req["sender_user_id"] != "mapped-user" || req["author_user_id"] != "author" || req["binding_revision"] != float64(4) || req["grant_revision"] != float64(7) || req["team_id"] != "team" || req["captain_session_ref"] != "captain" {
				t.Errorf("bad trusted scope: %v", req)
			}
			if revoked.Load() {
				w.WriteHeader(403)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"realm": "r1", "user_id": "mapped-user", "author_user_id": "author", "project_id": "project", "agent_id": "agent", "team_id": "team", "captain_session_ref": "captain", "capability": "delegation.create", "roles": []string{"manager"}})
		case "/v1/delegations":
			if r.Header.Get("X-Lumo-User") != "mapped-user" || r.Header.Get("X-Lumo-Roles") != "manager" {
				t.Errorf("body/author identity leaked: %v", r.Header)
			}
			effects.Add(1)
			revoked.Store(true)
			json.NewEncoder(w).Encode(map[string]any{"task": map[string]any{"id": "task", "realm": "r1", "project_id": "project", "requester_user_id": "mapped-user"}, "run": map[string]any{"id": "run", "realm": "r1", "task_id": "task", "worker_id": "agent:agent"}})
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	engine := New(RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "service"})
	definition := &domain.Definition{Nodes: []domain.FlowNode{
		{ID: "a", Operator: "delegation.create", Config: map[string]any{"projectId": "project", "assigneeWorkerId": "agent:agent", "intent": "first", "teamId": "team", "captainSessionRef": "captain"}},
		{ID: "b", Operator: "delegation.create", Config: map[string]any{"projectId": "project", "assigneeWorkerId": "agent:agent", "intent": "second", "teamId": "team", "captainSessionRef": "captain"}},
	}, Edges: []domain.FlowEdge{{From: "a", To: "b"}}}
	ctx := WithExecutionKey(WithIdentity(context.Background(), observability.Identity{Realm: "r1", UserID: "author", ProjectID: "project", Roles: []string{"owner"}}), "trusted-trigger")
	ctx, err := WithBotScope(ctx, json.RawMessage(`{"channel":"channel","subject":"subject","user_id":"mapped-user","binding_revision":4,"message_id":"message","grants":[{"team_id":"team","project_id":"project","agent_id":"agent","capability":"delegation.create","revision":7}]}`), "flow", 2)
	if err != nil {
		t.Fatal(err)
	}
	_, err = engine.Run(ctx, definition, map[string]any{"sender": "admin", "roles": []string{"platform_admin"}, "user_id": "admin"})
	if err == nil || !strings.Contains(err.Error(), "authorization denied") {
		t.Fatalf("expected current revocation: %v", err)
	}
	if checks.Load() != 2 || effects.Load() != 1 {
		t.Fatalf("checks=%d effects=%d", checks.Load(), effects.Load())
	}
}

func TestLegacyBotScopeCannotAuthorizeExternalOperators(t *testing.T) {
	e := New(RuntimeConfig{GovernanceURL: "http://unreachable.invalid", ControlToken: "service"})
	ctx := WithExecutionKey(WithIdentity(context.Background(), observability.Identity{Realm: "r", UserID: "author", ProjectID: "p", Roles: []string{"manager"}}), "trigger")
	ctx, err := WithBotScope(ctx, json.RawMessage(`{"channel":"legacy","message_id":"m"}`), "flow", 1)
	if err != nil {
		t.Fatal(err)
	}
	def := &domain.Definition{Nodes: []domain.FlowNode{{ID: "node", Operator: "delegation.create", Config: map[string]any{"projectId": "p", "assigneeWorkerId": "agent:a", "intent": "work"}}}}
	_, err = e.Run(ctx, def, map[string]any{"subject": "fake", "sender": "admin", "roles": []string{"platform_admin"}})
	if err == nil || !strings.Contains(err.Error(), "authenticated mapped sender") {
		t.Fatalf("legacy authorization: %v", err)
	}
	result, err := e.Run(ctx, &domain.Definition{Nodes: []domain.FlowNode{{ID: "echo", Operator: "echo"}}}, "still compatible")
	if err != nil || fmt.Sprint(result.Outputs["echo"]) != "still compatible" {
		t.Fatalf("legacy echo: %v %v", result, err)
	}
}

func TestBotCannotUseCapabilityGrantedAfterIngress(t *testing.T) {
	e := New(RuntimeConfig{GovernanceURL: "http://unreachable.invalid", ControlToken: "service"})
	identity := observability.Identity{Realm: "r1", UserID: "author", ProjectID: "project", Roles: []string{"manager"}}
	definition := &domain.Definition{Nodes: []domain.FlowNode{{ID: "delegate", Operator: "delegation.create", Config: map[string]any{"teamId": "team", "captainSessionRef": "captain", "projectId": "project", "assigneeWorkerId": "agent:agent", "intent": "work"}}}}
	for _, grants := range []string{`[]`, `[{"team_id":"another-team","project_id":"project","agent_id":"agent","capability":"delegation.create","revision":1}]`, `[{"team_id":"team","project_id":"other-project","agent_id":"agent","capability":"delegation.create","revision":1}]`, `[{"team_id":"team","project_id":"project","agent_id":"other-agent","capability":"delegation.create","revision":1}]`} {
		ctx := WithExecutionKey(WithIdentity(context.Background(), identity), "trigger")
		ctx, err := WithBotScope(ctx, json.RawMessage(`{"channel":"channel","subject":"subject","user_id":"mapped-user","binding_revision":1,"message_id":"message","grants":`+grants+`}`), "flow", 1)
		if err != nil {
			t.Fatal(err)
		}
		_, err = e.Run(ctx, definition, map[string]any{"grants": []map[string]any{{"team_id": "team", "project_id": "project", "agent_id": "agent", "capability": "delegation.create", "revision": 999}}})
		if err == nil || !strings.Contains(err.Error(), "frozen capability grant") {
			t.Fatalf("late/payload capability used: %v", err)
		}
	}
}
