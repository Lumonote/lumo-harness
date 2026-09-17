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

const taskResultsDDL = `
CREATE TABLE IF NOT EXISTS governance_task_results (
  run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id),
  realm TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_task_results_task_idx
  ON governance_task_results(realm,task_id,created_at);
`

func scanTaskResult(row rowScanner) (domain.TaskResult, error) {
	var result domain.TaskResult
	var raw []byte
	if err := row.Scan(&raw, &result.CreatedAt); err != nil {
		return result, err
	}
	err := json.Unmarshal(raw, &result)
	return result, err
}

func (s *Store) GetTaskResult(ctx context.Context, realm, taskID, runID string) (domain.TaskResult, error) {
	result, err := scanTaskResult(s.pool.QueryRow(ctx, `SELECT payload,created_at FROM governance_task_results WHERE realm=$1 AND task_id=$2 AND run_id=$3`, realm, taskID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrNotFound
	}
	return result, err
}

func (s *Store) RecordTaskResult(ctx context.Context, realm string, result domain.TaskResult, actor string) (domain.TaskResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := recordTaskResultTx(ctx, tx, realm, &result, actor); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

// recordTaskResultTx writes one execution result inside the caller's
// transaction. Both the Worker-facing API and the device gateway funnel through
// here, so these invariants hold no matter which side reported the result:
//
//   - results are immutable: replaying the same payload is a no-op, a different
//     payload for the same run is a conflict
//   - the run must be the task's current attempt, and its bound node and
//     session must match the report
//   - a closed task refuses further execution results
//   - the parent task is notified in the same transaction, so a replica restart
//     cannot keep the result while losing the notification
//
// Validation lives here rather than in the callers on purpose: this is the only
// place a result row is ever written, so it is the only place the check cannot
// be forgotten.
func recordTaskResultTx(ctx context.Context, tx pgx.Tx, realm string, result *domain.TaskResult, actor string) error {
	if err := result.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	// Timestamp belongs to the database; exclude it from replay equality.
	raw, err := json.Marshal(map[string]any{
		"task_id": result.TaskID, "run_id": result.RunID, "state": result.State,
		"session_ref": result.SessionRef, "node_id": result.NodeID,
		"summary": result.Summary, "output": result.Output,
	})
	if err != nil {
		return err
	}
	var task domain.DelegatedTask
	if err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 FOR UPDATE OF t`, realm, result.TaskID), &task); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	var same bool
	err = tx.QueryRow(ctx, `SELECT payload=$4::jsonb,created_at FROM governance_task_results WHERE realm=$1 AND task_id=$2 AND run_id=$3`, realm, result.TaskID, result.RunID, raw).Scan(&same, &result.CreatedAt)
	if err == nil {
		if !same {
			return fmt.Errorf("%w: result is immutable", ErrConflict)
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var run domain.TaskRun
	if err := scanTaskRun(tx.QueryRow(ctx, taskRunSelect+` WHERE realm=$1 AND task_id=$2 ORDER BY attempt DESC LIMIT 1 FOR UPDATE`, realm, result.TaskID), &run); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if run.ID != result.RunID || (run.AssignedNodeID != "" && run.AssignedNodeID != result.NodeID) ||
		(run.SessionRef != "" && run.SessionRef != result.SessionRef) ||
		(!domain.DelegationStateActive(run.State) && run.State != result.State) {
		return fmt.Errorf("%w: result does not match the current execution", ErrConflict)
	}
	if task.BusinessState == domain.BusinessDone || task.BusinessState == domain.BusinessRejected || task.BusinessState == domain.BusinessArchived {
		return fmt.Errorf("%w: task is closed for execution results", ErrConflict)
	}
	if err := tx.QueryRow(ctx, `INSERT INTO governance_task_results(run_id,realm,task_id,payload) VALUES($1,$2,$3,$4) RETURNING created_at`, result.RunID, realm, result.TaskID, raw).Scan(&result.CreatedAt); err != nil {
		return err
	}
	lastError := ""
	if result.State != domain.DelegationCompleted {
		lastError = result.Summary
	}
	if _, err := tx.Exec(ctx, `UPDATE governance_task_runs SET state=$4,session_ref=$5,
	  ended_at=COALESCE(ended_at,now()),last_error=$6 WHERE realm=$1 AND task_id=$2 AND id=$3`,
		realm, result.TaskID, result.RunID, result.State, result.SessionRef, lastError); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE governance_delegation_tasks SET state=$3,last_error=$4,updated_at=now(),
	  business_state=CASE WHEN $3='COMPLETED' AND business_state IN ('ASSIGNED','EXECUTING') THEN 'VERIFYING' ELSE business_state END
	  WHERE realm=$1 AND id=$2`, realm, result.TaskID, result.State, lastError); err != nil {
		return err
	}
	detail, _ := json.Marshal(map[string]any{"run_id": result.RunID, "state": result.State, "session_ref": result.SessionRef, "node_id": result.NodeID})
	if err := insertTaskAudit(ctx, tx, result.TaskID, "execution_result", actor, detail); err != nil {
		return err
	}
	return notifyParentTask(ctx, tx, task, "child_result", actor, detail)
}

// RecordDeviceTaskResult records the final result of a task execution reported
// by a desktop device over its authenticated gateway connection.
//
// The device gateway has already authenticated the device (mTLS plus the
// connection lease); this method pins that identity a second time against the
// command row, so a device can only ever write a result for the run it was
// actually handed.
//
// Run identity is read from the command row, never taken from the device's own
// report. A device that reports a different run is refused rather than silently
// corrected: this is the entry point for writing into someone else's run, so
// "who decides" has to stay observable.
//
// A result is only accepted for a command that already reached state
// "completed" (the device confirmed it persisted the assignment locally).
// Accepting a result on a command that was never accepted would let a device
// bypass the PLACED -> RUNNING transition that CompleteDeviceCommand performs.
func (s *Store) RecordDeviceTaskResult(ctx context.Context, realm, nodeID, connection, commandID string, result domain.TaskResult) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The fence set is the one CompleteDeviceCommand already uses: same
	// connection, same certificate, same applied revision, same live node and
	// active owner. A second, subtly different fence would be a second trust
	// boundary, and reusing this one is the whole point.
	var action, state, runID, sessionRef, taskID string
	var attempt int
	var revision int64
	err = tx.QueryRow(ctx, `SELECT q.action,q.state,q.run_id,q.attempt,q.session_ref,q.revision,COALESCE(r.task_id,'')
	  FROM governance_device_commands q
	  JOIN governance_device_connections d ON d.realm=q.realm AND d.node_id=q.node_id
	  JOIN governance_desktop_nodes n ON n.realm=q.realm AND n.id=q.node_id
	  JOIN governance_users u ON u.realm=n.realm AND u.id=n.owner_user_id
	  LEFT JOIN governance_task_runs r ON r.realm=q.realm AND r.id=q.run_id
	  WHERE q.realm=$1 AND q.node_id=$2 AND q.connection_id=$3 AND q.id=$4
	    AND d.connection_id=$3 AND d.connection_expires>now() AND d.certificate_expires>now()
	    AND q.revision=d.revision AND n.status<>'REVOKED' AND u.status='active'
	  FOR UPDATE OF q,d,n`, realm, nodeID, connection, commandID).
		Scan(&action, &state, &runID, &attempt, &sessionRef, &revision, &taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: command lease changed", ErrConflict)
	}
	if err != nil {
		return err
	}
	// Same identity judgement as CompleteDeviceCommand's task branch.
	if action != "execute_task" || runID == "" || attempt < 1 || sessionRef == "" || revision < 1 || taskID == "" {
		return fmt.Errorf("%w: invalid task command identity", ErrConflict)
	}
	if state != "completed" {
		return fmt.Errorf("%w: device command was never accepted", ErrConflict)
	}
	if result.RunID != runID || result.SessionRef != sessionRef || (result.TaskID != "" && result.TaskID != taskID) {
		return fmt.Errorf("%w: result does not match the accepted command", ErrConflict)
	}
	// Node identity comes from the authenticated connection, not the message.
	// The run's own binding check (AssignedNodeID) then refuses a device that
	// reports a run assigned elsewhere, so "a device may only report its own
	// run" needs no new rule here.
	result.TaskID, result.RunID, result.SessionRef, result.NodeID = taskID, runID, sessionRef, nodeID
	if err := recordTaskResultTx(ctx, tx, realm, &result, "device:"+nodeID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Parent notifications share the child's transaction. Reading its audit log
// after any replica restart therefore still exposes every child result.
func notifyParentTask(ctx context.Context, tx pgx.Tx, task domain.DelegatedTask, event, actor string, detail []byte) error {
	if task.IntentContract == nil || task.IntentContract.ParentTaskID == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO governance_task_audit(id,realm,task_id,event,actor,detail)
	  SELECT gen_random_uuid()::text,realm,id,$3,$4,$5::jsonb || jsonb_build_object('child_task_id',$6::text)
	  FROM governance_delegation_tasks WHERE realm=$1 AND id=$2`,
		task.Realm, task.IntentContract.ParentTaskID, event, actor, detail, task.ID)
	return err
}

func collaborationSummary(ctx context.Context, tx pgx.Tx, realm, taskID string) (domain.CollaborationSummary, error) {
	var summary domain.CollaborationSummary
	err := tx.QueryRow(ctx, `SELECT count(*),
	  count(*) FILTER (WHERE state IN ('ASSIGNED','QUEUED','RUNNING','CANCELLING')),
	  count(*) FILTER (WHERE business_state IN ('VERIFYING','IN_REVIEW')),
	  count(*) FILTER (WHERE business_state='DONE' OR (business_state='ARCHIVED' AND EXISTS (
	    SELECT 1 FROM governance_task_audit a WHERE a.realm=t.realm AND a.task_id=t.id AND a.event='complete'))),
	  count(*) FILTER (WHERE state IN ('FAILED','CANCELLED','BLOCKED') OR business_state='REJECTED')
	  FROM governance_delegation_tasks t WHERE realm=$1 AND intent_contract->>'parent_task_id'=$2`, realm, taskID).
		Scan(&summary.Total, &summary.Active, &summary.AwaitingReview, &summary.Accepted, &summary.NeedsAttention)
	summary.Unresolved = summary.Total - summary.Accepted
	return summary, err
}

func (s *Store) CollaborationProgress(ctx context.Context, realm, taskID string) (domain.CollaborationProgress, error) {
	out := domain.CollaborationProgress{Children: []domain.ChildTaskProgress{}}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2`, realm, taskID), &out.Task); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, ErrNotFound
		}
		return out, err
	}
	out.Summary, err = collaborationSummary(ctx, tx, realm, taskID)
	if err != nil {
		return out, err
	}
	rows, err := tx.Query(ctx, delegationSelect+` WHERE t.realm=$1 AND t.intent_contract->>'parent_task_id'=$2 ORDER BY t.created_at,t.id LIMIT 200`, realm, taskID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var child domain.ChildTaskProgress
		if err := scanDelegatedTask(rows, &child.Task); err != nil {
			rows.Close()
			return out, err
		}
		out.Children = append(out.Children, child)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	ids := make([]string, 0, len(out.Children))
	byID := make(map[string]*domain.ChildTaskProgress, len(out.Children))
	for i := range out.Children {
		child := &out.Children[i]
		ids = append(ids, child.Task.ID)
		byID[child.Task.ID] = child
	}
	// Fetch current runs in one query. Full outputs have their own endpoint;
	// the collaboration view carries summaries without multiplying large blobs.
	rows, err = tx.Query(ctx, `SELECT row_to_json(r),e.payload - 'output',e.created_at FROM (
	  SELECT DISTINCT ON (task_id) * FROM governance_task_runs WHERE realm=$1 AND task_id=ANY($2)
	  ORDER BY task_id,attempt DESC) r
	  LEFT JOIN governance_task_results e ON e.realm=r.realm AND e.run_id=r.id`, realm, ids)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var runRaw, resultRaw []byte
		var result domain.TaskResult
		var createdAt *time.Time
		if err := rows.Scan(&runRaw, &resultRaw, &createdAt); err != nil {
			rows.Close()
			return out, err
		}
		var run domain.TaskRun
		if err := json.Unmarshal(runRaw, &run); err != nil {
			rows.Close()
			return out, err
		}
		child := byID[run.TaskID]
		child.Run = &run
		if len(resultRaw) > 0 {
			if err := json.Unmarshal(resultRaw, &result); err != nil {
				rows.Close()
				return out, err
			}
			if createdAt != nil {
				result.CreatedAt = *createdAt
			}
			child.Result = &result
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.HasMore = out.Summary.Total > len(out.Children)
	return out, tx.Commit(ctx)
}
