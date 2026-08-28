package ownership

import (
	"testing"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

func TestRingEmptyModeIsSafeWhenMarkedReady(t *testing.T) {
	ring := NewRing("collaborator-a")
	if !ring.IsMine(domain.DocumentID("doc-1")) {
		t.Fatal("cold-start ring should preserve standalone availability")
	}
	ring.MarkReady()
	if ring.IsMine(domain.DocumentID("doc-1")) {
		t.Fatal("registry-driven empty ring must not allow split-brain ownership")
	}
}

func TestRingAssignsExactlyOneOwner(t *testing.T) {
	ring := NewRing("collaborator-a")
	ring.SetInstances([]string{"collaborator-a", "collaborator-b"})
	owner := ring.OwnerOf(domain.DocumentID("doc-1"))
	if owner != "collaborator-a" && owner != "collaborator-b" {
		t.Fatalf("unexpected owner %q", owner)
	}
}
