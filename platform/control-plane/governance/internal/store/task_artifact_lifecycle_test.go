package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/storageledger"
)

func artifactLifecycle(t *testing.T) (*Store, domain.TaskArtifact, string) {
	t.Helper()
	s := taskTestStore(t)
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `INSERT INTO governance_roles(realm,id,name,status)VALUES('realm','artifact-editor','Artifact editor','active');INSERT INTO governance_role_permissions(realm,role_id,action,effect)VALUES('realm','artifact-editor','task:delegate','allow');INSERT INTO governance_user_roles(realm,user_id,role_id,granted_by)VALUES('realm','employee','artifact-editor','manager'),('realm','manager','artifact-editor','manager')`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"025_managed_content_lifecycle.sql", "036_managed_task_artifacts.sql"} {
		ddl, err := os.ReadFile("../../../../deploy/migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.pool.Exec(ctx, string(ddl)); err != nil {
			t.Fatal(err)
		}
	}
	task := seedResultTask(t, s, "artifact-task", "")
	a, err := s.ReserveTaskArtifact(ctx, domain.TaskArtifact{ID: "artifact-1", Realm: "realm", TaskID: task.ID, RunID: task.ID + "-run-1", Name: "report.pdf", ContentType: "application/pdf", CreatedBy: "employee"}, false)
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	key := "realm/managed-content/v1/11111111-2222-4333-8444-555555555555/" + hash
	_, err = s.pool.Exec(ctx, `INSERT INTO managed_content_objects(realm,object_id,storage_id,object_key,sha256,byte_size,reservation_kind,reservation_id,state,retain_until,grace_ms)VALUES('realm','11111111-2222-4333-8444-555555555555','test',$1,$2,123,'task-artifact',$3,'ready',now(),0)`, key, hash, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	return s, a, key
}
func finishArtifact(t *testing.T, s *Store, a domain.TaskArtifact, key string) domain.TaskArtifact {
	t.Helper()
	out, err := s.CompleteTaskArtifact(context.Background(), a.Realm, a.TaskID, a.RunID, a.ID, key, strings.Repeat("a", 64), 123, "employee", false)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestTaskArtifactManagedPinWithdrawalAndQuotaAreAtomic(t *testing.T) {
	s, a, key := artifactLifecycle(t)
	ctx := context.Background()
	ready := finishArtifact(t, s, a, key)
	finishArtifact(t, s, a, key)
	var pins int
	var reserved bool
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM managed_content_references WHERE released_at IS NULL`).Scan(&pins); err != nil || pins != 1 {
		t.Fatalf("pins=%d %v", pins, err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT reservation_active FROM managed_content_objects`).Scan(&reserved); err != nil || reserved {
		t.Fatalf("reservation remains active: %v", err)
	}
	if ok, err := s.TaskArtifactWithdrawalAvailable(ctx, a.Realm, a.TaskID, a.RunID); err != nil || !ok {
		t.Fatalf("active artifact not withdrawable: %v", err)
	}
	if err := s.WithdrawTaskArtifact(ctx, a.Realm, a.TaskID, a.RunID, a.ID, "employee", "Uploaded an outdated report", ready.SHA256, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTaskArtifact(ctx, a.Realm, a.TaskID, a.RunID, a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("withdrawn bytes exposed: %v", err)
	}
	if items, err := s.ListTaskArtifacts(ctx, a.Realm, a.TaskID, a.RunID); err != nil || len(items) != 0 {
		t.Fatalf("withdrawn list: %+v %v", items, err)
	}
	var tombstone, release, charge bool
	var hash, object, reason string
	var audits int
	if err := s.pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL,sha256,storage_key,revocation_reason FROM governance_task_artifacts WHERE id=$1`, a.ID).Scan(&tombstone, &hash, &object, &reason); err != nil || !tombstone || hash != ready.SHA256 || object != key || reason == "" {
		t.Fatalf("immutable tombstone missing: %v", err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT released_at IS NOT NULL FROM managed_content_references`).Scan(&release); err != nil || !release {
		t.Fatalf("pin retained: %v", err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT released_at IS NOT NULL FROM platform_storage_charges WHERE kind='task-artifact' AND reference_id=$1`, a.ID).Scan(&charge); err != nil || !charge {
		t.Fatalf("logical bytes retained: %v", err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM governance_task_audit WHERE task_id=$1 AND event='artifact_withdrawn'`, a.TaskID).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("withdraw audit: %d %v", audits, err)
	}
	if _, err := s.CompleteTaskArtifact(ctx, a.Realm, a.TaskID, a.RunID, a.ID, key, ready.SHA256, 123, "employee", false); err == nil {
		t.Fatal("tombstone revived")
	}
}
func TestTaskArtifactFailedCompletionRetainsReservationAndRollsBackCharge(t *testing.T) {
	for _, mode := range []string{"wrong-reservation", "deleting", "wrong-size", "quota"} {
		t.Run(mode, func(t *testing.T) {
			s, a, key := artifactLifecycle(t)
			ctx := context.Background()
			var err error
			switch mode {
			case "wrong-reservation":
				_, err = s.pool.Exec(ctx, `UPDATE managed_content_objects SET reservation_id='another-artifact'`)
			case "deleting":
				_, err = s.pool.Exec(ctx, `UPDATE managed_content_objects SET state='deleting'`)
			case "wrong-size":
				_, err = s.pool.Exec(ctx, `UPDATE managed_content_objects SET byte_size=124`)
			case "quota":
				_, err = s.pool.Exec(ctx, `INSERT INTO platform_storage_limits(realm,scope,scope_id,limit_bytes)VALUES('realm','realm','',0) ON CONFLICT(realm,scope,scope_id)DO UPDATE SET limit_bytes=0`)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.CompleteTaskArtifact(ctx, a.Realm, a.TaskID, a.RunID, a.ID, key, strings.Repeat("a", 64), 123, "employee", false)
			if err == nil {
				t.Fatal("invalid completion accepted")
			}
			if mode == "quota" && !errors.Is(err, storageledger.ErrQuota) {
				t.Fatalf("quota: %v", err)
			}
			var status string
			var pins, charges int
			var reservation bool
			if err = s.pool.QueryRow(ctx, `SELECT status FROM governance_task_artifacts WHERE id=$1`, a.ID).Scan(&status); err != nil || status != "pending" {
				t.Fatalf("partial receipt: %s %v", status, err)
			}
			if err = s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM managed_content_references),(SELECT count(*) FROM platform_storage_charges WHERE kind='task-artifact'),reservation_active FROM managed_content_objects`).Scan(&pins, &charges, &reservation); err != nil || pins != 0 || charges != 0 || !reservation {
				t.Fatalf("partial pin/charge: %d %d %v %v", pins, charges, reservation, err)
			}
		})
	}
}
func TestTaskArtifactWithdrawalProtectsCurrentAuthorityAndEvidence(t *testing.T) {
	for _, mode := range []string{"owner", "digest", "terminal-task", "terminal-run", "manifest", "result", "role-revoked", "forged-admin"} {
		t.Run(mode, func(t *testing.T) {
			s, a, key := artifactLifecycle(t)
			ctx := context.Background()
			ready := finishArtifact(t, s, a, key)
			actor, hash := "employee", ready.SHA256
			admin := false
			var err error
			switch mode {
			case "owner":
				actor = "stranger"
				_, err = s.pool.Exec(ctx, `INSERT INTO governance_users(realm,id,display_name,status)VALUES('realm','stranger','Stranger','active')`)
			case "digest":
				hash = strings.Repeat("b", 64)
			case "terminal-task":
				_, err = s.pool.Exec(ctx, `UPDATE governance_delegation_tasks SET business_state='DONE' WHERE id=$1`, a.TaskID)
			case "terminal-run":
				_, err = s.pool.Exec(ctx, `UPDATE governance_task_runs SET state='COMPLETED' WHERE id=$1`, a.RunID)
			case "manifest":
				_, err = s.pool.Exec(ctx, `INSERT INTO governance_run_output_manifests(run_id,realm,task_id,digest,manifest)VALUES($1,'realm',$2,$3,'{}')`, a.RunID, a.TaskID, hash)
			case "result":
				_, err = s.pool.Exec(ctx, `INSERT INTO governance_task_results(run_id,realm,task_id,payload)VALUES($1,'realm',$2,'{}')`, a.RunID, a.TaskID)
			case "role-revoked":
				_, err = s.pool.Exec(ctx, `DELETE FROM governance_user_roles WHERE realm='realm' AND user_id='employee'`)
			case "forged-admin":
				admin = true // task contributor is not a persisted administrator.
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = s.WithdrawTaskArtifact(ctx, a.Realm, a.TaskID, a.RunID, a.ID, actor, "Should be refused", hash, admin); err == nil {
				t.Fatal("protected evidence withdrawn")
			}
			var live bool
			if err = s.pool.QueryRow(ctx, `SELECT revoked_at IS NULL AND EXISTS(SELECT 1 FROM managed_content_references WHERE released_at IS NULL) AND EXISTS(SELECT 1 FROM platform_storage_charges WHERE kind='task-artifact' AND released_at IS NULL) FROM governance_task_artifacts WHERE id=$1`, a.ID).Scan(&live); err != nil || !live {
				t.Fatalf("refusal changed authority: %v", err)
			}
		})
	}
}
