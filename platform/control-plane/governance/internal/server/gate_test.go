package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

// healthyCluster is the health source a test passes when it wants the gate open.
func healthyCluster() domain.HealthSource {
	return domain.HealthFunc(func() domain.ClusterHealth {
		return domain.ClusterHealth{Known: true, Ready: true, EvaluatedAt: time.Now()}
	})
}

// newTestServer builds a server with an open gate unless the caller says
// otherwise. A construction failure fails the test rather than being returned,
// because it is never the thing under test here.
func newTestServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	if cfg.Health == nil {
		cfg.Health = healthyCluster()
	}
	s, err := New(nil, cfg, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

// mutableHealth lets a test flip readiness between requests, which is how the
// gate's "derived, not snapshotted" property gets exercised.
type mutableHealth struct {
	mu sync.Mutex
	h  domain.ClusterHealth
}

func (m *mutableHealth) Health() domain.ClusterHealth {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.h
}

func (m *mutableHealth) set(h domain.ClusterHealth) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.h = h
}

func TestNewRefusesDeclaredReadyClusterWithoutHealthSource(t *testing.T) {
	if _, err := New(nil, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady}, nil); err == nil {
		t.Fatal("a declared-ready cluster with no health source must refuse to start")
	}
	// The same missing source is fine when the deployment never claimed readiness,
	// otherwise every local run would need to wire a database it does not have.
	if _, err := New(nil, Config{DeploymentMode: domain.ModeStandalone, ClusterStatus: domain.ClusterNotReady}, nil); err != nil {
		t.Fatalf("standalone must not require a health source: %v", err)
	}
}

func TestNonClusterRefusalIsForbiddenAndPermanent(t *testing.T) {
	s := newTestServer(t, Config{DeploymentMode: domain.ModeLocal, ClusterStatus: domain.ClusterReady})
	recorder := httptest.NewRecorder()
	s.requireCluster(recorder)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if recorder.Header().Get("Retry-After") != "" {
		t.Fatal("a permanent refusal must not invite a retry")
	}
	if !strings.Contains(recorder.Body.String(), domain.ErrClusterOnly.Error()) {
		t.Fatalf("body = %s, want %s", recorder.Body.String(), domain.ErrClusterOnly.Error())
	}
}

func TestDegradedClusterRefusalIsUnavailableAndDisclosesTheFault(t *testing.T) {
	health := &mutableHealth{}
	health.set(domain.ClusterHealth{
		Known: true, Ready: false, Reason: "服务未就绪：scheduler、flows",
		Unready: []string{"scheduler", "flows"}, EvaluatedAt: time.Now(),
	})
	s := newTestServer(t, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: health})

	recorder := httptest.NewRecorder()
	s.requireCluster(recorder)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
	if recorder.Header().Get("Retry-After") == "" {
		t.Fatal("a temporary refusal must tell the client when to come back")
	}
	var body struct {
		Error           string   `json:"error"`
		Message         string   `json:"message"`
		UnreadyServices []string `json:"unready_services"`
		EvaluatedAt     string   `json:"evaluated_at"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
	if body.Error != domain.ErrClusterNotReady.Error() {
		t.Fatalf("error = %q, want %q", body.Error, domain.ErrClusterNotReady.Error())
	}
	if len(body.UnreadyServices) != 2 || body.UnreadyServices[0] != "scheduler" {
		t.Fatalf("unready_services = %v, want [scheduler flows]", body.UnreadyServices)
	}
	if body.EvaluatedAt == "" {
		t.Fatal("the response must say when the verdict was taken")
	}
}

// TestGateFollowsHealthWithoutARestart is the point of the whole change: a
// declared-ready cluster that loses a service must stop serving management APIs,
// and must resume on its own once the service comes back.
func TestGateFollowsHealthWithoutARestart(t *testing.T) {
	health := &mutableHealth{}
	health.set(domain.ClusterHealth{Known: true, Ready: false, Reason: "服务未就绪：scheduler", Unready: []string{"scheduler"}, EvaluatedAt: time.Now()})
	s := newTestServer(t, Config{DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady, Health: health})
	mux := http.NewServeMux()
	s.Register(mux)

	call := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/users", nil))
		return recorder
	}

	if got := call().Code; got != http.StatusServiceUnavailable {
		t.Fatalf("degraded status = %d, want 503", got)
	}
	// 401 means the request reached the identity check, i.e. the gate opened.
	health.set(domain.ClusterHealth{Known: true, Ready: true, EvaluatedAt: time.Now()})
	if got := call().Code; got != http.StatusUnauthorized {
		t.Fatalf("recovered status = %d, want 401 (gate open, identity missing)", got)
	}
	health.set(domain.ClusterHealth{})
	if got := call().Code; got != http.StatusServiceUnavailable {
		t.Fatalf("unevaluated status = %d, want 503", got)
	}
}

func TestFeaturesDiscloseWhyTheClusterSurfaceIsClosed(t *testing.T) {
	s := newTestServer(t, Config{
		DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady,
		Health: domain.HealthFunc(func() domain.ClusterHealth {
			return domain.ClusterHealth{Known: true, Ready: false, Reason: "服务未就绪：scheduler",
				Unready: []string{"scheduler"}, EvaluatedAt: time.Now()}
		}),
	})
	recorder := httptest.NewRecorder()
	s.features(recorder, httptest.NewRequest(http.MethodGet, "/v1/features", nil))

	var body domain.Features
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
	if body.ClusterStatus != domain.ClusterDegraded {
		t.Fatalf("cluster_status = %q, want %q", body.ClusterStatus, domain.ClusterDegraded)
	}
	if body.ClusterStatusDeclared != domain.ClusterReady {
		t.Fatalf("declared = %q, want ready preserved for comparison", body.ClusterStatusDeclared)
	}
	if body.ClusterReady {
		t.Fatal("cluster_ready must be false")
	}
	if body.ClusterNotReadyReason == "" || len(body.ClusterUnreadyServices) != 1 {
		t.Fatalf("features must name the fault: %+v", body)
	}
	if body.OrganizationGovernance {
		t.Fatal("capabilities must follow the gate, not the declaration")
	}
}

// TestHealthStaysOKWhileTheClusterIsDegraded guards the liveness endpoint: if it
// failed, an orchestrator would restart governance in a loop exactly when an
// operator needs it to diagnose the cluster.
func TestHealthStaysOKWhileTheClusterIsDegraded(t *testing.T) {
	s := newTestServer(t, Config{
		DeploymentMode: domain.ModeCluster, ClusterStatus: domain.ClusterReady,
		Health: domain.HealthFunc(func() domain.ClusterHealth {
			return domain.ClusterHealth{Known: true, Ready: false, Reason: "x", EvaluatedAt: time.Now()}
		}),
	})
	recorder := httptest.NewRecorder()
	s.health(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `"status":"ok"`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"cluster_ready":false`) {
		t.Fatalf("healthz must still disclose cluster readiness: %s", recorder.Body.String())
	}
}
