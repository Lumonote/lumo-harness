package breakglass

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/lumo-harness/platform/observability"
)

var ErrProviderUnavailable = errors.New("recovery provider unavailable or invalid receipt")

type TargetScope struct {
	Operation Operation `json:"operation"`
	Realm     string    `json:"realm"`
	Namespace string    `json:"namespace"`
	Prefix    string    `json:"prefix"`
}
type ProviderConfig struct {
	ID         string        `json:"id"`
	Endpoint   string        `json:"-"`
	Token      string        `json:"-"`
	ReceiptKey string        `json:"-"`
	Operations []Operation   `json:"operations"`
	Scopes     []TargetScope `json:"scopes"`
}

func (c ProviderConfig) Enabled() bool {
	return c.ID != "" && c.Endpoint != "" && c.Token != "" && c.ReceiptKey != "" && len(c.Operations) > 0 && len(c.Scopes) > 0
}
func (c ProviderConfig) Validate() error {
	if c.ID == "" && c.Endpoint == "" && c.Token == "" && c.ReceiptKey == "" && len(c.Operations) == 0 && len(c.Scopes) == 0 {
		return nil
	}
	key, err := base64.StdEncoding.DecodeString(c.ReceiptKey)
	if !c.Enabled() || !namespaceID.MatchString(c.ID) || strings.TrimSpace(c.Token) != c.Token || strings.IndexFunc(c.Token, unicode.IsControl) >= 0 || err != nil || len(key) < 32 {
		return errors.New("recovery provider requires fixed id, endpoint, service token, base64 receipt key of at least 32 bytes, operations and target scopes")
	}
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || strings.HasSuffix(u.Path, "/") || strings.Contains(u.Path, "\\") {
		return errors.New("recovery provider endpoint must be an exact trusted HTTPS base URL without credentials, query or fragment")
	}
	if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return errors.New("recovery provider requires HTTPS except literal loopback HTTP for local protocol tests")
		}
	}
	for _, part := range strings.Split(strings.TrimPrefix(u.Path, "/"), "/") {
		if part == "." || part == ".." {
			return errors.New("invalid recovery provider endpoint path")
		}
	}
	seen := map[Operation]bool{}
	for _, operation := range c.Operations {
		if (operation != Restore && operation != DestroyKey) || seen[operation] {
			return errors.New("invalid recovery provider operation allowlist")
		}
		seen[operation] = true
	}
	for _, scope := range c.Scopes {
		if !seen[scope.Operation] || scope.Realm == "" || len(scope.Realm) > 256 || strings.TrimSpace(scope.Realm) != scope.Realm || strings.IndexFunc(scope.Realm, unicode.IsControl) >= 0 || !namespaceID.MatchString(scope.Namespace) || !opaqueID.MatchString(scope.Prefix) || strings.Contains(scope.Prefix, "..") {
			return errors.New("recovery provider target scope requires an allowlisted operation, exact Realm and namespace, and nonempty opaque target prefix")
		}
	}
	return nil
}
func (c ProviderConfig) Allows(realm string, target Target) bool {
	if !c.Enabled() || target.Validate() != nil {
		return false
	}
	operation := false
	for _, value := range c.Operations {
		if value == target.Operation {
			operation = true
		}
	}
	if !operation {
		return false
	}
	for _, scope := range c.Scopes {
		if target.Operation == scope.Operation && realm == scope.Realm && target.Namespace == scope.Namespace && strings.HasPrefix(target.TargetID, scope.Prefix) {
			return true
		}
	}
	return false
}
func (c ProviderConfig) Digest() string {
	return c.DigestForVersion(ProtocolVersion)
}

// Only receipt reconciliation may use the unchanged legacy policy identity.
func (c ProviderConfig) DigestForVersion(version string) string {
	operations := append([]Operation{}, c.Operations...)
	sort.Slice(operations, func(i, j int) bool { return operations[i] < operations[j] })
	scopes := append([]TargetScope{}, c.Scopes...)
	sort.Slice(scopes, func(i, j int) bool {
		if scopes[i].Operation != scopes[j].Operation {
			return scopes[i].Operation < scopes[j].Operation
		}
		if scopes[i].Realm != scopes[j].Realm {
			return scopes[i].Realm < scopes[j].Realm
		}
		if scopes[i].Namespace == scopes[j].Namespace {
			return scopes[i].Prefix < scopes[j].Prefix
		}
		return scopes[i].Namespace < scopes[j].Namespace
	})
	raw, _ := json.Marshal(struct {
		Version    string
		ID         string
		Endpoint   string
		Operations []Operation
		Scopes     []TargetScope
	}{version, c.ID, c.Endpoint, operations, scopes})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func receiptPayload(receipt Receipt) ([]byte, error) {
	receipt.Signature = ""
	return json.Marshal(receipt)
}

// SignReceipt is also the provider integration contract: HMAC-SHA256 over the
// canonical JSON produced by this versioned typed receipt, signature empty.
func SignReceipt(receipt Receipt, key []byte) (string, error) {
	raw, err := receiptPayload(receipt)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(raw)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func (c ProviderConfig) Call(ctx context.Context, execution Execution) (Receipt, error) {
	var receipt Receipt
	legacyReceipt := execution.Version == LegacyProtocolVersion && execution.Mode == "receipt" && execution.ExpiresAt == ""
	_, expiryErr := time.Parse(time.RFC3339Nano, execution.ExpiresAt)
	if !c.Enabled() || c.ID != execution.ProviderID || !c.Allows(execution.Realm, execution.Target) || (execution.Mode != "execute" && execution.Mode != "receipt") || (!legacyReceipt && (execution.Version != ProtocolVersion || expiryErr != nil)) || execution.ExecutionID == "" || execution.FencingToken < 1 || execution.IdempotencyKey != "lumo-recovery:"+execution.ExecutionID {
		return receipt, ErrProviderUnavailable
	}
	body, err := json.Marshal(execution)
	if err != nil {
		return receipt, ErrProviderUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint+"/"+execution.Mode, bytes.NewReader(body))
	if err != nil {
		return receipt, ErrProviderUnavailable
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Idempotency-Key", execution.IdempotencyKey)
	client := observability.ConfiguredHTTPClient(10 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		return receipt, ErrProviderUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return receipt, ErrProviderUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (32<<10)+1))
	if err != nil || len(raw) > 32<<10 {
		return receipt, ErrProviderUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&receipt); err != nil {
		return Receipt{}, ErrProviderUnavailable
	}
	if decoder.Decode(new(any)) != io.EOF {
		return Receipt{}, ErrProviderUnavailable
	}
	if receipt.Execution != execution || !opaqueID.MatchString(receipt.ReceiptID) || receipt.CompletedAt.IsZero() || receipt.CompletedAt.After(time.Now().Add(time.Minute)) || (receipt.Outcome != "succeeded" && receipt.Outcome != "rejected" && receipt.Outcome != "pending" && receipt.Outcome != "not_found") {
		return Receipt{}, ErrProviderUnavailable
	}
	key, err := base64.StdEncoding.DecodeString(c.ReceiptKey)
	if err != nil {
		return Receipt{}, ErrProviderUnavailable
	}
	expected, err := SignReceipt(receipt, key)
	if err != nil {
		return Receipt{}, ErrProviderUnavailable
	}
	actual, err := base64.RawURLEncoding.DecodeString(receipt.Signature)
	if err != nil {
		return Receipt{}, ErrProviderUnavailable
	}
	expectedBytes, _ := base64.RawURLEncoding.DecodeString(expected)
	if !hmac.Equal(actual, expectedBytes) {
		return Receipt{}, ErrProviderUnavailable
	}
	return receipt, nil
}
func ParseProviderConfig(id, endpoint, token, key, operations, scopes string) (ProviderConfig, error) {
	c := ProviderConfig{ID: id, Endpoint: endpoint, Token: token, ReceiptKey: key}
	if operations != "" {
		for _, value := range strings.Split(operations, ",") {
			c.Operations = append(c.Operations, Operation(strings.TrimSpace(value)))
		}
	}
	if scopes != "" {
		decoder := json.NewDecoder(strings.NewReader(scopes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&c.Scopes); err != nil || decoder.Decode(new(any)) != io.EOF {
			return c, fmt.Errorf("recovery provider target scopes must be a JSON array")
		}
	}
	return c, c.Validate()
}
