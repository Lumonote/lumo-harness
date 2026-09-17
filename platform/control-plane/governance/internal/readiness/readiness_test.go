package readiness

import (
	"testing"
	"time"

	"github.com/lumo-harness/platform/heartbeat"
)

type stubSnapshotter struct {
	snapshot heartbeat.Snapshot
}

func (s stubSnapshotter) Snapshot() heartbeat.Snapshot { return s.snapshot }

func TestHealthReportsAnUnevaluatedSnapshotAsUnknown(t *testing.T) {
	health := New(stubSnapshotter{}).Health()
	if health.Known {
		t.Fatal("a watcher that never evaluated must report unknown, not not-ready")
	}
	if health.Ready {
		t.Fatal("unknown must not be ready")
	}
}

func TestHealthRenamesTheSnapshotFields(t *testing.T) {
	evaluated := time.Date(2026, 9, 14, 8, 30, 0, 0, time.UTC)
	health := New(stubSnapshotter{snapshot: heartbeat.Snapshot{
		Ready:        false,
		Reason:       "服务未就绪：scheduler",
		Unhealthy:    []string{"scheduler", "flows"},
		EvaluatedAt:  evaluated,
		Err:          "boom",
		Stale:        true,
		Services:     []heartbeat.ServiceState{{Service: "scheduler"}},
		Dependencies: map[string]string{"postgres": heartbeat.DependencyOK},
	}}).Health()

	if !health.Known {
		t.Fatal("a snapshot that was taken is a known verdict even when negative")
	}
	if health.Ready {
		t.Fatal("a stale failed snapshot must stay closed through the adapter")
	}
	if health.Reason != "服务未就绪：scheduler" {
		t.Fatalf("reason = %q", health.Reason)
	}
	if len(health.Unready) != 2 || health.Unready[0] != "scheduler" {
		t.Fatalf("unready = %v, want the unhealthy services", health.Unready)
	}
	if !health.EvaluatedAt.Equal(evaluated) {
		t.Fatalf("evaluated_at = %s", health.EvaluatedAt)
	}
}

func TestHealthCarriesAPositiveVerdict(t *testing.T) {
	health := New(stubSnapshotter{snapshot: heartbeat.Snapshot{
		Ready: true, EvaluatedAt: time.Now(),
	}}).Health()
	if !health.Known || !health.Ready {
		t.Fatalf("health = %+v, want known and ready", health)
	}
	if health.Reason != "" || len(health.Unready) != 0 {
		t.Fatalf("a ready verdict must carry no fault details: %+v", health)
	}
}
