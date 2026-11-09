package store

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
)

func claimedRepositoryPublication(t *testing.T, s *Store) (domain.TaskResult, RepositoryPublication) {
	t.Helper()
	ctx := context.Background()
	producer, _ := seedRepositoryRun(t, s)
	recordReviewExecution(t, s, producer)
	repositoryPublisherRole(t, s)
	reviewer, bound := prepareFileReviewer(t, s, producer)
	readEveryFile(t, s, &reviewer, bound)
	recordReviewExecution(t, s, reviewer)
	p, err := s.AuthorizeRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, "manager", false)
	if err != nil {
		t.Fatal(err)
	}
	p, err = s.ClaimRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false)
	if err != nil {
		t.Fatal(err)
	}
	return producer, p
}

func TestRepositoryReconciliationPreservesFenceAndCAS(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	producer, p := claimedRepositoryPublication(t, s)
	read, err := s.PrepareRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, "manager", false)
	if err != nil || read.ID != p.ID || len(read.Changes) != 1 || read.ReconciliationRevision != 0 {
		t.Fatalf("prepare %+v %v", read, err)
	}
	unknown, err := s.RecordRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false, 0, "unknown", "provider_unavailable", "")
	if err != nil || unknown.Status != "publishing" || unknown.Reconciliation != "unknown" || unknown.ReconciliationRevision != 1 || unknown.CheckedAt == nil || len(unknown.Changes) != 0 {
		t.Fatalf("unknown %+v %v", unknown, err)
	}
	if _, err = s.ClaimRepositoryPublication(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("unknown released write fence: %v", err)
	}
	if _, err = s.RecordRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false, 0, "confirmed", "confirmed", "https://github.com/org/repo/pull/1"); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale read overwrote newer observation: %v", err)
	}
	confirmed, err := s.RecordRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false, 1, "confirmed", "confirmed", "https://github.com/org/repo/pull/1")
	if err != nil || confirmed.Status != "draft" || confirmed.Reconciliation != "confirmed" || confirmed.URL != "https://github.com/org/repo/pull/1" {
		t.Fatalf("confirmation %+v %v", confirmed, err)
	}
	if _, err = s.RecordRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false, 2, "confirmed", "confirmed", "https://github.com/org/repo/pull/2"); !errors.Is(err, ErrConflict) {
		t.Fatalf("recorded URL changed: %v", err)
	}
	unknown, err = s.RecordRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, "manager", false, 2, "unknown", "evidence_mismatch", "")
	if err != nil || unknown.URL != confirmed.URL || unknown.Status != "draft" || unknown.Reconciliation != "unknown" {
		t.Fatalf("unknown erased historic URL/fence %+v %v", unknown, err)
	}
	status, err := s.RepositoryPublicationStatus(ctx, "realm", producer.TaskID, producer.RunID, "manager", false)
	if err != nil || status.ReconciliationRevision != 3 || status.Reconciliation != "unknown" || len(status.Changes) != 0 {
		t.Fatalf("status %+v %v", status, err)
	}
	var audits int
	if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id=$1 AND event='repository_publication_reconciled'`, producer.TaskID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 3 {
		t.Fatalf("expected three durable observations, got %d", audits)
	}
}

func TestRepositoryReconciliationRechecksAuthorityAfterExternalReads(t *testing.T) {
	for _, mode := range []string{"revoked-role", "inactive-user", "archived-task", "expired-review", "actor-mismatch", "wrong-url", "corrupt-manifest"} {
		t.Run(mode, func(t *testing.T) {
			s := taskTestStore(t)
			ctx := context.Background()
			producer, p := claimedRepositoryPublication(t, s)
			if _, err := s.PrepareRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, "manager", false); err != nil {
				t.Fatal(err)
			}
			var err error
			actor, url := "manager", "https://github.com/org/repo/pull/1"
			switch mode {
			case "revoked-role":
				_, err = s.pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='manager'`)
			case "inactive-user":
				_, err = s.pool.Exec(ctx, `UPDATE governance_users SET status='disabled' WHERE realm='realm' AND id='manager'`)
			case "archived-task":
				_, err = s.pool.Exec(ctx, `UPDATE governance_delegation_tasks SET business_state='ARCHIVED' WHERE id=$1`, producer.TaskID)
			case "expired-review":
				_, err = s.pool.Exec(ctx, `UPDATE governance_run_reviews SET expires_at=clock_timestamp()-interval '1 second' WHERE producer_run_id=$1`, producer.RunID)
			case "actor-mismatch":
				_, err = s.pool.Exec(ctx, `UPDATE governance_repository_publications SET actor='another-manager' WHERE id=$1::uuid`, p.ID)
			case "wrong-url":
				url = "https://github.com/org/other/pull/1"
			case "corrupt-manifest":
				_, err = s.pool.Exec(ctx, `UPDATE governance_run_output_manifests SET digest=repeat('f',64) WHERE run_id=$1`, producer.RunID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode != "wrong-url" {
				if _, err = s.PrepareRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, "manager", false); err == nil {
					t.Fatal("invalid current authority received an external read permit")
				}
			}
			if _, err = s.RecordRepositoryReconciliation(ctx, "realm", producer.TaskID, producer.RunID, p.ID, p.ManifestDigest, actor, false, 0, "confirmed", "confirmed", url); err == nil {
				t.Fatal("stale authority or forged observation accepted")
			}
			var revision int
			var status string
			if err = s.pool.QueryRow(ctx, `SELECT reconciliation_revision,status FROM governance_repository_publications WHERE id=$1::uuid`, p.ID).Scan(&revision, &status); err != nil || revision != 0 || status != "publishing" {
				t.Fatalf("rejected read changed fence %d %s %v", revision, status, err)
			}
		})
	}
}

func TestRepositoryReconciliationMigrationPreservesClaimedPublication(t *testing.T) {
	s := taskTestStore(t)
	ctx := context.Background()
	_, p := claimedRepositoryPublication(t, s)
	if _, err := s.pool.Exec(ctx, `ALTER TABLE governance_repository_publications DROP COLUMN reconciliation,DROP COLUMN reconciliation_reason,DROP COLUMN reconciliation_revision,DROP COLUMN checked_at`); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../../../deploy/migrations/043_repository_publication_reconciliation.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range []string{string(migration), runRepositoryDDL, string(migration), runRepositoryDDL} {
		if _, err = s.pool.Exec(ctx, ddl); err != nil {
			t.Fatal(err)
		}
	}
	var status, outcome string
	var revision int64
	if err = s.pool.QueryRow(ctx, `SELECT status,reconciliation,reconciliation_revision FROM governance_repository_publications WHERE id=$1::uuid`, p.ID).Scan(&status, &outcome, &revision); err != nil || status != "publishing" || outcome != "" || revision != 0 {
		t.Fatalf("upgrade released claim %s %s %d %v", status, outcome, revision, err)
	}
}
