package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/store"
	"github.com/lumo-harness/platform/observability"
)

func TestReviewFileBusinessErrorsKeepClosedVocabulary(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want observability.BusinessOutcome
	}{
		{nil, observability.BusinessSuccess},
		{errors.Join(errors.New("private-review-file"), store.ErrForbidden), observability.BusinessDenied},
		{store.ErrBadRequest, observability.BusinessInvalid},
		{store.ErrNotFound, observability.BusinessNotFound},
		{store.ErrConflict, observability.BusinessConflict},
		{errors.New("db-private-realm"), observability.BusinessUnavailable},
	} {
		if got := reviewFileBusinessOutcome(tc.err); got != tc.want {
			t.Fatalf("%v: got %s want %s", tc.err, got, tc.want)
		}
	}
}

func TestReviewFileUnavailableIsRecordedAtActualReadHandler(t *testing.T) {
	previous := observability.Default
	observability.Default = &observability.Metrics{}
	t.Cleanup(func() { observability.Default = previous })
	(&Server{}).registerRunReviewRoutes(http.NewServeMux())
	initial := httptest.NewRecorder()
	observability.Default.Write(initial)
	if !strings.Contains(initial.Body.String(), `lumo_business_requests_total{operation="review_file_read",outcome="unavailable"} 0`) {
		t.Fatalf("startup did not publish the initial file-read baseline: %s", initial.Body)
	}
	for _, tc := range []struct {
		cfg    Config
		status int
	}{
		{Config{}, 403},
		{Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, 503},
		{Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: healthyCluster()}, 401},
	} {
		s := &Server{cfg: tc.cfg}
		w := httptest.NewRecorder()
		s.readRunReviewFile(w, httptest.NewRequest("GET", "/private-file", nil))
		if w.Code != tc.status {
			t.Fatalf("gate/identity response changed: %d expected %d", w.Code, tc.status)
		}
	}
	metrics := httptest.NewRecorder()
	observability.Default.Write(metrics)
	if !strings.Contains(metrics.Body.String(), `lumo_business_requests_total{operation="review_file_read",outcome="unavailable"} 1`) || strings.Contains(metrics.Body.String(), "private-file") {
		t.Fatalf("read metric missing or has request identity: %s", metrics.Body)
	}
	if !strings.Contains(metrics.Body.String(), `lumo_business_requests_total{operation="review_file_read",outcome="denied"} 2`) {
		t.Fatalf("permanent gate/identity denials counted as an outage: %s", metrics.Body)
	}
}
