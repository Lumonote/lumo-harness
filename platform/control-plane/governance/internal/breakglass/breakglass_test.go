package breakglass

import (
	"errors"
	"testing"
	"time"
)

func TestDualApprovalExpiryAndRevocation(t *testing.T) {
	s := NewStore(); r, err := s.RequestAccess("bg-1", "tenant-a", "operator", "incident", "requester", time.Now().Add(time.Hour)); if err != nil { t.Fatal(err) }
	if _, err = s.Approve(r.ID, "approver-a"); !errors.Is(err, ErrNeedsSecondApprover) { t.Fatalf("first approval err=%v", err) }
	if r, err = s.Approve(r.ID, "approver-b"); err != nil || r.Status != Active { t.Fatalf("activation r=%+v err=%v", r, err) }
	if err = s.Revoke(r.ID, "security", "incident closed"); err != nil { t.Fatal(err) }
	r, _ = s.Get(r.ID); if r.Status != Revoked || len(s.Audit(r.ID)) != 4 { t.Fatalf("r=%+v audit=%v", r, s.Audit(r.ID)) }
}

func TestApprovalCannotBeRequester(t *testing.T) {
	s := NewStore(); r, _ := s.RequestAccess("bg-2", "t", "s", "why", "same", time.Now().Add(time.Hour)); if _, err := s.Approve(r.ID, "same"); !errors.Is(err, ErrNeedsSecondApprover) { t.Fatal(err) }
}
