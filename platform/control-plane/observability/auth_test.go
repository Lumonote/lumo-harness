package observability

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireControlPlaneToken(t *testing.T) {
	handler := RequireControlPlaneToken("test-token")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, test := range []struct {
		name   string
		path   string
		token  string
		status int
	}{
		{name: "missing token", path: "/v1/nodes", status: http.StatusUnauthorized},
		{name: "wrong token", path: "/v1/nodes", token: "wrong", status: http.StatusUnauthorized},
		{name: "valid token", path: "/v1/nodes", token: "test-token", status: http.StatusNoContent},
		{name: "health is public", path: "/healthz", status: http.StatusNoContent},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			if test.token != "" {
				req.Header.Set("Authorization", "Bearer "+test.token)
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			if res.Code != test.status {
				t.Fatalf("status = %d, want %d", res.Code, test.status)
			}
		})
	}
}

func TestRequireControlPlaneTokenFailsClosedWhenUnconfigured(t *testing.T) {
	handler := RequireControlPlaneToken("")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/v1/nodes", nil))
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusServiceUnavailable)
	}
}
