package store

import (
	"context"
	"errors"
	"github.com/lumo-harness/platform/storageledger"
	"testing"
)

func TestAttachmentQuotaFailureRollsBackReceiptAndSurvivesRestart(t *testing.T) {
	s, o, in := attachmentFixture(t)
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `INSERT INTO platform_storage_limits(realm,scope,scope_id,limit_bytes) VALUES('r','realm','',5)`); err != nil {
		t.Fatal(err)
	}
	in.Operation = "create"
	in.Receipt = textAttachment()
	if _, err := s.SessionAttachments(ctx, o.SessionRef, in); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionAttachments(ctx, o.SessionRef, in); !errors.Is(err, storageledger.ErrQuota) {
		t.Fatalf("expected quota: %v", err)
	}
	var receipts, charges int
	if err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_attachment_receipts),(SELECT count(*) FROM platform_storage_charges)`).Scan(&receipts, &charges); err != nil || receipts != 1 || charges != 1 {
		t.Fatalf("non-atomic receipt %d charges %d: %v", receipts, charges, err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM platform_storage_charges`); err != nil {
		t.Fatal(err)
	}
	if err := New(s.pool).initStorageLedger(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionAttachments(ctx, o.SessionRef, in); !errors.Is(err, storageledger.ErrQuota) {
		t.Fatalf("backfill hidden: %v", err)
	}
}
