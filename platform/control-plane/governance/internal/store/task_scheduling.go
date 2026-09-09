package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

const taskSchedulingDDL = `CREATE TABLE IF NOT EXISTS governance_task_scheduling (
  run_id TEXT PRIMARY KEY REFERENCES governance_task_runs(id),
  realm TEXT NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS governance_task_scheduling_pending_idx
  ON governance_task_scheduling(next_attempt_at) WHERE delivered_at IS NULL;`

type PendingRun struct{ Realm, RunID string }

func (s *Store) PendingRunSchedules(ctx context.Context) ([]PendingRun, error) {
	rows, err := s.pool.Query(ctx, `SELECT realm,run_id FROM governance_task_scheduling
	  WHERE delivered_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at,run_id LIMIT 32`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (PendingRun, error) {
		var item PendingRun
		err := row.Scan(&item.Realm, &item.RunID)
		return item, err
	})
}

func (s *Store) DeferRunSchedule(ctx context.Context, realm, runID, detail string) error {
	_, err := s.pool.Exec(ctx, `UPDATE governance_task_scheduling SET last_error=$3,next_attempt_at=now()+interval '5 seconds'
	  WHERE realm=$1 AND run_id=$2 AND delivered_at IS NULL`, realm, runID, detail)
	return err
}

// Persist the placement and acknowledge its delivery atomically. Replicas may
// submit the same stable run id, but only the current execution is projected.
func (s *Store) RecordRunPlacement(ctx context.Context, realm, runID, state, nodeID string) error {
	if !domain.ValidDelegationState(state) {
		return fmt.Errorf("%w: invalid placement state", ErrBadRequest)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var taskID, currentState string
	err = tx.QueryRow(ctx, `SELECT t.id,t.state FROM governance_delegation_tasks t
	  JOIN governance_task_runs r ON r.task_id=t.id AND r.realm=t.realm
	  WHERE t.realm=$1 AND r.id=$2 AND r.scheduler_task_id=r.id
	    AND r.attempt=(SELECT max(attempt) FROM governance_task_runs WHERE realm=$1 AND task_id=t.id)
	  FOR UPDATE OF t`, realm, runID).Scan(&taskID, &currentState)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err == nil && (currentState == domain.DelegationQueued || currentState == domain.DelegationAssigned) &&
		!(currentState == domain.DelegationAssigned && state == domain.DelegationQueued) {
		tag, err := tx.Exec(ctx, `UPDATE governance_task_runs SET state=$3,
		  assigned_node_id=CASE WHEN $4='' THEN assigned_node_id ELSE $4 END,last_error='',
		  ended_at=CASE WHEN $3 IN ('COMPLETED','FAILED','CANCELLED') THEN COALESCE(ended_at,now()) ELSE ended_at END
		  WHERE realm=$1 AND id=$2 AND state IN ('QUEUED','ASSIGNED')
		    AND NOT (state='ASSIGNED' AND $3='QUEUED')`, realm, runID, state, nodeID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			if _, err := tx.Exec(ctx, `UPDATE governance_delegation_tasks SET state=$3,
		  assigned_node_id=CASE WHEN $4='' THEN assigned_node_id ELSE $4 END,
		  last_error='',updated_at=now() WHERE realm=$1 AND id=$2`, realm, taskID, state, nodeID); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE governance_task_scheduling SET delivered_at=now(),last_error=''
	  WHERE realm=$1 AND run_id=$2 AND delivered_at IS NULL`, realm, runID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
