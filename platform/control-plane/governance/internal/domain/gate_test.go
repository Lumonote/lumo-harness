package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func healthy() ClusterHealth {
	return ClusterHealth{
		Known: true, Ready: true, EvaluatedAt: time.Date(2026, 9, 14, 8, 30, 0, 0, time.UTC),
	}
}

func TestGateOpensOnlyWhenModeIntentAndHealthAllAgree(t *testing.T) {
	gate := ResolveGate(ModeCluster, ClusterReady, healthy())
	if !gate.Ready {
		t.Fatalf("gate closed for a healthy declared cluster: %+v", gate)
	}
	if gate.Effective != ClusterReady || gate.Intent != ClusterReady {
		t.Fatalf("effective=%q intent=%q, want both ready", gate.Effective, gate.Intent)
	}
	if gate.Reason != "" {
		t.Fatalf("reason = %q, want empty for an open gate", gate.Reason)
	}
	if gate.Unready != nil {
		t.Fatalf("unready = %v, want nil for an open gate", gate.Unready)
	}
	if gate.EvaluatedAt != "2026-09-14T08:30:00Z" {
		t.Fatalf("evaluated_at = %q", gate.EvaluatedAt)
	}
}

// TestGateIsClosedOnEveryOtherCombination is the fail-closed property: the gate
// has exactly one open cell, and every neighbouring cell stays shut. Enumerating
// the space is what catches a future edit that makes, say, a healthy cluster open
// the gate without the operator's declaration.
func TestGateIsClosedOnEveryOtherCombination(t *testing.T) {
	unknown := ClusterHealth{}
	failing := ClusterHealth{Known: true, Ready: false, Reason: "服务未就绪：scheduler",
		Unready: []string{"scheduler"}, EvaluatedAt: time.Now()}

	modes := []DeploymentMode{ModeLocal, ModeStandalone, ModeCluster}
	intents := []string{ClusterReady, ClusterNotReady, "bogus", ""}
	healths := []struct {
		name   string
		health ClusterHealth
	}{{"healthy", healthy()}, {"failing", failing}, {"unknown", unknown}}

	for _, mode := range modes {
		for _, intent := range intents {
			for _, h := range healths {
				gate := ResolveGate(mode, intent, h.health)
				wantOpen := mode == ModeCluster && intent == ClusterReady && h.name == "healthy"
				if gate.Ready != wantOpen {
					t.Fatalf("mode=%q intent=%q health=%s: ready=%v, want %v",
						mode, intent, h.name, gate.Ready, wantOpen)
				}
				if !wantOpen && gate.Reason == "" {
					t.Fatalf("mode=%q intent=%q health=%s: closed gate without a reason",
						mode, intent, h.name)
				}
			}
		}
	}
}

func TestGateReportsDegradedRatherThanNotReadyWhenIntentWasReady(t *testing.T) {
	gate := ResolveGate(ModeCluster, ClusterReady, ClusterHealth{
		Known: true, Ready: false, Reason: "服务未就绪：scheduler、flows",
		Unready: []string{"scheduler", "flows"}, EvaluatedAt: time.Now(),
	})
	if gate.Ready {
		t.Fatal("degraded cluster must not open the gate")
	}
	if gate.Effective != ClusterDegraded {
		t.Fatalf("effective = %q, want %q", gate.Effective, ClusterDegraded)
	}
	if gate.Intent != ClusterReady {
		t.Fatalf("intent = %q, want the declaration preserved", gate.Intent)
	}
	if gate.Reason != "服务未就绪：scheduler、flows" {
		t.Fatalf("reason = %q, want the health reason propagated", gate.Reason)
	}
	if len(gate.Unready) != 2 || gate.Unready[0] != "scheduler" {
		t.Fatalf("unready = %v, want [scheduler flows]", gate.Unready)
	}
}

func TestGateIsDegradedWhenHealthWasNeverEvaluated(t *testing.T) {
	gate := ResolveGate(ModeCluster, ClusterReady, ClusterHealth{})
	if gate.Ready || gate.Effective != ClusterDegraded {
		t.Fatalf("unevaluated health must be degraded, got %+v", gate)
	}
	if !strings.Contains(gate.Reason, "还没有就绪态求值结果") {
		t.Fatalf("reason = %q, want it to say readiness was never evaluated", gate.Reason)
	}
	if gate.EvaluatedAt != "" {
		t.Fatalf("evaluated_at = %q, want empty when there was no evaluation", gate.EvaluatedAt)
	}
}

// TestGateNeverEchoesAReadyStatusWithoutHealth pins the specific confusion the
// split exists to remove: a payload must never carry cluster_status=ready next
// to cluster_ready=false.
func TestGateNeverEchoesAReadyStatusWithoutHealth(t *testing.T) {
	for _, mode := range []DeploymentMode{ModeLocal, ModeStandalone, ModeCluster} {
		for _, intent := range []string{ClusterReady, ClusterNotReady} {
			for _, health := range []ClusterHealth{{}, healthy(), {Known: true, Ready: false, Reason: "x"}} {
				gate := ResolveGate(mode, intent, health)
				if !gate.Ready && gate.Effective == ClusterReady {
					t.Fatalf("mode=%q intent=%q: closed gate reported effective=%q",
						mode, intent, gate.Effective)
				}
				if gate.Ready && gate.Effective != ClusterReady {
					t.Fatalf("mode=%q intent=%q: open gate reported effective=%q",
						mode, intent, gate.Effective)
				}
			}
		}
	}
}

func TestGateNormalisesEvaluatedAtToUTC(t *testing.T) {
	shanghai := time.FixedZone("CST", 8*3600)
	gate := ResolveGate(ModeCluster, ClusterReady, ClusterHealth{
		Known: true, Ready: true, EvaluatedAt: time.Date(2026, 9, 14, 16, 30, 0, 0, shanghai),
	})
	if gate.EvaluatedAt != "2026-09-14T08:30:00Z" {
		t.Fatalf("evaluated_at = %q, want UTC", gate.EvaluatedAt)
	}
}

func TestIntentIsClusterIgnoresHealth(t *testing.T) {
	// Startup validation and the login path ask "is this deployment configured as
	// a cluster", which must not depend on whether the cluster is currently well.
	if !IntentIsCluster(ModeCluster, ClusterReady) {
		t.Fatal("declared ready cluster must be a cluster regardless of health")
	}
	for _, tc := range []struct {
		mode   DeploymentMode
		intent string
	}{
		{ModeLocal, ClusterReady},
		{ModeStandalone, ClusterReady},
		{ModeCluster, ClusterNotReady},
		{ModeCluster, ""},
		{ModeCluster, "bogus"},
	} {
		if IntentIsCluster(tc.mode, tc.intent) {
			t.Fatalf("mode=%q intent=%q reported as a declared ready cluster", tc.mode, tc.intent)
		}
	}
}

func TestFeaturesMirrorTheGate(t *testing.T) {
	closed := NewFeatures(ResolveGate(ModeStandalone, ClusterReady, healthy()))
	if closed.OrganizationGovernance || closed.SkillDistribution || closed.DesktopWorkers ||
		closed.ArtifactRollouts || closed.CrossNodeDelegation {
		t.Fatalf("closed gate exposed capabilities: %+v", closed)
	}
	if closed.ClusterReady || closed.ClusterStatus != ClusterNotReady {
		t.Fatalf("closed gate features = %+v", closed)
	}
	if closed.ClusterStatusDeclared != ClusterReady {
		t.Fatalf("declared = %q, want the operator's declaration preserved", closed.ClusterStatusDeclared)
	}
	if closed.ClusterNotReadyReason == "" {
		t.Fatal("closed gate must disclose why")
	}

	open := NewFeatures(ResolveGate(ModeCluster, ClusterReady, healthy()))
	if !open.OrganizationGovernance || !open.SkillDistribution || !open.DesktopWorkers ||
		!open.ArtifactRollouts || !open.CrossNodeDelegation {
		t.Fatalf("open gate withheld capabilities: %+v", open)
	}
	if !open.ClusterReady || open.ClusterStatus != ClusterReady {
		t.Fatalf("open gate features = %+v", open)
	}
}

func TestFeaturesJSONOmitsAbsentGateDetails(t *testing.T) {
	body, err := json.Marshal(NewFeatures(ResolveGate(ModeCluster, ClusterReady, healthy())))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, absent := range []string{"cluster_not_ready_reason", "cluster_unready_services"} {
		if strings.Contains(string(body), absent) {
			t.Fatalf("healthy features must omit %s: %s", absent, body)
		}
	}
	if !strings.Contains(string(body), `"cluster_readiness_evaluated_at":"2026-09-14T08:30:00Z"`) {
		t.Fatalf("healthy features must carry the evaluation time: %s", body)
	}

	degraded, err := json.Marshal(NewFeatures(ResolveGate(ModeCluster, ClusterReady, ClusterHealth{
		Known: true, Ready: false, Reason: "服务未就绪：scheduler",
		Unready: []string{"scheduler"}, EvaluatedAt: time.Now(),
	})))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, present := range []string{"cluster_not_ready_reason", "cluster_unready_services", `"cluster_ready":false`} {
		if !strings.Contains(string(degraded), present) {
			t.Fatalf("degraded features must include %s: %s", present, degraded)
		}
	}
}
