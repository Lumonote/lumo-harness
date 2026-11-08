package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/observability"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type remoteComputerTransport func(*http.Request) (*http.Response, error)

func (f remoteComputerTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func remoteComputerFixtureContext(t *testing.T) context.Context {
	t.Helper()
	ctx := WithExecutionKey(WithIdentity(context.Background(), observability.Identity{Realm: "realm", UserID: "author", ProjectID: "project", Roles: []string{"owner"}}), "trusted-run")
	ctx, err := WithBotScope(ctx, json.RawMessage(`{"channel":"channel","subject":"subject","user_id":"sender","binding_revision":2,"message_id":"message","grants":[{"team_id":"team","project_id":"project","agent_id":"agent","capability":"computer-use.request","revision":3}]}`), "flow", 4)
	if err != nil {
		t.Fatal(err)
	}
	return ctx
}
func remoteComputerDefinition() *domain.Definition {
	return &domain.Definition{Nodes: []domain.FlowNode{{ID: "remote", Operator: "computer-use.request", Config: map[string]any{"projectId": "project", "teamId": "team", "captainSessionRef": "captain", "assigneeWorkerId": "agent:agent", "deviceId": "device", "sessionRef": "session", "capability": "computer.observe", "ttlSeconds": float64(30), "intent": "Observe the fixture"}}}}
}
func TestRemoteComputerOperatorWaitsForDeviceReceiptAndFreezesReviewedTarget(t *testing.T) {
	var created map[string]any
	var receipt map[string]any
	polls := 0
	client := &http.Client{Transport: remoteComputerTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer service" || r.Header.Get("X-Lumo-Realm") != "realm" {
			t.Fatal("missing internal authentication")
		}
		status := 200
		if r.Method == http.MethodPost && r.URL.Path == "/v1/runtime/computer-use/requests" {
			status = 202
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
			if created["device_id"] != "device" || created["session_ref"] != "session" || created["capability"] != "computer.observe" || created["sender_user_id"] != "sender" || created["author_user_id"] != "author" || created["grant_revision"] != float64(3) || created["binding_revision"] != float64(2) {
				t.Fatalf("untrusted target: %+v", created)
			}
			plan, _ := json.Marshal(map[string]any{"realm": "realm", "node_id": "device", "owner_user_id": "owner", "project_id": "project", "session_ref": "session", "capability": "computer.observe", "intent": created["intent"], "channel": "channel", "subject": "subject", "sender_user_id": "sender", "team_id": "team", "agent_id": "agent", "expires_at": time.Now().Add(time.Minute).UTC()})
			digest := sha256.Sum256(plan)
			receipt = map[string]any{"version": 1, "request_id": strings.Repeat("A", 43), "digest": "sha256:" + hex.EncodeToString(digest[:]), "plan_json": string(plan), "state": "pending", "revision": 1}
		} else if r.Method == http.MethodGet {
			polls++
			if polls == 1 {
				receipt["state"] = "running"
			} else {
				receipt["state"] = "completed"
			}
		} else {
			t.Fatalf("unexpected call: %s %s", r.Method, r.URL.Path)
		}
		raw, _ := json.Marshal(receipt)
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(string(raw))), Header: http.Header{}}, nil
	})}
	e := New(RuntimeConfig{GovernanceURL: "https://control.invalid", ControlToken: "service", RemoteComputerUse: true, Client: client})
	result, err := e.Run(remoteComputerFixtureContext(t), remoteComputerDefinition(), map[string]any{"deviceId": "victim", "sessionRef": "other", "owner_user_id": "admin", "capability": "computer.interact"})
	if err != nil {
		t.Fatal(err)
	}
	if polls != 2 || result.Outputs["remote"].(map[string]any)["state"] != "completed" {
		t.Fatalf("premature receipt: %+v polls=%d", result, polls)
	}
}
func TestRemoteComputerOperatorDefaultClosedAndNeverAcceptsOrdinaryFlowIdentity(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		calls := 0
		e := New(RuntimeConfig{GovernanceURL: "https://control.invalid", ControlToken: "service", RemoteComputerUse: enabled, Client: &http.Client{Transport: remoteComputerTransport(func(*http.Request) (*http.Response, error) { calls++; return nil, fmt.Errorf("must not call") })}})
		ctx := WithExecutionKey(WithIdentity(context.Background(), observability.Identity{Realm: "realm", UserID: "author", ProjectID: "project", Roles: []string{"owner"}}), "run")
		if _, err := e.Run(ctx, remoteComputerDefinition(), nil); err == nil || calls != 0 {
			t.Fatalf("enabled=%t ordinary Flow admitted: %v calls=%d", enabled, err, calls)
		}
	}
}
