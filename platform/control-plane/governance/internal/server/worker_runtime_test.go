package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestWorkerRuntimeRequiresServiceCredential(t *testing.T) {
	mux := http.NewServeMux()
	New(nil, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: "ready", ControlPlaneToken: "runtime-service-token"}, nil).Register(mux)
	for _, path := range []string{"/v1/workers/agent:one/runtime", "/v1/runtime/agent-presets/one"} {
		method := http.MethodPut
		if strings.Contains(path, "agent-presets") {
			method = http.MethodGet
		}
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("X-Lumo-Realm", "r1")
		req.Header.Set("X-Lumo-Roles", "admin")
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d", path, res.Code)
		}
		req.Header.Set("Authorization", "Bearer runtime-service-token")
		req.Header.Del("X-Lumo-Realm")
		res = httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("missing realm %s: got %d", path, res.Code)
		}
	}
}
