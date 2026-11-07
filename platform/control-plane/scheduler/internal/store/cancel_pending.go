package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// CancelUnseen persists cancellation even if a timed-out submission has not
// committed yet. Sharing the admission mutex closes the not-found/late-insert
// window; if placement won first its assignment is returned for executor stop.
func (s *Store) CancelUnseen(ctx context.Context, taskID, realm string) (domain.Placement, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT id FROM scheduler_leader_lease WHERE id=1 FOR UPDATE`); err != nil {
		return domain.Placement{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO scheduler_tasks(task_id,realm,cluster_id,requires,state,created_at,updated_at)
	 VALUES($1,$2,'','[]','ABORTED',`+nowMS+`,`+nowMS+`) ON CONFLICT(task_id) DO NOTHING`, taskID, realm); err != nil {
		return domain.Placement{}, err
	}
	var p domain.Placement
	p.TaskID = taskID
	err = tx.QueryRow(ctx, `SELECT realm,state,COALESCE(node_id,''),attempt,fencing_token,assigned_cluster_id
	 FROM scheduler_tasks WHERE task_id=$1 AND realm=$2`, taskID, realm).
		Scan(&p.Realm, &p.State, &p.NodeID, &p.Attempt, &p.FencingToken, &p.AssignedClusterID)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, &domain.TaskNotFoundError{TaskID: taskID}
	}
	if err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}

// CancelPending closes the queue/drain race: aborting a pending task and its
// durable cancellation intent share the task row lock. If placement won first,
// return its current assignment so the caller can stop that execution instead.
func (s *Store) CancelPending(ctx context.Context, taskID, realm string, attempt int) (domain.Placement, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Placement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p domain.Placement
	p.TaskID = taskID
	err = tx.QueryRow(ctx, `SELECT realm,state,COALESCE(node_id,''),attempt,fencing_token,assigned_cluster_id
	 FROM scheduler_tasks WHERE task_id=$1 AND realm=$2 FOR UPDATE`, taskID, realm).
		Scan(&p.Realm, &p.State, &p.NodeID, &p.Attempt, &p.FencingToken, &p.AssignedClusterID)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, &domain.TaskNotFoundError{TaskID: taskID}
	}
	if err != nil {
		return p, err
	}
	if p.State != domain.StatePending || (attempt > 0 && attempt != p.Attempt) {
		return p, nil
	}
	if _, err = tx.Exec(ctx, `UPDATE scheduler_tasks SET state='ABORTED',updated_at=`+nowMS+` WHERE task_id=$1`, taskID); err != nil {
		return p, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO scheduler_control_commands(task_id,command,attempt,node_id,status,requested_at,updated_at)
	 VALUES($1,'CANCEL',$2,'','ACKNOWLEDGED',`+nowMS+`,`+nowMS+`)
	 ON CONFLICT(task_id,command) DO UPDATE SET attempt=$2,status='ACKNOWLEDGED',updated_at=`+nowMS, taskID, p.Attempt); err != nil {
		return p, err
	}
	p.State = domain.StateAborted
	return p, tx.Commit(ctx)
}
