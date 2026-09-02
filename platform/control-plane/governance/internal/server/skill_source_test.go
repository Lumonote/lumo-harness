package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestRequireSkillSourceAccessRestrictsPrivateSourceToAuthorOrAdmin(t *testing.T) {
	skill := domain.Skill{CreatedBy: "author"}
	for _, tc := range []struct {
		name    string
		caller  caller
		allowed bool
	}{
		{name: "author", caller: caller{userID: "author"}, allowed: true},
		{name: "realm admin", caller: caller{userID: "operator", roles: map[string]bool{"realm_admin": true}}, allowed: true},
		{name: "other user", caller: caller{userID: "reader"}, allowed: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			if got := requireSkillSourceAccess(recorder, tc.caller, skill); got != tc.allowed {
				t.Fatalf("allowed = %v, want %v", got, tc.allowed)
			}
			if !tc.allowed && recorder.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
			}
		})
	}
}

func TestPublishSkillVersionRouteRequiresRealmAdmin(t *testing.T) {
	s := New(nil, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, nil)
	mux := http.NewServeMux()
	s.Register(mux)

	for _, tc := range []struct {
		name    string
		headers map[string]string
		want    int
	}{
		{name: "missing identity", want: http.StatusUnauthorized},
		{name: "author is not enough", headers: map[string]string{"X-Lumo-User": "author", "X-Lumo-Realm": "dev"}, want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/skills/review/versions/1.0.0/publish", nil)
			for key, value := range tc.headers {
				req.Header.Set(key, value)
			}
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, req)
			if recorder.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}
}

func TestRuntimeSkillSnapshotRouteRequiresRealmAdmin(t *testing.T) {
	s := New(nil, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, nil)
	mux := http.NewServeMux()
	s.Register(mux)
	for _, tc := range []struct {
		name    string
		headers map[string]string
		want    int
	}{
		{name: "missing identity", want: http.StatusUnauthorized},
		{name: "author is not enough", headers: map[string]string{"X-Lumo-User": "author", "X-Lumo-Realm": "dev"}, want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/skills/runtime-snapshot", nil)
			for key, value := range tc.headers {
				req.Header.Set(key, value)
			}
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, req)
			if recorder.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}
}
