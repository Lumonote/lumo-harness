package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

const taskProgressDDL = `
CREATE TABLE IF NOT EXISTS governance_task_progress (
  realm TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES governance_task_runs(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK(revision > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,task_id,revision)
);
CREATE INDEX IF NOT EXISTS governance_task_progress_run_idx ON governance_task_progress(realm,run_id,revision DESC);
`

func (s *Store) RecordTaskProgress(ctx context.Context, realm, taskID string, update domain.TaskProgressUpdate, actor string) (domain.TaskProgress, error) {
	return s.recordTaskProgress(ctx, realm, taskID, update, actor, "user", "", "")
}

// Runtime checkpoints require the same durable node/session identity as results.
// A trusted transport token alone does not authorize reporting for another Run.
func (s *Store) RecordRuntimeTaskProgress(ctx context.Context, realm, taskID string, update domain.TaskProgressUpdate, nodeID, sessionRef string) (domain.TaskProgress, error) {
	return s.recordTaskProgress(ctx, realm, taskID, update, "", "runtime", nodeID, sessionRef)
}

func (s *Store) recordTaskProgress(ctx context.Context, realm, taskID string, update domain.TaskProgressUpdate, actor, source, nodeID, sessionRef string) (domain.TaskProgress, error) {
	var out domain.TaskProgress
	update.Normalize()
	if err := update.Validate(); err != nil {
		return out, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	var tx pgx.Tx
	var err error
	if source == "user" {
		// Keep user suspension, department and administrator grant mutations
		// ordered with the authenticated checkpoint, before taking the task lock.
		tx, err = s.beginOrganizationChange(ctx, realm)
	} else {
		tx, err = s.pool.Begin(ctx)
	}
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var task domain.DelegatedTask
	if err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 FOR UPDATE OF t`, realm, taskID), &task); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNotFound
		}
		return out, err
	}
	if source == "user" {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM governance_users WHERE realm=$1 AND id=$2 AND status='active')`, realm, actor).Scan(&active); err != nil {
			return out, err
		}
		if !active {
			return out, ErrForbidden
		}
		if err := requireCurrentProgressRole(ctx, tx, realm, actor); err != nil {
			return out, err
		}
		access, err := taskAccess(ctx, tx, realm, taskID, actor)
		if err != nil {
			return out, err
		}
		if access != "contributor" {
			if err := requireCurrentRolePolicyAdmin(ctx, tx, realm, actor); err != nil {
				return out, err
			}
		}
	}
	var run domain.TaskRun
	if err := scanTaskRun(tx.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`, realm, taskID), &run); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, fmt.Errorf("%w: task has no execution run", ErrConflict)
		}
		return out, err
	}
	if run.ID != update.RunID || !domain.TaskProgressWritable(task, run) {
		return out, fmt.Errorf("%w: only the current active run accepts progress", ErrConflict)
	}
	if source == "runtime" {
		if run.SchedulerTaskID != run.ID || run.AssignedNodeID == "" || run.AssignedNodeID != nodeID || run.SessionRef == "" || run.SessionRef != sessionRef {
			return out, fmt.Errorf("%w: progress does not match durable execution identity", ErrForbidden)
		}
		actor = run.WorkerID
	}
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(revision),0) FROM governance_task_progress WHERE realm=$1 AND task_id=$2`, realm, taskID).Scan(&revision); err != nil {
		return out, err
	}
	if revision != update.ExpectedRevision {
		return out, fmt.Errorf("%w: progress changed; reload before updating", ErrConflict)
	}
	out = domain.TaskProgress{TaskID: taskID, RunID: run.ID, Revision: revision + 1,
		Status: update.Status, Percent: update.Percent, Summary: update.Summary, NextStep: update.NextStep,
		BlockedReason: update.BlockedReason, DueAt: update.DueAt, UpdatedBy: actor, Source: source}
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&out.UpdatedAt); err != nil {
		return out, err
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return out, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO governance_task_progress(realm,task_id,run_id,revision,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)`, realm, taskID, run.ID, out.Revision, raw, out.UpdatedAt); err != nil {
		return out, err
	}
	if _, err := tx.Exec(ctx, `UPDATE governance_delegation_tasks SET updated_at=$3 WHERE realm=$1 AND id=$2`, realm, taskID, out.UpdatedAt); err != nil {
		return out, err
	}
	if err := insertTaskAudit(ctx, tx, taskID, "progress_updated", actor, raw); err != nil {
		return out, err
	}
	if err := notifyParentTask(ctx, tx, task, "child_progress", actor, raw); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// Resolve persisted, unexpired direct grants using the same role catalog as
// normal permission decisions. Header roles and preflight decisions may have
// become stale before the organization lock was acquired. Being a contributor
// does not override an explicit deny or a removed execution-update grant.
func requireCurrentProgressRole(ctx context.Context, tx pgx.Tx, realm, actor string) error {
	rows, err := tx.Query(ctx, `SELECT ur.role_id FROM governance_user_roles ur
	  JOIN governance_users u ON u.realm=ur.realm AND u.id=ur.user_id AND u.status='active'
	  JOIN governance_roles r ON r.realm=ur.realm AND r.id=ur.role_id AND r.status='active'
	  WHERE ur.realm=$1 AND ur.user_id=$2 AND (ur.expires_at IS NULL OR ur.expires_at>clock_timestamp())`, realm, actor)
	if err != nil {
		return err
	}
	direct := []string{}
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			rows.Close()
			return err
		}
		direct = append(direct, role)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
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
	if !resolution.Actions[domain.ActionTaskDelegate].Allowed || !resolution.Actions[domain.ActionTaskExecutionUpdate].Allowed {
		return ErrForbidden
	}
	return nil
}

// The UI capability follows the same persisted grants as the write gate, even
// when an already-authenticated request still carries old role headers.
func (s *Store) TaskProgressRoleAllowed(ctx context.Context, realm, actor string) (bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = requireCurrentProgressRole(ctx, tx, realm, actor)
	if errors.Is(err, ErrForbidden) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (s *Store) TaskProgress(ctx context.Context, realm, taskID string) (domain.TaskProgressView, error) {
	out := domain.TaskProgressView{History: []domain.TaskProgress{}}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var task domain.DelegatedTask
	if err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2`, realm, taskID), &task); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNotFound
		}
		return out, err
	}
	var run domain.TaskRun
	err = scanTaskRun(tx.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1`, realm, taskID), &run)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	out.CurrentRunID = run.ID
	out.CanUpdate = run.ID != "" && domain.TaskProgressWritable(task, run)
	rows, err := tx.Query(ctx, `SELECT payload FROM governance_task_progress WHERE realm=$1 AND task_id=$2 ORDER BY revision DESC LIMIT 30`, realm, taskID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var raw []byte
		var p domain.TaskProgress
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			return out, err
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			rows.Close()
			return out, err
		}
		if len(out.History) == 0 {
			out.Revision = p.Revision
		}
		if p.RunID == run.ID && out.Progress == nil {
			copy := p
			out.Progress = &copy
		}
		out.History = append(out.History, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// TaskProgressItems only receives task IDs already authorized by the caller.
// It batches current runs and their latest checkpoints without historical blobs.
func (s *Store) TaskProgressItems(ctx context.Context, realm string, tasks []domain.DelegatedTask) ([]domain.WorkforceProgressItem, error) {
	out := make([]domain.WorkforceProgressItem, len(tasks))
	ids := make([]string, len(tasks))
	indices := make(map[string]int, len(tasks))
	for i, task := range tasks {
		out[i].Task = task
		ids[i] = task.ID
		indices[task.ID] = i
	}
	rows, err := s.pool.Query(ctx, `SELECT row_to_json(r),p.payload FROM (
	  SELECT DISTINCT ON(task_id) * FROM governance_task_runs WHERE realm=$1 AND task_id=ANY($2) ORDER BY task_id,attempt DESC
	) r LEFT JOIN LATERAL (SELECT payload FROM governance_task_progress p WHERE p.realm=r.realm AND p.task_id=r.task_id AND p.run_id=r.id ORDER BY revision DESC LIMIT 1) p ON true`, realm, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var runRaw, progressRaw []byte
		var run domain.TaskRun
		if err := rows.Scan(&runRaw, &progressRaw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(runRaw, &run); err != nil {
			return nil, err
		}
		item := &out[indices[run.TaskID]]
		item.Run = &run
		if len(progressRaw) > 0 {
			var p domain.TaskProgress
			if err := json.Unmarshal(progressRaw, &p); err != nil {
				return nil, err
			}
			item.Progress = &p
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	for i := range out {
		out[i].Health = domain.ProgressHealth(out[i].Task, out[i].Run, out[i].Progress, now)
	}
	return out, nil
}
