package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	bg "github.com/lumo-harness/platform/governance/internal/breakglass"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

func recoveryHTTP(t *testing.T, config bg.ProviderConfig) (http.Handler, func(string, string, string, string, string) *httptest.ResponseRecorder) {
	t.Helper()
	st, pool := receiptHTTPStore(t)
	if _, err := pool.Exec(context.Background(), `INSERT INTO governance_roles(realm,id,name,status) VALUES('r1','realm_admin','Admin','active'); INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('r1','u1','realm_admin','u1'),('r1','u2','realm_admin','u1')`); err != nil {
		t.Fatal(err)
	}
	server, err := New(st, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster(), RecoveryProvider: config}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	server.Register(mux)
	invoke := func(method, path, user, realm, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-Lumo-User", user)
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-Roles", "realm_admin")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	return mux, invoke
}
func recoveryConfig(endpoint string) bg.ProviderConfig {
	return bg.ProviderConfig{ID: "mock", Endpoint: endpoint, Token: "recovery-service-token", ReceiptKey: base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))), Operations: []bg.Operation{bg.Restore}, Scopes: []bg.TargetScope{{Operation: bg.Restore, Realm: "r1", Namespace: "backups", Prefix: "tenant-a/"}}}
}
func createRecoveryBody() string {
	return fmt.Sprintf(`{"operation":"restore","namespace":"backups","target_id":"tenant-a/db","recovery_point":"snapshot-1","reason":"recover incident","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
}
func decodeHTTPRecovery(t *testing.T, w *httptest.ResponseRecorder, want int) bg.DurableRequest {
	t.Helper()
	if w.Code != want {
		t.Fatalf("response %d want %d: %s", w.Code, want, w.Body)
	}
	var request bg.DurableRequest
	if err := json.Unmarshal(w.Body.Bytes(), &request); err != nil || request.ID == "" {
		t.Fatalf("invalid request response: %s %v", w.Body, err)
	}
	return request
}
func recoveryActionBody(r bg.DurableRequest) string {
	raw, _ := json.Marshal(map[string]any{"expected_revision": r.Revision, "request_digest": r.RequestDigest})
	return string(raw)
}
func TestRecoveryHTTPTwoPersonApprovalProviderReceiptAndReplay(t *testing.T) {
	var config bg.ProviderConfig
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var execution bg.Execution
		_ = json.NewDecoder(r.Body).Decode(&execution)
		if r.URL.Path != "/recovery/execute" || execution.Realm != "r1" || execution.TargetID != "tenant-a/db" || r.Header.Get("Authorization") != "Bearer recovery-service-token" {
			t.Error("provider contract mismatch")
		}
		receipt := bg.Receipt{Execution: execution, Outcome: "succeeded", ReceiptID: "receipt-verified", CompletedAt: time.Now().UTC()}
		key, _ := base64.StdEncoding.DecodeString(config.ReceiptKey)
		receipt.Signature, _ = bg.SignReceipt(receipt, key)
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	defer provider.Close()
	config = recoveryConfig(provider.URL + "/recovery")
	handler, invoke := recoveryHTTP(t, config)
	created := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests", "u1", "r1", createRecoveryBody()), 201)
	if calls.Load() != 0 {
		t.Fatal("creation invoked provider")
	}
	if w := invoke("POST", "/v1/recovery-requests/"+created.ID+"/approve", "u1", "r1", recoveryActionBody(created)); w.Code != 409 {
		t.Fatalf("self approval: %d %s", w.Code, w.Body)
	}
	approved := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/approve", "u2", "r1", recoveryActionBody(created)), 200)
	if w := invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u2", "r1", recoveryActionBody(approved)); w.Code != 409 {
		t.Fatalf("approver executed: %d %s", w.Code, w.Body)
	}
	wrong := approved
	wrong.RequestDigest = strings.Repeat("0", 64)
	if w := invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u1", "r1", recoveryActionBody(wrong)); w.Code != 409 {
		t.Fatalf("changed request summary: %d %s", w.Code, w.Body)
	}
	done := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u1", "r1", recoveryActionBody(approved)), 200)
	if done.Status != bg.Succeeded || done.Receipt == nil || done.Receipt.ReceiptID != "receipt-verified" || calls.Load() != 1 {
		t.Fatalf("verified completion: %+v calls=%d", done, calls.Load())
	}
	_ = decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u1", "r1", recoveryActionBody(approved)), 200)
	if calls.Load() != 1 {
		t.Fatal("replayed request invoked provider again")
	}
	if w := invoke("GET", "/v1/recovery-requests/"+created.ID, "u1", "foreign", ""); w.Code != 403 {
		t.Fatalf("foreign Realm leaked request: %d", w.Code)
	}
	r := httptest.NewRequest("GET", "/v1/recovery-requests", nil)
	r.Header.Set("X-Lumo-User", "u1")
	r.Header.Set("X-Lumo-Realm", "r1")
	r.Header.Set("X-Lumo-Roles", "custom-inherited-admin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("inherited role header gained recovery authority")
	}
	w = invoke("GET", "/v1/recovery-requests/"+created.ID, "u2", "r1", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"event":"succeeded"`) || strings.Contains(w.Body.String(), "claim_hash") || strings.Contains(w.Body.String(), "recovery-service-token") {
		t.Fatalf("audit missing or secrets leaked: %s", w.Body)
	}
}
func TestRecoveryHTTPProviderFailureIsUnknownAndReceiptLookupReusesExecutionIdentity(t *testing.T) {
	var config bg.ProviderConfig
	var initial bg.Execution
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var execution bg.Execution
		_ = json.NewDecoder(r.Body).Decode(&execution)
		if calls.Add(1) == 1 {
			initial = execution
			w.WriteHeader(500)
			_, _ = w.Write([]byte("private KMS diagnostic and credentials"))
			return
		}
		if execution.Mode != "receipt" || execution.ExecutionID != initial.ExecutionID || execution.IdempotencyKey != initial.IdempotencyKey || execution.FencingToken <= initial.FencingToken {
			t.Error("receipt resolution changed immutable execution identity")
		}
		receipt := bg.Receipt{Execution: execution, Outcome: "succeeded", ReceiptID: "resolved-receipt", CompletedAt: time.Now().UTC()}
		key, _ := base64.StdEncoding.DecodeString(config.ReceiptKey)
		receipt.Signature, _ = bg.SignReceipt(receipt, key)
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	defer provider.Close()
	config = recoveryConfig(provider.URL + "/recovery")
	_, invoke := recoveryHTTP(t, config)
	created := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests", "u1", "r1", createRecoveryBody()), 201)
	approved := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/approve", "u2", "r1", recoveryActionBody(created)), 200)
	w := invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u1", "r1", recoveryActionBody(approved))
	var unknown struct {
		Request bg.DurableRequest `json:"request"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &unknown)
	if w.Code != 503 || unknown.Request.Status != bg.Uncertain || strings.Contains(w.Body.String(), "private KMS") {
		t.Fatalf("unsafe unknown result: %d %s", w.Code, w.Body)
	}
	if w = invoke("POST", "/v1/recovery-requests/"+created.ID+"/revoke", "u1", "r1", recoveryActionBody(unknown.Request)); w.Code != 409 {
		t.Fatal("unknown external result was falsely revoked")
	}
	done := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/receipt", "u1", "r1", recoveryActionBody(unknown.Request)), 200)
	if done.Status != bg.Succeeded || calls.Load() != 2 {
		t.Fatalf("could not reconcile signed receipt: %+v", done)
	}
}
func TestRecoveryHTTPUnconfiguredAndOutOfDeploymentScopeCannotExecute(t *testing.T) {
	_, invoke := recoveryHTTP(t, bg.ProviderConfig{})
	if w := invoke("POST", "/v1/recovery-requests", "u1", "r1", createRecoveryBody()); w.Code != 503 {
		t.Fatalf("unconfigured provider created executable request: %d %s", w.Code, w.Body)
	}
	_, invoke = recoveryHTTP(t, recoveryConfig("https://unused.invalid/recovery"))
	for _, body := range []string{strings.Replace(createRecoveryBody(), "tenant-a/db", "tenant-b/db", 1), strings.Replace(createRecoveryBody(), `"restore"`, `"key_destroy"`, 1)} {
		if w := invoke("POST", "/v1/recovery-requests", "u1", "r1", body); w.Code != 403 {
			t.Fatalf("operation/target bypassed deployment scope: %d %s", w.Code, w.Body)
		}
	}
	if w := invoke("POST", "/v1/recovery-requests", "u1", "r1", strings.TrimSuffix(createRecoveryBody(), "}")+`,"requested_by":"forged"}`); w.Code != 400 {
		t.Fatalf("forged requester accepted: %d", w.Code)
	}
	if w := invoke("POST", "/v1/recovery-requests", "u1", "r1", createRecoveryBody()+` {}`); w.Code != 400 {
		t.Fatalf("multiple bodies accepted: %d", w.Code)
	}
}

func TestRecoveryHTTPKeyDestructionRequiresExplicitProviderOperationAndDualApproval(t *testing.T) {
	var config bg.ProviderConfig
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var execution bg.Execution
		_ = json.NewDecoder(r.Body).Decode(&execution)
		if execution.Operation != bg.DestroyKey || execution.Namespace != "keys" || execution.TargetID != "tenant-a/key-1" || execution.RecoveryPoint != "" {
			t.Error("unexpected key protocol target")
		}
		// This fake provider only signs a test receipt; it has no KMS capability.
		receipt := bg.Receipt{Execution: execution, Outcome: "succeeded", ReceiptID: "mock-key-receipt", CompletedAt: time.Now().UTC()}
		key, _ := base64.StdEncoding.DecodeString(config.ReceiptKey)
		receipt.Signature, _ = bg.SignReceipt(receipt, key)
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	defer provider.Close()
	config = recoveryConfig(provider.URL + "/recovery")
	config.Operations = []bg.Operation{bg.DestroyKey}
	config.Scopes = []bg.TargetScope{{Operation: bg.DestroyKey, Realm: "r1", Namespace: "keys", Prefix: "tenant-a/"}}
	_, invoke := recoveryHTTP(t, config)
	body := fmt.Sprintf(`{"operation":"key_destroy","namespace":"keys","target_id":"tenant-a/key-1","reason":"test protocol only","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	created := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests", "u1", "r1", body), 201)
	if calls.Load() != 0 {
		t.Fatal("unapproved key request reached provider")
	}
	if w := invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u1", "r1", recoveryActionBody(created)); w.Code != 409 {
		t.Fatalf("unapproved key execution: %d %s", w.Code, w.Body)
	}
	approved := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/approve", "u2", "r1", recoveryActionBody(created)), 200)
	done := decodeHTTPRecovery(t, invoke("POST", "/v1/recovery-requests/"+created.ID+"/execute", "u1", "r1", recoveryActionBody(approved)), 200)
	if done.Status != bg.Succeeded || calls.Load() != 1 {
		t.Fatalf("explicit key-provider protocol not wired: %+v", done)
	}
}
