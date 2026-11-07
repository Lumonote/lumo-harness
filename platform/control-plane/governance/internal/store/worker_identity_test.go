package store

import (
	"context"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

// Human worker IDs use the user: prefix on the wire, while scoring uses human.
// This exercises the real profile aggregator, which resolves every user's skills
// before it can match any worker (including Agents).
func TestHumanWorkerIdentityResolvesThroughProfileAggregation(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	if _, err := s.EffectiveSkillsForWorker(ctx, "realm", "user:employee", ""); err != nil {
		t.Fatal(err)
	}
	profiles, err := s.ListWorkerProfiles(ctx, "realm", "", "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, profile := range profiles {
		if profile.WorkerID == "user:employee" {
			found = true
			if profile.WorkerKind != domain.WorkerHuman {
				t.Fatalf("kind: %q", profile.WorkerKind)
			}
		}
	}
	if !found {
		t.Fatal("employee missing from worker profiles")
	}
}
