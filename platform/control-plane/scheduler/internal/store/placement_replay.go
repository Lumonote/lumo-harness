package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

var ErrTaskIdentityConflict = errors.New("task id belongs to a different execution identity")

// ExistingPlacement is a read-only replay path. Directory refresh and leader
// election are needed for new execution, not for acknowledging an existing Run.
func (s *Store) ExistingPlacement(ctx context.Context, task domain.Task) (*domain.Placement, error) {
	var p domain.Placement
	var workerID, projectID string
	err := s.pool.QueryRow(ctx, `SELECT task_id,realm,state,COALESCE(node_id,''),attempt,fencing_token,worker_id,project_id
	  FROM scheduler_tasks WHERE task_id=$1`, task.TaskID).
		Scan(&p.TaskID, &p.Realm, &p.State, &p.NodeID, &p.Attempt, &p.FencingToken, &workerID, &projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if p.Realm != task.Realm || workerID != task.WorkerID || projectID != task.ProjectID {
		return nil, ErrTaskIdentityConflict
	}
	if p.State.Active() || (workerID != "" && p.State.Terminal()) {
		return &p, nil
	}
	return nil, nil
}
