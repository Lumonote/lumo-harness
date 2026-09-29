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
)

var taskArtifactHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

// TaskAccess resolves explicit grants and direct participation through the
// task's ancestor chain. Grant subjects are evaluated against current user and
// department state, so department membership changes take effect immediately.
func (s *Store) TaskAccess(ctx context.Context, realm, taskID, userID string) (string, error) {
	var score int
	var exists bool
	err := s.pool.QueryRow(ctx, `
WITH RECURSIVE ancestors AS (
  SELECT id,parent_task_id,requester_user_id,assignee_user_id,ARRAY[id]::text[] AS visited
  FROM governance_delegation_tasks WHERE realm=$1 AND id=$2
  UNION ALL
  SELECT parent.id,parent.parent_task_id,parent.requester_user_id,parent.assignee_user_id,a.visited || parent.id
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
	rows, err := s.pool.Query(ctx, taskArtifactSelect+` WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND status='ready' ORDER BY created_at,id`, realm, taskID, runID)
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

func (s *Store) ReserveTaskArtifact(ctx context.Context, artifact domain.TaskArtifact) (domain.TaskArtifact, error) {
	artifact.Name = strings.TrimSpace(artifact.Name)
	artifact.ContentType = strings.TrimSpace(artifact.ContentType)
	if artifact.ID == "" || artifact.TaskID == "" || artifact.RunID == "" || artifact.CreatedBy == "" || artifact.Name == "" || len([]rune(artifact.Name)) > 240 || len(artifact.ContentType) > 160 {
		return artifact, fmt.Errorf("%w: invalid task artifact metadata", ErrBadRequest)
	}
	var found bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_task_runs WHERE realm=$1 AND task_id=$2 AND id=$3)`, artifact.Realm, artifact.TaskID, artifact.RunID).Scan(&found)
	if err != nil {
		return artifact, err
	}
	if !found {
		return artifact, ErrNotFound
	}
	artifact.Status = "pending"
	err = scanTaskArtifact(s.pool.QueryRow(ctx, `INSERT INTO governance_task_artifacts(id,realm,task_id,run_id,name,content_type,created_by,status)
VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id,realm,task_id,run_id,name,content_type,size_bytes,sha256,storage_key,created_by,status,created_at,ready_at`, artifact.ID, artifact.Realm, artifact.TaskID, artifact.RunID, artifact.Name, artifact.ContentType, artifact.CreatedBy), &artifact)
	if err != nil {
		return artifact, err
	}
	return artifact, nil
}

func (s *Store) CompleteTaskArtifact(ctx context.Context, realm, taskID, runID, artifactID, storageKey, sha256 string, size int64) (domain.TaskArtifact, error) {
	if size <= 0 || size > 50*1024*1024 || !taskArtifactHash.MatchString(sha256) || storageKey != "content/"+sha256 {
		return domain.TaskArtifact{}, fmt.Errorf("%w: invalid artifact object reference", ErrBadRequest)
	}
	var artifact domain.TaskArtifact
	err := scanTaskArtifact(s.pool.QueryRow(ctx, `UPDATE governance_task_artifacts SET size_bytes=$5,sha256=$6,storage_key=$7,status='ready',ready_at=now()
WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4 AND (status='pending' OR (status='ready' AND storage_key=$7 AND sha256=$6 AND size_bytes=$5))
RETURNING id,realm,task_id,run_id,name,content_type,size_bytes,sha256,storage_key,created_by,status,created_at,ready_at`, realm, taskID, runID, artifactID, size, sha256, storageKey), &artifact)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskArtifact{}, ErrNotFound
	}
	return artifact, err
}

func (s *Store) GetTaskArtifact(ctx context.Context, realm, taskID, runID, artifactID string) (domain.TaskArtifact, error) {
	var artifact domain.TaskArtifact
	err := scanTaskArtifact(s.pool.QueryRow(ctx, taskArtifactSelect+` WHERE realm=$1 AND task_id=$2 AND run_id=$3 AND id=$4 AND status='ready'`, realm, taskID, runID, artifactID), &artifact)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskArtifact{}, ErrNotFound
	}
	return artifact, err
}
