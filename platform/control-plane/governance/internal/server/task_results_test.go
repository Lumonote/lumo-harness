package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestExecutionReportsCannotPerformRequesterReview(t *testing.T) {
	for _, event := range []string{"complete", "reject", "archive", "reroute", "assign", "unknown"} {
		if executionBusinessEvent(event) {
			t.Fatalf("execution reporter can submit %q", event)
		}
	}
	for _, event := range []string{"complete", "reject", "archive"} {
		if !requiresRequesterReview(event) {
			t.Fatalf("missing requester authorization for %q", event)
		}
	}
}

func TestCollaborationRoutesRequireClusterAndIdentity(t *testing.T) {
	for _, mode := range []string{"local", "cluster"} {
		api := newTestServer(t, Config{DeploymentMode: domain.DeploymentMode(mode), ClusterStatus: "ready"})
		mux := http.NewServeMux()
		api.Register(mux)
		for _, route := range []struct{ method, path string }{
			{http.MethodGet, "/v1/tasks/task/collaboration"},
			{http.MethodGet, "/v1/tasks/task/runs/run/result"},
			{http.MethodPut, "/v1/tasks/task/runs/run/result"},
		} {
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(route.method, route.path, nil))
			want := http.StatusForbidden
			if mode == "cluster" {
				want = http.StatusUnauthorized
			}
			if response.Code != want {
				t.Fatalf("%s %s: got %d, want %d", mode, route.path, response.Code, want)
			}
		}
	}
}
