package store

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/storageledger"
)

func (s *Store) initStorageLedger(ctx context.Context) error {
	return storageledger.Initialize(ctx, s.pool, func(tx pgx.Tx) error {
		err := storageledger.Backfill(ctx, tx, `SELECT a.realm,a.project_id,'session-attachment',a.session_ref||'/'||a.receipt_id,a.bytes,a.native_ref->>'attachmentId'
 FROM session_attachment_receipts a WHERE NOT EXISTS(SELECT 1 FROM platform_storage_charges c WHERE c.realm=a.realm AND c.kind='session-attachment' AND c.reference_id=a.session_ref||'/'||a.receipt_id)
 ORDER BY a.realm,a.session_ref,a.receipt_id`)
		if err != nil {
			return err
		}
		if err = storageledger.CompleteCoverage(ctx, tx, "session-attachment"); err != nil {
			return err
		}
		return nil
	})
}
