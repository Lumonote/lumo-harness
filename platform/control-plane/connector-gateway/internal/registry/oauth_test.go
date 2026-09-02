package registry

import (
	"strings"
	"testing"

	"github.com/lumo-harness/platform/connector-gateway/internal/domain"
)

func TestValidateOAuthRequiresRegisteredProviderContract(t *testing.T) {
	connector := domain.Connector{
		ID: "saas-connector", Realm: "r1", Name: "SaaS", Protocol: domain.ProtocolREST,
		BaseURL: "https://api.example.test", Roles: []string{"operator"},
		Operations: map[string]domain.Operation{"read": {Name: "read", Method: "GET", Path: "/v1/items"}},
		Auth: domain.Auth{Kind: domain.AuthBearer, CredentialRef: "secret/data/saas/access-token", OAuth: &domain.OAuth2{
			Provider: "Example SaaS", AuthorizationURL: "https://login.example.test/authorize", TokenURL: "https://login.example.test/token",
			CallbackURL: "https://lumo.example.test/oauth/callback/example", ClientIDRef: "secret/data/saas/client-id", ClientSecretRef: "secret/data/saas/client-secret",
			Scopes: []string{"items.read"}, PKCE: true,
		}},
	}
	if err := Validate(connector); err != nil {
		t.Fatal(err)
	}

	connector.Auth.OAuth.PKCE = false
	if err := Validate(connector); err == nil || !strings.Contains(err.Error(), "PKCE") {
		t.Fatalf("missing PKCE error = %v", err)
	}
	connector.Auth.OAuth.PKCE = true
	connector.Auth.OAuth.CallbackURL = "http://lumo.example.test/oauth/callback/example"
	if err := Validate(connector); err == nil || !strings.Contains(err.Error(), "callbackUrl") {
		t.Fatalf("untrusted callback error = %v", err)
	}
	connector.Auth.OAuth.CallbackURL = "https://lumo.example.test/oauth/callback/example"
	connector.Auth.Kind = domain.AuthHeader
	connector.Auth.HeaderName = "Authorization"
	if err := Validate(connector); err == nil || !strings.Contains(err.Error(), "bearer") {
		t.Fatalf("non-bearer OAuth error = %v", err)
	}
}
