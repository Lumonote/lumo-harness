package server

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/connector-gateway/internal/owned"
	"github.com/lumo-harness/platform/observability"
)

func TestOwnedConnectorRejectionsProduceBoundedMetrics(t *testing.T) {
	previous := observability.Default
	observability.Default = &observability.Metrics{}
	t.Cleanup(func() { observability.Default = previous })
	(&Server{}).Routes()
	initial := httptest.NewRecorder()
	observability.Default.Write(initial)
	if !strings.Contains(initial.Body.String(), `lumo_business_requests_total{operation="connector_invoke",outcome="unknown"} 0`) {
		t.Fatalf("startup did not publish the initial invocation baseline: %s", initial.Body)
	}
	for _, tc := range []struct {
		err    error
		status int
	}{
		{owned.ErrDenied, 403}, {owned.ErrChanged, 409}, {errors.New("private-receipt"), 503},
	} {
		w := httptest.NewRecorder()
		ownedError(w, tc.err)
		if w.Code != tc.status {
			t.Fatalf("error semantics changed: %d", w.Code)
		}
	}
	metrics := httptest.NewRecorder()
	observability.Default.Write(metrics)
	for _, outcome := range []string{"denied", "conflict", "unavailable"} {
		if !strings.Contains(metrics.Body.String(), `lumo_business_requests_total{operation="connector_request",outcome="`+outcome+`"} 1`) {
			t.Fatalf("missing rejection metric: %s", metrics.Body)
		}
	}
	if strings.Contains(metrics.Body.String(), "private-receipt") {
		t.Fatal("error text used as metric label")
	}
}
