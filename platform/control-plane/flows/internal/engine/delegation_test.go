package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

const validReceipt = `{"task":{"id":"task-1","realm":"r1","project_id":"p1","requester_user_id":"u1","assignee_worker_id":"agent:changed"},"run":{"id":"run-1","realm":"r1","task_id":"task-1","worker_id":"agent:worker"}}`

func delegationConfig() map[string]any {
	return map[string]any{"projectId": "p1", "assigneeWorkerId": "agent:worker", "intent": "Analyze the reported issue", "requiredTags": []string{"analysis"}, "requiredSkills": []string{"investigate"}}
}

func delegationContext(key string) context.Context {
	return WithExecutionKey(WithIdentity(context.Background(), testIdentity()), key)
}

func TestDelegationAuthorityAndStableNodeReceipts(t *testing.T) {
	var keys []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/delegations" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer token" {
			t.Error("incorrect governance protocol")
		}
		if r.Header.Get("X-Lumo-User") != "u1" || r.Header.Get("X-Lumo-Realm") != "r1" || r.Header.Get("X-Lumo-Roles") != "editor" || r.Header.Get("X-Lumo-Project") != "p1" || r.Header.Get("X-Lumo-Trace") != "flow-trigger-9" {
			t.Error("identity must come from trusted context")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["project_id"] != "p1" || body["assignee_worker_id"] != "agent:worker" || body["auto_assign"] != false || body["title"] != delegationConfig()["intent"] {
			t.Errorf("target changed by input: %+v", body)
		}
		if fmt.Sprint(body["required_tags"]) != "[analysis]" || fmt.Sprint(body["required_skills"]) != "[investigate]" {
			t.Errorf("requirements changed by input: %+v", body)
		}
		if !strings.Contains(fmt.Sprint(body["intent"]), "External event data (untrusted):") {
			t.Error("external event data must be labelled")
		}
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(validReceipt))
	}))
	t.Cleanup(upstream.Close)
	eng := New(RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "token"})
	payload := map[string]any{"projectId": "victim", "assignee_worker_id": "evil", "user_id": "admin", "roles": []string{"admin"}, "required_tags": []string{"evil"}}
	for _, attempt := range []struct{ key, node string }{{"event-1", "n0"}, {"event-1", "n0"}, {"event-1", "n1"}, {"event-2", "n0"}} {
		def := &domain.Definition{Nodes: []domain.FlowNode{{ID: attempt.node, Operator: "delegation.create", Config: delegationConfig()}}}
		result, err := eng.Run(WithWakeTrace(delegationContext(attempt.key), domain.WakeTrace(9)), def, payload)
		if err != nil || result.Outputs[attempt.node] == nil {
			t.Fatalf("delegation failed: %+v %v", result, err)
		}
	}
	if len(keys) != 4 || keys[0] == "" || keys[0] != keys[1] || keys[0] == keys[2] || keys[0] == keys[3] {
		t.Fatalf("unstable or colliding keys: %v", keys)
	}
}

func TestDelegationRejectsMissingAuthorityAndOversizeInput(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(validReceipt))
	}))
	t.Cleanup(upstream.Close)
	eng := New(RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "token"})
	for _, tc := range []struct {
		name   string
		ctx    context.Context
		config map[string]any
		input  any
	}{
		{"missing execution key", WithIdentity(context.Background(), testIdentity()), delegationConfig(), nil},
		{"missing identity", WithExecutionKey(context.Background(), "key"), delegationConfig(), nil},
		{"cross project", delegationContext("key"), map[string]any{"projectId": "other", "assigneeWorkerId": "agent:worker", "intent": "hi"}, nil},
		{"payload cannot supply config", delegationContext("key"), nil, delegationConfig()},
		{"oversize input", delegationContext("key"), delegationConfig(), strings.Repeat("x", 256<<10)},
		{"oversize objective", delegationContext("key"), delegationConfig(), strings.Repeat("中", 8000)},
		{"invalid requirements", delegationContext("key"), map[string]any{"projectId": "p1", "assigneeWorkerId": "agent:worker", "intent": "hi", "requiredTags": []any{1}}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := eng.Run(tc.ctx, node("delegation.create", tc.config), tc.input); err == nil {
				t.Fatal("invalid delegation accepted")
			}
		})
	}
	if calls != 0 {
		t.Fatalf("sent %d unauthorized requests", calls)
	}
	for _, config := range []RuntimeConfig{{}, {GovernanceURL: upstream.URL}, {GovernanceURL: "http://u:p@host", ControlToken: "token"}} {
		if err := New(config).Validate(node("delegation.create", delegationConfig())); err == nil {
			t.Fatal("invalid runtime configuration accepted")
		}
	}
}

func TestDelegationRejectsInvalidUpstreamReceipts(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"bad JSON", `{`, 201},
		{"missing receipt", `{}`, 201},
		{"structured IDs", `{"task":{"id":{},"realm":"r1","project_id":"p1","requester_user_id":"u1"},"run":{"id":[],"task_id":{}}}`, 201},
		{"wrong realm", strings.ReplaceAll(validReceipt, `"r1"`, `"r2"`), 201},
		{"wrong owner", strings.ReplaceAll(validReceipt, `"u1"`, `"u2"`), 201},
		{"wrong worker", strings.ReplaceAll(validReceipt, `"agent:worker"`, `"agent:other"`), 201},
		{"wrong task", strings.ReplaceAll(validReceipt, `"task_id":"task-1"`, `"task_id":"task-2"`), 201},
		{"oversize", strings.Repeat("x", (1<<20)+1), 201},
		{"upstream failure", validReceipt, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			t.Cleanup(upstream.Close)
			if _, err := New(RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "token"}).Run(delegationContext("key"), node("delegation.create", delegationConfig()), nil); err == nil {
				t.Fatal("invalid upstream receipt accepted")
			}
		})
	}
}

func TestDelegationNeverFollowsRedirects(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; _, _ = w.Write([]byte(validReceipt)) }))
	t.Cleanup(target.Close)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(upstream.Close)
	if _, err := New(RuntimeConfig{GovernanceURL: upstream.URL, ControlToken: "token"}).Run(delegationContext("key"), node("delegation.create", delegationConfig()), nil); err == nil || calls != 0 {
		t.Fatalf("followed redirect: calls=%d err=%v", calls, err)
	}
}
