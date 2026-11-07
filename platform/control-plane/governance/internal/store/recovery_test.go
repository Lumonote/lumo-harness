package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	bg "github.com/lumo-harness/platform/governance/internal/breakglass"
)

func recoveryStore(t *testing.T) *Store {
	t.Helper()
	s := taskTestStore(t)
	seedRolePolicyAdmin(t, s)
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by) VALUES('realm','employee','realm_admin','manager')`); err != nil {
		t.Fatal(err)
	}
	return s
}
func newRecovery(t *testing.T, s *Store) bg.DurableRequest {
	t.Helper()
	r, err := s.CreateRecovery(context.Background(), bg.DurableRequest{Realm: "realm", Target: bg.Target{Operation: bg.Restore, Namespace: "backups", TargetID: "tenant-a/db", RecoveryPoint: "snapshot-1"}, Reason: "incident restore", RequestedBy: "manager", ExpiresAt: time.Now().Add(time.Hour), ProviderID: "mock", PolicyDigest: strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func approveRecovery(t *testing.T, s *Store, r bg.DurableRequest) bg.DurableRequest {
	t.Helper()
	r, err := s.ChangeRecovery(context.Background(), r.Realm, r.ID, "employee", "approve", r.Revision)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func claimRecovery(t *testing.T, s *Store, r bg.DurableRequest, mode string) RecoveryClaim {
	t.Helper()
	claim, err := s.ClaimRecovery(context.Background(), r.Realm, r.ID, "manager", r.Revision, r.ProviderID, r.PolicyDigest, mode)
	if err != nil {
		t.Fatal(err)
	}
	return claim
}
func claimReceipt(claim RecoveryClaim, outcome string) *bg.Receipt {
	return &bg.Receipt{Execution: claim.Request.Execution(claim.Mode), Outcome: outcome, ReceiptID: "receipt-test", CompletedAt: time.Now().UTC(), Signature: "test-only-store-receipt"}
}

func TestRecoveryPersistentDualControlOneTimeExecutionAndAudit(t *testing.T) {
	s := recoveryStore(t)
	ctx := context.Background()
	r := newRecovery(t, s)
	if r.Digest() != r.RequestDigest || r.Revision != 1 || r.Status != bg.Awaiting {
		t.Fatalf("immutable facts: %+v", r)
	}
	if _, err := s.ChangeRecovery(ctx, r.Realm, r.ID, "manager", "approve", 1); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("self approval accepted: %v", err)
	}
	r = approveRecovery(t, s, r)
	if _, err := s.ClaimRecovery(ctx, r.Realm, r.ID, "employee", r.Revision, r.ProviderID, r.PolicyDigest, "execute"); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("approver executed: %v", err)
	}
	claim := claimRecovery(t, s, r, "execute")
	if _, err := s.ClaimRecovery(ctx, r.Realm, r.ID, "manager", claim.Request.Revision, r.ProviderID, r.PolicyDigest, "execute"); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("parallel execution accepted: %v", err)
	}
	done, err := s.FinishRecovery(ctx, claim, claimReceipt(claim, "succeeded"), "")
	if err != nil || done.Status != bg.Succeeded {
		t.Fatalf("finish %+v %v", done, err)
	}
	// Restarted service/store can return the stored result without another claim.
	replay, err := New(s.pool).ClaimRecovery(ctx, r.Realm, r.ID, "manager", 1, r.ProviderID, r.PolicyDigest, "execute")
	if err != nil || !replay.Replayed || replay.Request.Revision != done.Revision || replay.Token != "" {
		t.Fatalf("non-idempotent replay: %+v %v", replay, err)
	}
	read, audit, err := New(s.pool).GetRecovery(ctx, r.Realm, r.ID, "employee")
	if err != nil || read.RequestDigest != r.RequestDigest || len(audit) != 4 {
		t.Fatalf("durability/audit: %+v %+v %v", read, audit, err)
	}
	for i, event := range []string{"requested", "approved", "claimed", "succeeded"} {
		if audit[i].Event != event || audit[i].Revision != int64(i+1) {
			t.Fatalf("audit gap: %+v", audit)
		}
	}
	if _, _, err = s.GetRecovery(ctx, "foreign", r.ID, "manager"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-realm request read: %v", err)
	}
	if _, err = s.ChangeRecovery(ctx, r.Realm, r.ID, "manager", "revoke", done.Revision); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("completed request revoked: %v", err)
	}
}

func TestRecoveryConcurrentCASClaimFencingAndUnknownOutcome(t *testing.T) {
	s := recoveryStore(t)
	ctx := context.Background()
	r := newRecovery(t, s)
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.ChangeRecovery(ctx, r.Realm, r.ID, "employee", "approve", 1)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, changed := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrRecoveryChanged) {
			changed++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || changed != 1 {
		t.Fatalf("approval CAS winners=%d changed=%d", success, changed)
	}
	r, _, _ = s.GetRecovery(ctx, r.Realm, r.ID, "manager")
	old := claimRecovery(t, s, r, "execute")
	if _, err := s.pool.Exec(ctx, `UPDATE governance_recovery_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE realm=$1 AND id=$2`, r.Realm, r.ID); err != nil {
		t.Fatal(err)
	}
	newer := claimRecovery(t, s, old.Request, "execute")
	if newer.Request.FencingToken != old.Request.FencingToken+1 || newer.Request.ExecutionID != old.Request.ExecutionID || newer.Request.RequestDigest != old.Request.RequestDigest {
		t.Fatal("fencing must advance while immutable identity stays stable")
	}
	if _, err := s.FinishRecovery(ctx, old, claimReceipt(old, "succeeded"), ""); !errors.Is(err, ErrRecoveryClaim) {
		t.Fatalf("stale executor overwrote newer claim: %v", err)
	}
	uncertain, err := s.FinishRecovery(ctx, newer, nil, "upstream error containing secret")
	if err != nil || uncertain.Status != bg.Uncertain || uncertain.LastError != "provider_unavailable" {
		t.Fatalf("unknown outcome leaked or fabricated success: %+v %v", uncertain, err)
	}
	if _, err = s.ChangeRecovery(ctx, r.Realm, r.ID, "manager", "revoke", uncertain.Revision); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("unknown external result falsely revoked: %v", err)
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_recovery_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE realm=$1 AND id=$2`, r.Realm, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ClaimRecovery(ctx, r.Realm, r.ID, "manager", uncertain.Revision, r.ProviderID, r.PolicyDigest, "execute"); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("expired unknown request sent new execution: %v", err)
	}
	reconcile := claimRecovery(t, s, uncertain, "receipt")
	if reconcile.Request.ExecutionID != old.Request.ExecutionID {
		t.Fatal("receipt lookup changed idempotency identity")
	}
	done, err := s.FinishRecovery(ctx, reconcile, claimReceipt(reconcile, "succeeded"), "")
	if err != nil || done.Status != bg.Succeeded {
		t.Fatalf("receipt did not resolve unknown outcome: %+v %v", done, err)
	}
}

func TestRecoveryExpiryRevocationAndDeploymentPolicyChange(t *testing.T) {
	s := recoveryStore(t)
	ctx := context.Background()
	r := newRecovery(t, s)
	if _, err := s.pool.Exec(ctx, `UPDATE governance_recovery_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE realm=$1 AND id=$2`, r.Realm, r.ID); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListRecoveries(ctx, r.Realm, "manager")
	if err != nil || len(list) != 1 || list[0].Status != bg.WorkflowExpired {
		t.Fatalf("expiry not persisted: %+v %v", list, err)
	}
	_, audit, err := s.GetRecovery(ctx, r.Realm, r.ID, "manager")
	if err != nil || len(audit) != 2 || audit[1].Event != "expired" {
		t.Fatalf("expiry audit duplicate/missing: %+v %v", audit, err)
	}
	r = approveRecovery(t, s, newRecovery(t, s))
	if _, err = s.ClaimRecovery(ctx, r.Realm, r.ID, "manager", r.Revision, "changed", r.PolicyDigest, "execute"); !errors.Is(err, ErrRecoveryChanged) {
		t.Fatalf("provider substitution accepted: %v", err)
	}
	claim := claimRecovery(t, s, r, "execute")
	failed, err := s.FinishRecovery(ctx, claim, claimReceipt(claim, "rejected"), "")
	if err != nil || failed.Status != bg.Failed {
		t.Fatalf("verified rejection: %+v %v", failed, err)
	}
	revoked, err := s.ChangeRecovery(ctx, r.Realm, r.ID, "manager", "revoke", failed.Revision)
	if err != nil || revoked.Status != bg.WorkflowRevoked {
		t.Fatalf("safe revoke: %+v %v", revoked, err)
	}
	if _, err = s.ClaimRecovery(ctx, r.Realm, r.ID, "manager", revoked.Revision, r.ProviderID, r.PolicyDigest, "execute"); !errors.Is(err, ErrRecoveryState) {
		t.Fatalf("revoked request executed: %v", err)
	}
}

func TestRecoveryRevalidatesApproversAndActorAfterOrganizationLock(t *testing.T) {
	s := recoveryStore(t)
	ctx := context.Background()
	r := approveRecovery(t, s, newRecovery(t, s))
	blocker, err := s.beginOrganizationChange(ctx, r.Realm)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	result := make(chan error, 1)
	go func() {
		_, err := s.ClaimRecovery(ctx, r.Realm, r.ID, "manager", r.Revision, r.ProviderID, r.PolicyDigest, "execute")
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("bypassed realm lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if _, err = blocker.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='employee'`); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("revoked approval executed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("claim stuck")
	}
	if _, err = s.pool.Exec(ctx, `UPDATE governance_users SET status='disabled' WHERE realm='realm' AND id='manager'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.GetRecovery(ctx, r.Realm, r.ID, "manager"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("disabled directory administrator retained access: %v", err)
	}
}

func TestRecoveryReceiptReconciliationSurvivesHistoricalApprovalRevocation(t *testing.T) {
	s := recoveryStore(t)
	ctx := context.Background()
	r := approveRecovery(t, s, newRecovery(t, s))
	claim := claimRecovery(t, s, r, "execute")
	unknown, err := s.FinishRecovery(ctx, claim, nil, "provider_unavailable")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='manager'`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ClaimRecovery(ctx, r.Realm, r.ID, "employee", unknown.Revision, r.ProviderID, r.PolicyDigest, "execute"); err == nil {
		t.Fatal("approver was allowed to execute after requester revocation")
	}
	// Querying a receipt has no external side effect. A current direct admin,
	// including the original approver, can resolve a previously dispatched call.
	reconcile, err := s.ClaimRecovery(ctx, r.Realm, r.ID, "employee", unknown.Revision, r.ProviderID, r.PolicyDigest, "receipt")
	if err != nil {
		t.Fatal(err)
	}
	done, err := s.FinishRecovery(ctx, reconcile, claimReceipt(reconcile, "succeeded"), "")
	if err != nil || done.Status != bg.Succeeded || done.ExecutedBy != "manager" {
		t.Fatalf("receipt reconciliation changed original executor: %+v %v", done, err)
	}
	_, audit, err := s.GetRecovery(ctx, r.Realm, r.ID, "employee")
	if err != nil || audit[len(audit)-1].Actor != "employee" {
		t.Fatalf("reconciling administrator missing from audit: %+v %v", audit, err)
	}
}
