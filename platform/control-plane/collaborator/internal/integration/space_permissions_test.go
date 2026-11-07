package integration_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/server"
)

func TestSpacePermissionsServiceAuthenticationAndCurrentGrants(t *testing.T) {
	st, _ := newPGStore(t)
	api := server.New(nil, st, nil, threadRoundHTTPAuth{}, slog.Default())
	request := func(token, realm, user, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("X-Lumo-Realm", realm)
		r.Header.Set("X-Lumo-User", user)
		w := httptest.NewRecorder()
		api.Routes().ServeHTTP(w, r)
		return w
	}
	path := "/v1/runtime/spaces/shared/permissions"
	roundHTTPStatus(t, request("", "r1", "alice", path), http.StatusServiceUnavailable)
	api.ConfigureSpaceAuthorization("service-secret")
	for _, token := range []string{"", "wrong"} {
		roundHTTPStatus(t, request(token, "r1", "alice", path), http.StatusUnauthorized)
	}
	roundHTTPStatus(t, request("service-secret", "", "alice", path), http.StatusUnauthorized)
	roundHTTPStatus(t, request("service-secret", "r1", "alice", path+"?user_id=bob"), http.StatusBadRequest)
	ctx := context.Background()
	if err := st.Grant(ctx, "shared", "r1", "alice", []domain.Permission{domain.PermRead, domain.PermEdit}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		realm, user string
		want        int
	}{{"r1", "alice", 2}, {"r2", "alice", 0}, {"r1", "bob", 0}} {
		response := request("service-secret", tc.realm, tc.user, path)
		roundHTTPStatus(t, response, http.StatusOK)
		var facts struct {
			Realm       string   `json:"realm"`
			User        string   `json:"user_id"`
			Space       string   `json:"space_id"`
			Permissions []string `json:"permissions"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &facts); err != nil || facts.Realm != tc.realm || facts.User != tc.user || facts.Space != "shared" || len(facts.Permissions) != tc.want || facts.Permissions == nil {
			t.Fatalf("facts: %s, %v", response.Body, err)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("grant response must not be cached")
		}
	}
	if err := st.Grant(ctx, "shared", "r1", "alice", []domain.Permission{}); err != nil {
		t.Fatal(err)
	}
	response := request("service-secret", "r1", "alice", path)
	roundHTTPStatus(t, response, 200)
	var revoked struct {
		Permissions []string `json:"permissions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &revoked); err != nil || len(revoked.Permissions) != 0 {
		t.Fatalf("revocation: %s", response.Body)
	}
}
