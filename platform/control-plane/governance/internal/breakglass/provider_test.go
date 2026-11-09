package breakglass

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testProvider(endpoint string) ProviderConfig {
	return ProviderConfig{ID: "mock", Endpoint: endpoint, Token: "service-token", ReceiptKey: base64.StdEncoding.EncodeToString([]byte(strings.Repeat("r", 32))), Operations: []Operation{Restore, DestroyKey}, Scopes: []TargetScope{{Operation: Restore, Realm: "r1", Namespace: "backups", Prefix: "tenant-a/"}, {Operation: DestroyKey, Realm: "r1", Namespace: "keys", Prefix: "tenant-a/"}}}
}
func testExecution() Execution {
	return Execution{Version: ProtocolVersion, ProviderID: "mock", RequestID: "request-1", Realm: "r1", Target: Target{Operation: Restore, Namespace: "backups", TargetID: "tenant-a/db", RecoveryPoint: "snapshot-1"}, RequestDigest: strings.Repeat("a", 64), ExecutionID: "exec-1", IdempotencyKey: "lumo-recovery:exec-1", FencingToken: 1, Mode: "execute", ExpiresAt: time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)}
}
func TestDurableRecoveryTargetAndConfigFailClosed(t *testing.T) {
	if err := (ProviderConfig{}).Validate(); err != nil {
		t.Fatal(err)
	}
	if (ProviderConfig{}).Allows("r1", testExecution().Target) {
		t.Fatal("unconfigured provider granted permission")
	}
	config := testProvider("https://provider.test/v1/recovery")
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, target := range []Target{{Operation: Restore, Namespace: "backups", TargetID: "tenant-b/db", RecoveryPoint: "snapshot-1"}, {Operation: Restore, Namespace: "keys", TargetID: "tenant-a/db", RecoveryPoint: "snapshot-1"}, {Operation: Restore, Namespace: "backups", TargetID: "tenant-a/../db", RecoveryPoint: "snapshot-1"}, {Operation: DestroyKey, Namespace: "backups", TargetID: "tenant-a/key", RecoveryPoint: "secret-credential"}} {
		if config.Allows("r1", target) {
			t.Fatalf("target bypassed allowlist: %+v", target)
		}
	}
	if config.Allows("r2", testExecution().Target) {
		t.Fatal("same namespace/target in foreign Realm allowed")
	}
	for _, endpoint := range []string{"file:///tmp/x", "http://provider.test/base", "http://localhost/base", "https://user:pass@provider.test", "https://provider.test/base?q=x", "https://provider.test/base#secret", "https://provider.test/base/", "https://provider.test/../base"} {
		config.Endpoint = endpoint
		if config.Validate() == nil {
			t.Fatalf("untrusted endpoint accepted: %s", endpoint)
		}
	}
	config = testProvider("https://provider.test/v1/recovery")
	config.Scopes[0].Realm = "Tenant-A.example"
	if err := config.Validate(); err != nil || !config.Allows("Tenant-A.example", testExecution().Target) || config.Allows("tenant-a.example", testExecution().Target) {
		t.Fatal("Realm literal identity was normalized or restricted to namespace slugs")
	}
	config = testProvider("https://provider.test/v1/recovery")
	if config.Allows("r1", Target{Operation: DestroyKey, Namespace: "backups", TargetID: "tenant-a/key"}) || config.Allows("r1", Target{Operation: Restore, Namespace: "keys", TargetID: "tenant-a/db", RecoveryPoint: "snapshot-1"}) {
		t.Fatal("operation allowlists crossed target namespaces")
	}
	for _, scopes := range []string{`[{"realm":"r1","namespace":"backups","prefix":"tenant-a/","endpoint":"https://untrusted.test"}]`, `[] []`} {
		if _, err := ParseProviderConfig(config.ID, config.Endpoint, config.Token, config.ReceiptKey, "restore", scopes); err == nil {
			t.Fatal("unknown scope fields or trailing JSON accepted")
		}
	}
	config.Operations = []Operation{Restore}
	config.Scopes = config.Scopes[:1]
	if config.Allows("r1", Target{Operation: DestroyKey, Namespace: "backups", TargetID: "tenant-a/key"}) {
		t.Fatal("restore allowlist enabled key destruction")
	}
	first := config.Digest()
	config.Token = "rotated-token"
	if config.Digest() != first {
		t.Fatal("service token rotation invalidated immutable deployment policy")
	}
	config.Scopes[0].Prefix = "tenant-b/"
	if config.Digest() == first {
		t.Fatal("target scope change did not invalidate policy")
	}
}
func TestRecoveryProviderValidatesSignedReceiptAndStableIdempotency(t *testing.T) {
	var config ProviderConfig
	var invocations []Execution
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var execution Execution
		if err := json.NewDecoder(r.Body).Decode(&execution); err != nil {
			t.Error(err)
		}
		invocations = append(invocations, execution)
		if r.Method != "POST" || r.URL.Path != "/v1/recovery/"+execution.Mode || r.Header.Get("Authorization") != "Bearer service-token" || r.Header.Get("Idempotency-Key") != execution.IdempotencyKey || r.Header.Get("Cookie") != "" {
			t.Error("provider request identity/path mismatch")
		}
		receipt := Receipt{Execution: execution, Outcome: "succeeded", ReceiptID: "opaque-receipt", CompletedAt: time.Now().UTC()}
		key, _ := base64.StdEncoding.DecodeString(config.ReceiptKey)
		receipt.Signature, _ = SignReceipt(receipt, key)
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	defer upstream.Close()
	config = testProvider(upstream.URL + "/v1/recovery")
	execution := testExecution()
	if _, err := config.Call(context.Background(), execution); err != nil {
		t.Fatal(err)
	}
	execution.FencingToken = 2
	execution.Mode = "receipt"
	if _, err := config.Call(context.Background(), execution); err != nil {
		t.Fatal(err)
	}
	if len(invocations) != 2 || invocations[0].IdempotencyKey != invocations[1].IdempotencyKey || invocations[0].ExecutionID != invocations[1].ExecutionID {
		t.Fatal("retry changed external execution identity")
	}
}
func TestRecoveryProviderRejectsForgedMismatchedOversizedAndRedirectedReceipts(t *testing.T) {
	for _, variant := range []string{"signature", "realm", "target", "digest", "execution", "fence", "outcome", "future", "trailing", "oversized", "unknown"} {
		t.Run(variant, func(t *testing.T) {
			var config ProviderConfig
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var execution Execution
				_ = json.NewDecoder(r.Body).Decode(&execution)
				receipt := Receipt{Execution: execution, Outcome: "succeeded", ReceiptID: "receipt-1", CompletedAt: time.Now().UTC()}
				switch variant {
				case "realm":
					receipt.Realm = "r2"
				case "target":
					receipt.TargetID = "tenant-a/other"
				case "digest":
					receipt.RequestDigest = strings.Repeat("b", 64)
				case "execution":
					receipt.ExecutionID = "other"
				case "fence":
					receipt.FencingToken--
				case "outcome":
					receipt.Outcome = "destroyed-maybe"
				case "future":
					receipt.CompletedAt = time.Now().Add(time.Hour)
				}
				key, _ := base64.StdEncoding.DecodeString(config.ReceiptKey)
				receipt.Signature, _ = SignReceipt(receipt, key)
				if variant == "signature" {
					receipt.Signature = "forged"
				}
				raw, _ := json.Marshal(receipt)
				switch variant {
				case "trailing":
					raw = append(raw, []byte(` {}`)...)
				case "oversized":
					raw = []byte(strings.Repeat("x", 33<<10))
				case "unknown":
					raw = append(raw[:len(raw)-1], []byte(`,"secret":"unexpected"}`)...)
				}
				_, _ = w.Write(raw)
			}))
			defer upstream.Close()
			config = testProvider(upstream.URL + "/v1/recovery")
			if _, err := config.Call(context.Background(), testExecution()); err == nil {
				t.Fatalf("unsafe %s receipt accepted", variant)
			}
		})
	}
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer redirect.Close()
	if _, err := testProvider(redirect.URL+"/v1/recovery").Call(context.Background(), testExecution()); err == nil || redirected {
		t.Fatal("followed provider redirect")
	}
}

func TestLegacyReceiptPreservesV1PayloadAndCannotExecute(t *testing.T) {
	var config ProviderConfig
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var execution Execution
		if err := json.NewDecoder(r.Body).Decode(&execution); err != nil {
			t.Fatal(err)
		}
		if execution.Version != LegacyProtocolVersion || execution.Mode != "receipt" || execution.ExpiresAt != "" {
			t.Error("legacy execution payload changed")
		}
		receipt := Receipt{Execution: execution, Outcome: "succeeded", ReceiptID: "legacy-receipt", CompletedAt: time.Now().UTC()}
		key, _ := base64.StdEncoding.DecodeString(config.ReceiptKey)
		receipt.Signature, _ = SignReceipt(receipt, key)
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	defer upstream.Close()
	config = testProvider(upstream.URL)
	execution := testExecution()
	execution.Version = LegacyProtocolVersion
	execution.ExpiresAt = ""
	execution.Mode = "receipt"
	if _, err := config.Call(context.Background(), execution); err != nil {
		t.Fatal(err)
	}
	execution.Mode = "execute"
	if _, err := config.Call(context.Background(), execution); err == nil || calls != 1 {
		t.Fatal("legacy request executed")
	}
	if config.Digest() == config.DigestForVersion(LegacyProtocolVersion) {
		t.Fatal("protocol upgrade did not change policy identity")
	}
	raw, _ := json.Marshal(execution)
	if strings.Contains(string(raw), "expires_at") {
		t.Fatal("legacy HMAC payload gained a field")
	}
}
