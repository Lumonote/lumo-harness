package observability

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestMiddlewareExportsRequestAndErrorCounters(t *testing.T) {
	m := &Metrics{}
	h := m.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))

	rec := httptest.NewRecorder()
	m.Write(rec)
	body := rec.Body.String()
	for _, metric := range []string{
		"lumo_http_requests_total 1",
		"lumo_http_errors_total 1",
		"lumo_http_inflight 0",
		"# TYPE lumo_http_request_duration_seconds histogram",
		"lumo_http_request_duration_seconds_count 1",
	} {
		if !strings.Contains(body, metric) {
			t.Fatalf("metrics missing %q in %s", metric, body)
		}
	}
}

func TestMiddlewareUsesConfiguredCORSOrigin(t *testing.T) {
	t.Setenv("LUMO_CORS_ORIGIN", "http://console.example")
	h := (&Metrics{}).Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://console.example" {
		t.Fatalf("origin = %q", got)
	}

	preflight := httptest.NewRecorder()
	h.ServeHTTP(preflight, httptest.NewRequest(http.MethodOptions, "/v1/projects", nil))
	if preflight.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", preflight.Code)
	}
	if got := os.Getenv("LUMO_CORS_ORIGIN"); got != "http://console.example" {
		t.Fatalf("test environment unexpectedly changed: %q", got)
	}
}
