package credentials

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSecretRedactsFormatting(t *testing.T) {
	t.Parallel()

	secret := NewSecret("top-secret-value")
	if secret.Empty() {
		t.Fatal("Secret.Empty() = true, want false")
	}
	if got := secret.Reveal(); got != "top-secret-value" {
		t.Fatalf("Secret.Reveal() = %q", got)
	}

	formatted := fmt.Sprintf("%s %v %#v", secret, secret, secret)
	if strings.Contains(formatted, secret.Reveal()) {
		t.Fatalf("formatted secret leaked its value: %q", formatted)
	}
	if got, want := formatted, "«redacted» «redacted» «redacted»"; got != want {
		t.Fatalf("formatted secret = %q, want %q", got, want)
	}
}

func TestEnvStoreResolvesVaultStyleReference(t *testing.T) {
	t.Setenv("TEST_CRED_SECRET_DATA_JIRA_TOKEN", "token-value")
	store := NewEnvStore("TEST_CRED_")

	secret, err := store.Resolve(context.Background(), "secret/data/jira#token")
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if got, want := secret.Reveal(), "token-value"; got != want {
		t.Fatalf("Resolve() = %q, want %q", got, want)
	}

	_, err = store.Resolve(context.Background(), "missing")
	if err == nil || !strings.Contains(err.Error(), "TEST_CRED_MISSING") {
		t.Fatalf("Resolve(missing) error = %v, want missing environment-variable error", err)
	}
}

func TestCachingStoreCachesThenRefreshesExpiredSecrets(t *testing.T) {
	inner := &countingStore{values: map[string]string{"connector-token": "first"}}
	cache := NewCaching(inner, time.Minute)

	first, err := cache.Resolve(context.Background(), "connector-token")
	if err != nil {
		t.Fatalf("first Resolve() error = %v", err)
	}
	inner.values["connector-token"] = "second"
	second, err := cache.Resolve(context.Background(), "connector-token")
	if err != nil {
		t.Fatalf("cached Resolve() error = %v", err)
	}
	if got, want := second.Reveal(), "first"; got != want {
		t.Fatalf("cached Resolve() = %q, want %q", got, want)
	}
	if got, want := inner.calls, 1; got != want {
		t.Fatalf("inner Resolve() calls = %d, want %d", got, want)
	}

	cache.seen["connector-token"] = cached{secret: first, at: time.Now().Add(-time.Minute)}
	refreshed, err := cache.Resolve(context.Background(), "connector-token")
	if err != nil {
		t.Fatalf("expired Resolve() error = %v", err)
	}
	if got, want := refreshed.Reveal(), "second"; got != want {
		t.Fatalf("expired Resolve() = %q, want %q", got, want)
	}
	if got, want := inner.calls, 2; got != want {
		t.Fatalf("inner Resolve() calls after expiry = %d, want %d", got, want)
	}
}

func TestNewCachingUsesSafeDefaultTTL(t *testing.T) {
	t.Parallel()

	if got, want := NewCaching(&countingStore{}, 0).ttl, time.Minute; got != want {
		t.Fatalf("default TTL = %s, want %s", got, want)
	}
}

type countingStore struct {
	values map[string]string
	calls  int
}

func (s *countingStore) Resolve(_ context.Context, ref string) (Secret, error) {
	s.calls++
	value, ok := s.values[ref]
	if !ok {
		return Secret{}, fmt.Errorf("unknown ref %q", ref)
	}
	return NewSecret(value), nil
}
