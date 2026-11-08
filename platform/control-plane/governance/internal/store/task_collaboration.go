package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
	"github.com/lumo-harness/platform/governance/internal/managedcontent"
	"github.com/lumo-harness/platform/storageledger"
)

var taskArtifactHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

// TaskAccess resolves explicit grants and direct participation through the
// task's ancestor chain. Grant subjects are evaluated against current user and
// department state, so department membership changes take effect immediately.
func (s *Store) TaskAccess(ctx context.Context, realm, taskID, userID string) (string, error) {
	return taskAccess(ctx, s.pool, realm, taskID, userID)
}

// taskAccess can read through a write transaction after its task lock is held.
// A preflight pool read does not authorize writes after a collaborator removal.
func taskAccess(ctx context.Context, q receiptQuerier, realm, taskID, userID string) (string, error) {
	var score int
	var exists bool
	err := q.QueryRow(ctx, `
WITH RECURSIVE ancestors AS (
  SELECT id,intent_contract->>'parent_task_id' AS parent_task_id,requester_user_id,assignee_user_id,ARRAY[id]::text[] AS visited
  FROM governance_delegation_tasks WHERE realm=$1 AND id=$2
  UNION ALL
  SELECT parent.id,parent.intent_contract->>'parent_task_id',parent.requester_user_id,parent.assignee_user_id,a.visited || parent.id
  FROM governance_delegation_tasks parent
  JOIN ancestors a ON parent.realm=$1 AND parent.id=a.parent_task_id
  WHERE NOT parent.id=ANY(a.visited)
)
SELECT COALESCE(MAX(CASE
  WHEN a.requester_user_id=$3 OR a.assignee_user_id=$3 THEN 2
  WHEN EXISTS (
    SELECT 1 FROM governance_task_collaborators g
    WHERE g.realm=$1 AND g.task_id=a.id AND g.access='contributor' AND (
      (g.subject_type='user' AND g.subject_id=$3)
      OR (g.subject_type='department' AND EXISTS (
        SELECT 1 FROM governance_users u
        JOIN governance_departments ud ON ud.realm=u.realm AND ud.id=u.primary_dept_id AND ud.status='active'
        JOIN governance_departments gd ON gd.realm=g.realm AND gd.id=g.subject_id AND gd.status='active'
        WHERE u.realm=$1 AND u.id=$3 AND u.status='active'
          AND (ud.id=gd.id OR (g.include_children AND ud.path LIKE gd.path || '%'))
      ))
    )
  ) THEN 2
  WHEN EXISTS (
    SELECT 1 FROM governance_task_collaborators g
    WHERE g.realm=$1 AND g.task_id=a.id AND g.access='viewer' AND (
      (g.subject_type='user' AND g.subject_id=$3)
      OR (g.subject_type='department' AND EXISTS (
        SELECT 1 FROM governance_users u
        JOIN governance_departments ud ON ud.realm=u.realm AND ud.id=u.primary_dept_id AND ud.status='active'
        JOIN governance_departments gd ON gd.realm=g.realm AND gd.id=g.subject_id AND gd.status='active'
        WHERE u.realm=$1 AND u.id=$3 AND u.status='active'
          AND (ud.id=gd.id OR (g.include_children AND ud.path LIKE gd.path || '%'))
      ))
    )
  ) THEN 1 ELSE 0 END),0), COUNT(*)>0
FROM ancestors a`, realm, taskID, userID).Scan(&score, &exists)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", ErrNotFound
	}
	if score >= 2 {
		return "contributor", nil
	}
	if score == 1 {
		return "viewer", nil
	}
	return "", nil
}

func (s *Store) ListTaskCollaborators(ctx context.Context, realm, taskID string) ([]domain.TaskCollaborator, error) {
	rows, err := s.pool.Query(ctx, `SELECT subject_type,subject_id,access,include_children,created_by,created_at
FROM governance_task_collaborators WHERE realm=$1 AND task_id=$2
ORDER BY subject_type,subject_id`, realm, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.TaskCollaborator{}
	for rows.Next() {
		var item domain.TaskCollaborator
		if err := rows.Scan(&item.SubjectType, &item.SubjectID, &item.Access, &item.IncludeChildren, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) ReplaceTaskCollaborators(ctx context.Context, realm, taskID, actor string, items []domain.TaskCollaborator) error {
	if len(items) > 200 {
		return fmt.Errorf("%w: at most 200 task collaborators are allowed", ErrBadRequest)
	}
	normalized := make([]domain.TaskCollaborator, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		item.SubjectType = strings.ToLower(strings.TrimSpace(item.SubjectType))
		item.SubjectID = strings.TrimSpace(item.SubjectID)
		item.Access = strings.ToLower(strings.TrimSpace(item.Access))
		if item.SubjectID == "" || len(item.SubjectID) > 160 || (item.SubjectType != "user" && item.SubjectType != "department") || (item.Access != "viewer" && item.Access != "contributor") || (item.SubjectType == "user" && item.IncludeChildren) {
			return fmt.Errorf("%w: invalid task collaborator", ErrBadRequest)
		}
		key := item.SubjectType + ":" + item.SubjectID
		if seen[key] {
			return fmt.Errorf("%w: duplicate task collaborator %s", ErrBadRequest, key)
		}
		seen[key] = true
		normalized = append(normalized, item)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var lockedTaskID string
	if err := tx.QueryRow(ctx, `SELECT id FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&lockedTaskID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	for _, item := range normalized {
		table, label := "governance_users", "user"
		if item.SubjectType == "department" {
			table, label = "governance_departments", "department"
		}
		var active bool
		query := `SELECT EXISTS(SELECT 1 FROM ` + table + ` WHERE realm=$1 AND id=$2 AND status='active')`
		if err := tx.QueryRow(ctx, query, realm, item.SubjectID).Scan(&active); err != nil {
			return err
		}
		if !active {
			return fmt.Errorf("%w: active %s %q not found", ErrBadRequest, label, item.SubjectID)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM governance_task_collaborators WHERE realm=$1 AND task_id=$2`, realm, taskID); err != nil {
		return err
	}
	for _, item := range normalized {
		if _, err := tx.Exec(ctx, `INSERT INTO governance_task_collaborators(realm,task_id,subject_type,subject_id,access,include_children,created_by)
VALUES($1,$2,$3,$4,$5,$6,$7)`, realm, taskID, item.SubjectType, item.SubjectID, item.Access, item.IncludeChildren, actor); err != nil {
			return err
		}
	}
	detail, _ := json.Marshal(map[string]any{"collaborator_count": len(normalized)})
	if err := insertTaskAudit(ctx, tx, taskID, "collaborators_replaced", actor, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scanTaskArtifact(row rowScanner, artifact *domain.TaskArtifact) error {
	return row.Scan(&artifact.ID, &artifact.Realm, &artifact.TaskID, &artifact.RunID, &artifact.Name,
		&artifact.ContentType, &artifact.SizeBytes, &artifact.SHA256, &artifact.StorageKey,
		&artifact.CreatedBy, &artifact.Status, &artifact.CreatedAt, &artifact.ReadyAt)
}

const taskArtifactSelect = `SELECT id,realm,task_id,run_id,name,content_type,size_bytes,sha256,storage_key,created_by,status,created_at,ready_at FROM governance_task_artifacts`

func (s *Store) ListTaskArtifacts(ctx context.Context, realm, taskID, runID string) ([]domain.TaskArtifact, error) {
	rows, err := s.pool.Query(ctx, taskArtifactSelect+` WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND status='ready' AND revoked_at IS NULL ORDER BY created_at,id`, realm, taskID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.TaskArtifact{}
	for rows.Next() {
		var item domain.TaskArtifact
		if err := scanTaskArtifact(rows, &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// Read-only display hint; WithdrawTaskArtifact rechecks under the task lock.
func (s *Store) TaskArtifactWithdrawalAvailable(ctx context.Context, realm, taskID, runID string) (bool, error) {
	var available bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_delegation_tasks t JOIN governance_task_runs r ON r.realm=t.realm AND r.task_id=t.id WHERE t.realm=$1 AND t.id=$2 AND r.id=$3 AND COALESCE(t.business_state,'') NOT IN ('DONE','REJECTED','ARCHIVED') AND t.state NOT IN ('COMPLETED','FAILED','CANCELLED') AND r.state NOT IN ('COMPLETED','FAILED','CANCELLED')) AND NOT EXISTS(SELECT 1 FROM governance_task_results WHERE realm=$1 AND task_id=$2 AND run_id=$3) AND NOT EXISTS(SELECT 1 FROM governance_run_output_manifests WHERE realm=$1 AND task_id=$2 AND run_id=$3) AND NOT EXISTS(SELECT 1 FROM governance_run_reviews WHERE realm=$1 AND (producer_run_id=$3 OR review_run_id=$3))`, realm, taskID, runID).Scan(&available)
	return available, err
}

func (s *Store) ReserveTaskArtifact(ctx context.Context, artifact domain.TaskArtifact, admin bool) (domain.TaskArtifact, error) {
	artifact.Name = strings.TrimSpace(artifact.Name)
	artifact.ContentType = strings.TrimSpace(artifact.ContentType)
	if artifact.ID == "" || artifact.TaskID == "" || artifact.RunID == "" || artifact.CreatedBy == "" || artifact.Name == "" || len([]rune(artifact.Name)) > 240 || len(artifact.ContentType) > 160 {
		return artifact, fmt.Errorf("%w: invalid task artifact metadata", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, artifact.Realm)
	if err != nil {
		return artifact, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var taskID, businessState string
	err = tx.QueryRow(ctx, `SELECT id,COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, artifact.Realm, artifact.TaskID).Scan(&taskID, &businessState)
	if errors.Is(err, pgx.ErrNoRows) {
		return artifact, ErrNotFound
	}
	if err != nil {
		return artifact, err
	}
	if businessState == domain.BusinessDone || businessState == domain.BusinessRejected || businessState == domain.BusinessArchived {
		return artifact, fmt.Errorf("%w: a closed task cannot acquire additional artifacts", ErrConflict)
	}
	if err = authorizeArtifactWrite(ctx, tx, artifact.Realm, artifact.TaskID, artifact.CreatedBy, admin); err != nil {
		return artifact, err
	}
	var found bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_runs WHERE realm=$1 AND task_id=$2 AND id=$3)`, artifact.Realm, artifact.TaskID, artifact.RunID).Scan(&found)
	if err != nil {
		return artifact, err
	}
	if !found {
		return artifact, ErrNotFound
	}
	var closed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_run_execution_snapshots WHERE realm=$1 AND run_id=$2 AND snapshot->>'output_profile'=ANY($3::text[]))`, artifact.Realm, artifact.RunID, []string{domain.ClosedTextOutputProfile, domain.ClosedTextFilesOutputProfile, domain.ClosedRepositoryOutputProfile}).Scan(&closed); err != nil {
		return artifact, err
	}
	if closed {
		return artifact, fmt.Errorf("%w: the closed text output set cannot acquire uploaded artifacts", ErrConflict)
	}
	if err = artifactRunWritable(ctx, tx, artifact.Realm, artifact.TaskID, artifact.RunID); err != nil {
		return artifact, err
	}
	artifact.Status = "pending"
	err = scanTaskArtifact(tx.QueryRow(ctx, `INSERT INTO governance_task_artifacts(id,realm,task_id,run_id,name,content_type,created_by,status)
VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,realm,task_id,run_id,name,content_type,size_bytes,sha256,storage_key,created_by,status,created_at,ready_at`, artifact.ID, artifact.Realm, artifact.TaskID, artifact.RunID, artifact.Name, artifact.ContentType, artifact.CreatedBy), &artifact)
	if err != nil {
		return artifact, err
	}
	return artifact, tx.Commit(ctx)
}

func (s *Store) CompleteTaskArtifact(ctx context.Context, realm, taskID, runID, artifactID, storageKey, sha256 string, size int64, actor string, admin bool) (domain.TaskArtifact, error) {
	_, managedDigest, managed := managedcontent.Parse(realm, storageKey)
	if size <= 0 || size > 50*1024*1024 || !taskArtifactHash.MatchString(sha256) || (storageKey != "content/"+sha256 && (!managed || managedDigest != sha256)) {
		return domain.TaskArtifact{}, fmt.Errorf("%w: invalid artifact object reference", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return domain.TaskArtifact{}, err
	}
	defer tx.Rollback(ctx)
	var project, business string
	if err = tx.QueryRow(ctx, `SELECT project_id,COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&project, &business); errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskArtifact{}, ErrNotFound
	} else if err != nil {
		return domain.TaskArtifact{}, err
	}
	if business == domain.BusinessDone || business == domain.BusinessRejected || business == domain.BusinessArchived {
		return domain.TaskArtifact{}, fmt.Errorf("%w: closed task artifacts are immutable", ErrConflict)
	}
	if err = authorizeArtifactWrite(ctx, tx, realm, taskID, actor, admin); err != nil {
		return domain.TaskArtifact{}, err
	}
	if err = artifactRunWritable(ctx, tx, realm, taskID, runID); err != nil {
		return domain.TaskArtifact{}, err
	}
	var artifact domain.TaskArtifact
	err = scanTaskArtifact(tx.QueryRow(ctx, `UPDATE governance_task_artifacts SET size_bytes=$5,sha256=$6,storage_key=$7,status='ready',ready_at=COALESCE(ready_at,now()) WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4 AND revoked_at IS NULL AND ((status='pending' AND $8) OR (status='ready' AND storage_key=$7 AND sha256=$6 AND size_bytes=$5)) RETURNING id,realm,task_id,run_id,name,content_type,size_bytes,sha256,storage_key,created_by,status,created_at,ready_at`, realm, taskID, runID, artifactID, size, sha256, storageKey, managed), &artifact)
	if errors.Is(err, pgx.ErrNoRows) {
		return artifact, ErrNotFound
	}
	if err != nil {
		return artifact, err
	}
	if err = managedcontent.Pin(ctx, tx, managedcontent.Reference{Realm: realm, Kind: "task-artifact", ReferenceID: artifactID, ObjectKey: storageKey, SHA256: sha256, Bytes: size}); err != nil {
		return artifact, fmt.Errorf("%w: managed artifact cannot be pinned", ErrConflict)
	}
	if err = storageledger.Register(ctx, tx, storageledger.Charge{Realm: realm, ProjectID: project, Kind: "task-artifact", ReferenceID: artifactID, Bytes: size, ObjectKey: storageKey}); err != nil {
		return artifact, err
	}
	return artifact, tx.Commit(ctx)
}

func artifactRunWritable(ctx context.Context, tx pgx.Tx, realm, taskID, runID string) error {
	var state string
	var current bool
	if err := tx.QueryRow(ctx, `SELECT state,attempt=(SELECT MAX(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=$2) FROM governance_task_runs WHERE realm=$1 AND task_id=$2 AND id=$3 FOR UPDATE`, realm, taskID, runID).Scan(&state, &current); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if !current || state == domain.DelegationCompleted || state == domain.DelegationFailed || state == domain.DelegationCancelled {
		return fmt.Errorf("%w: only the current active execution accepts artifacts", ErrConflict)
	}
	var sealed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_results WHERE realm=$1 AND run_id=$2) OR EXISTS(SELECT 1 FROM governance_run_output_manifests WHERE realm=$1 AND run_id=$2) OR EXISTS(SELECT 1 FROM governance_run_reviews WHERE realm=$1 AND (producer_run_id=$2 OR review_run_id=$2)) OR EXISTS(SELECT 1 FROM governance_run_execution_snapshots WHERE realm=$1 AND run_id=$2 AND snapshot->>'output_profile'=ANY($3::text[]))`, realm, runID, []string{domain.ClosedTextOutputProfile, domain.ClosedTextFilesOutputProfile, domain.ClosedRepositoryOutputProfile}).Scan(&sealed); err != nil {
		return err
	}
	if sealed {
		return fmt.Errorf("%w: sealed execution and review evidence cannot acquire artifacts", ErrConflict)
	}
	return nil
}

func (s *Store) GetTaskArtifact(ctx context.Context, realm, taskID, runID, artifactID string) (domain.TaskArtifact, error) {
	var artifact domain.TaskArtifact
	err := scanTaskArtifact(s.pool.QueryRow(ctx, taskArtifactSelect+` WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4 AND status='ready' AND revoked_at IS NULL`, realm, taskID, runID, artifactID), &artifact)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskArtifact{}, ErrNotFound
	}
	return artifact, err
}

func authorizeArtifactWrite(ctx context.Context, tx pgx.Tx, realm, taskID, actor string, admin bool) error {
	var active bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2 AND status='active')`, realm, actor).Scan(&active); err != nil {
		return err
	}
	if !active {
		return ErrForbidden
	}
	if err := requireCurrentArtifactRole(ctx, tx, realm, actor); err != nil {
		return err
	}
	if admin {
		return requireCurrentRolePolicyAdmin(ctx, tx, realm, actor)
	}
	access, err := taskAccess(ctx, tx, realm, taskID, actor)
	if err != nil {
		return err
	}
	if access != "contributor" {
		return ErrForbidden
	}
	return nil
}

func requireCurrentArtifactRole(ctx context.Context, tx pgx.Tx, realm, actor string) error {
	rows, err := tx.Query(ctx, `SELECT ur.role_id FROM governance_user_roles ur JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id AND r.status='active' WHERE ur.realm=$1 AND ur.user_id=$2 AND (ur.expires_at IS NULL OR ur.expires_at>clock_timestamp())`, realm, actor)
	if err != nil {
		return err
	}
	direct := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		direct = append(direct, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	catalog, err := readRolePolicyCatalog(ctx, tx, realm)
	if err != nil {
		return err
	}
	resolution, err := domain.ResolveRolePolicy(direct, catalog)
	if err != nil {
		return ErrRolePolicyUnavailable
	}
	if !resolution.Actions[domain.ActionTaskDelegate].Allowed {
		return ErrForbidden
	}
	return nil
}

// WithdrawTaskArtifact retains an immutable tombstone and audit, releasing both
// its managed pin and logical charge in the same authoritative transaction.
func (s *Store) WithdrawTaskArtifact(ctx context.Context, realm, taskID, runID, artifactID, actor, reason, expectedHash string, admin bool) error {
	reason = strings.TrimSpace(reason)
	if reason == "" || len([]rune(reason)) > 500 || !taskArtifactHash.MatchString(expectedHash) {
		return fmt.Errorf("%w: a bounded withdrawal reason and exact artifact digest are required", ErrBadRequest)
	}
	tx, err := s.beginOrganizationChange(ctx, realm)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var project, business, state, requester string
	if err = tx.QueryRow(ctx, `SELECT project_id,COALESCE(business_state,''),state,requester_user_id FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, realm, taskID).Scan(&project, &business, &state, &requester); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if err = authorizeArtifactWrite(ctx, tx, realm, taskID, actor, admin); err != nil {
		return err
	}
	if business == domain.BusinessDone || business == domain.BusinessRejected || business == domain.BusinessArchived || state == domain.DelegationCompleted || state == domain.DelegationFailed || state == domain.DelegationCancelled {
		return fmt.Errorf("%w: terminal task evidence is immutable", ErrConflict)
	}
	var sealed bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_runs WHERE realm=$1 AND task_id=$2 AND id=$3 AND state IN ('COMPLETED','FAILED','CANCELLED')) OR EXISTS(SELECT 1 FROM governance_task_results WHERE realm=$1 AND task_id=$2 AND run_id=$3) OR EXISTS(SELECT 1 FROM governance_run_output_manifests WHERE realm=$1 AND task_id=$2 AND run_id=$3) OR EXISTS(SELECT 1 FROM governance_run_reviews WHERE realm=$1 AND (producer_run_id=$3 OR review_run_id=$3))`, realm, taskID, runID).Scan(&sealed); err != nil {
		return err
	}
	if sealed {
		return fmt.Errorf("%w: execution and review evidence is immutable", ErrConflict)
	}
	var artifact domain.TaskArtifact
	if err = scanTaskArtifact(tx.QueryRow(ctx, taskArtifactSelect+` WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4 AND status='ready' AND revoked_at IS NULL FOR UPDATE`, realm, taskID, runID, artifactID), &artifact); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if !admin && actor != requester && actor != artifact.CreatedBy {
		return ErrForbidden
	}
	if artifact.SHA256 != expectedHash {
		return fmt.Errorf("%w: artifact digest changed", ErrConflict)
	}
	if err = managedcontent.Release(ctx, tx, managedcontent.Reference{Realm: realm, Kind: "task-artifact", ReferenceID: artifactID, ObjectKey: artifact.StorageKey}); err != nil {
		return err
	}
	if err = storageledger.Lock(ctx, tx, realm, project); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE platform_storage_charges SET released_at=COALESCE(released_at,now()) WHERE realm=$1 AND kind='task-artifact' AND reference_id=$2`, realm, artifactID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE governance_task_artifacts SET revoked_at=now(),revoked_by=$5,revocation_reason=$6 WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4`, realm, taskID, runID, artifactID, actor, reason); err != nil {
		return err
	}
	detail, _ := json.Marshal(map[string]any{"artifact_id": artifactID, "run_id": runID, "sha256": artifact.SHA256, "size_bytes": artifact.SizeBytes, "reason": reason, "managed": managedcontent.IsManaged(artifact.StorageKey)})
	if err = insertTaskAudit(ctx, tx, taskID, "artifact_withdrawn", actor, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
