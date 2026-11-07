package ownership

import (
	"testing"
	"time"

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

func TestDiscoveryStalenessClosesOwnershipButStaticPeersRemainValid(t *testing.T) {
	ring := NewRing("A")
	ring.SetInstances([]string{"A"})
	ring.lastSync.Store(time.Now().Add(-11 * time.Second).UnixNano())
	if !ring.IsMine("doc") {
		t.Fatal("static peers should not expire")
	}
	ring.MarkReady()
	if ring.IsMine("doc") {
		t.Fatal("stale discovery must stop writes")
	}
	ring.SetInstances([]string{"A"})
	if !ring.IsMine("doc") {
		t.Fatal("fresh discovery should restore routing eligibility")
	}
}
