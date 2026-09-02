package store

import (
	"fmt"
	"testing"
)

func TestSelectRolloutVersionUsesStableMonotonicCohorts(t *testing.T) {
	base := Rollout{Channel: "stable", Name: "demo-skill", Version: "2.0.0", PreviousVersion: "1.0.0", Percent: 25}
	var targetNode, holdbackNode string
	for i := 0; i < 10_000 && (targetNode == "" || holdbackNode == ""); i++ {
		nodeID := fmt.Sprintf("node-%d", i)
		version, cohort, err := SelectRolloutVersion(base, nodeID)
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case version == base.Version && cohort == "target":
			targetNode = nodeID
		case version == base.PreviousVersion && cohort == "holdback":
			holdbackNode = nodeID
		}
	}
	if targetNode == "" || holdbackNode == "" {
		t.Fatalf("failed to find both cohorts: target=%q holdback=%q", targetNode, holdbackNode)
	}

	for _, nodeID := range []string{targetNode, holdbackNode} {
		firstVersion, firstCohort, err := SelectRolloutVersion(base, nodeID)
		if err != nil {
			t.Fatal(err)
		}
		secondVersion, secondCohort, err := SelectRolloutVersion(base, nodeID)
		if err != nil || firstVersion != secondVersion || firstCohort != secondCohort {
			t.Fatalf("selection must be stable for %s: first=%s/%s second=%s/%s err=%v", nodeID, firstVersion, firstCohort, secondVersion, secondCohort, err)
		}
	}

	wider := base
	wider.Percent = 50
	version, cohort, err := SelectRolloutVersion(wider, targetNode)
	if err != nil || version != wider.Version || cohort != "target" {
		t.Fatalf("target node moved out while increasing percent: version=%q cohort=%q err=%v", version, cohort, err)
	}
}

func TestSelectRolloutVersionRequiresHoldbackForPartialRelease(t *testing.T) {
	_, _, err := SelectRolloutVersion(Rollout{Channel: "stable", Name: "demo-skill", Version: "2.0.0", Percent: 10}, "node-1")
	if err == nil {
		t.Fatal("partial rollout without holdback succeeded")
	}

	rollout := Rollout{Channel: "stable", Name: "demo-skill", Version: "2.0.0", PreviousVersion: "1.0.0", Percent: 0}
	version, cohort, err := SelectRolloutVersion(rollout, "node-1")
	if err != nil || version != "1.0.0" || cohort != "holdback" {
		t.Fatalf("zero-percent rollback = %q/%q, %v", version, cohort, err)
	}
}
