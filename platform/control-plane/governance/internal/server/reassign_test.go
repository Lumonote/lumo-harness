package server

import (
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func TestSelectReassignmentCandidateExcludesPriorAndIneligibleWorkers(t *testing.T) {
	candidates := []domain.DelegationCandidate{
		{UserID: "prior", WorkerID: "user:prior", Eligible: true},
		{UserID: "busy", WorkerID: "user:busy", Eligible: false},
		{UserID: "next", WorkerID: "agent:next", Eligible: true},
	}

	chosen := selectReassignmentCandidate(candidates, "user:prior", "", "")
	if chosen == nil || chosen.WorkerID != "agent:next" {
		t.Fatalf("chosen = %#v, want agent:next", chosen)
	}
	if chosen := selectReassignmentCandidate(candidates, "user:prior", "prior", ""); chosen != nil {
		t.Fatalf("prior worker must not be reassignable: %#v", chosen)
	}
	chosen = selectReassignmentCandidate(candidates, "user:prior", "next", "")
	if chosen == nil || chosen.UserID != "next" {
		t.Fatalf("requested candidate = %#v, want next", chosen)
	}
}
