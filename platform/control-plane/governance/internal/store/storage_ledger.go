package store

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/storageledger"
)

const storageQuotaAuditDDL = `
ALTER TABLE governance_auth_security_events DROP CONSTRAINT IF EXISTS governance_auth_security_events_event_check;
ALTER TABLE governance_auth_security_events ADD CONSTRAINT governance_auth_security_events_event_check
  CHECK (event IN ('login_succeeded','login_failed','login_locked','logout','session_revoked','sessions_revoked','password_changed','mfa_enabled','mfa_disabled','passkey_registered','passkey_removed','passkey_login','passkey_clone_detected','user_created','user_updated','credentials_reset','role_assigned','role_revoked','role_updated','department_updated','node_updated','skill_access_updated','oidc_login','oidc_linked','oidc_unlinked','role_permissions_updated','role_parent_updated','storage_quota_updated'));
`

func (s *Store) initStorageLedger(ctx context.Context) error {
	return storageledger.Initialize(ctx, s.pool, func(tx pgx.Tx) error {
		for _, query := range []string{
			`SELECT b.realm,t.project_id,'run-file',b.run_id||'/'||b.entry_id,b.bytes,'pg-run-file/'||b.run_id||'/'||b.entry_id
 FROM governance_run_file_blobs b JOIN governance_task_runs r ON r.id=b.run_id AND r.realm=b.realm JOIN governance_delegation_tasks t ON t.id=r.task_id AND t.realm=r.realm
 WHERE NOT EXISTS(SELECT 1 FROM platform_storage_charges c WHERE c.realm=b.realm AND c.kind='run-file' AND c.reference_id=b.run_id||'/'||b.entry_id) ORDER BY b.realm,b.run_id,b.entry_id`,
			`SELECT a.realm,t.project_id,'task-artifact',a.id,a.size_bytes,a.storage_key
 FROM governance_task_artifacts a JOIN governance_delegation_tasks t ON t.id=a.task_id AND t.realm=a.realm
 WHERE a.status='ready' AND NOT EXISTS(SELECT 1 FROM platform_storage_charges c WHERE c.realm=a.realm AND c.kind='task-artifact' AND c.reference_id=a.id) ORDER BY a.realm,a.id`,
		} {
			if err := storageledger.Backfill(ctx, tx, query); err != nil {
				return err
			}
		}
		return storageledger.CompleteCoverage(ctx, tx, "run-file", "task-artifact")
	})
}
