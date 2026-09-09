package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/governance/internal/domain"
)

func prepareTaskIntent(ctx context.Context, tx pgx.Tx, task *domain.DelegatedTask) error {
	contract, err := domain.NormalizeIntent(task.Intent, task.IntentContract)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if contract.ParentTaskID != "" {
		if contract.ParentTaskID == task.ID {
			return fmt.Errorf("%w: task cannot delegate to itself", ErrBadRequest)
		}
		var parent domain.DelegatedTask
		// Parent creation/closure uses the same row lock: a completed parent
		// cannot race a child insert and silently acquire new unfinished work.
		err := scanDelegatedTask(tx.QueryRow(ctx, delegationSelect+` WHERE t.realm=$1 AND t.id=$2 FOR UPDATE OF t`, task.Realm, contract.ParentTaskID), &parent)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if parent.ProjectID != task.ProjectID || (parent.RequesterUserID != task.RequesterUserID && parent.AssigneeUserID != task.RequesterUserID) {
			return ErrForbidden
		}
		if !domain.DelegationStateActive(parent.State) || parent.BusinessState == domain.BusinessDone || parent.BusinessState == domain.BusinessRejected || parent.BusinessState == domain.BusinessArchived {
			return fmt.Errorf("%w: parent is no longer accepting delegated work", ErrConflict)
		}
		parentIntent, err := domain.NormalizeIntent(parent.Intent, parent.IntentContract)
		if err != nil {
			return err
		}
		if parent.IntentContract != nil {
			parentIntent = *parent.IntentContract
		}
		contract, err = domain.InheritIntent(contract, parentIntent)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
		if err := preservesParentSchedule(parent.Schedule, task.Schedule); err != nil {
			return err
		}
	}
	task.IntentContract = &contract
	return nil
}

func parentAcceptsWork(ctx context.Context, tx pgx.Tx, task domain.DelegatedTask) error {
	if task.IntentContract == nil || task.IntentContract.ParentTaskID == "" {
		return nil
	}
	var state string
	err := tx.QueryRow(ctx, `SELECT COALESCE(business_state,'') FROM governance_delegation_tasks WHERE realm=$1 AND id=$2 FOR UPDATE`, task.Realm, task.IntentContract.ParentTaskID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if state == domain.BusinessDone || state == domain.BusinessRejected || state == domain.BusinessArchived {
		return fmt.Errorf("%w: parent task is closed", ErrConflict)
	}
	return nil
}

// A child must preserve hard placement boundaries. Execution-specific skill
// requirements can differ across children, but residency/trust/cluster limits,
// forbidden devices and the superior's deadline must not be weakened.
func preservesParentSchedule(parentRaw, childRaw json.RawMessage) error {
	var parent, child struct {
		ClusterID  string   `json:"cluster_id"`
		Residency  string   `json:"residency"`
		TrustLevel string   `json:"trust_level"`
		DeadlineMS int64    `json:"deadline_ms"`
		AvoidNodes []string `json:"avoid_nodes"`
	}
	if len(parentRaw) > 0 && json.Unmarshal(parentRaw, &parent) != nil {
		return fmt.Errorf("%w: invalid parent schedule", ErrBadRequest)
	}
	if len(childRaw) > 0 && json.Unmarshal(childRaw, &child) != nil {
		return fmt.Errorf("%w: invalid child schedule", ErrBadRequest)
	}
	if (parent.ClusterID != "" && parent.ClusterID != child.ClusterID) ||
		(parent.Residency != "" && parent.Residency != child.Residency) ||
		(parent.TrustLevel != "" && parent.TrustLevel != child.TrustLevel) ||
		(parent.DeadlineMS > 0 && (child.DeadlineMS == 0 || child.DeadlineMS > parent.DeadlineMS)) {
		return fmt.Errorf("%w: child schedule weakens parent constraints", ErrBadRequest)
	}
	for _, forbidden := range parent.AvoidNodes {
		found := false
		for _, id := range child.AvoidNodes {
			if id == forbidden {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("%w: child schedule removes parent device exclusion", ErrBadRequest)
		}
	}
	return nil
}

func (s *Store) ListChildTasks(ctx context.Context, realm, parentID string) ([]domain.DelegatedTask, error) {
	rows, err := s.pool.Query(ctx, delegationSelect+` WHERE t.realm=$1 AND t.intent_contract->>'parent_task_id'=$2 ORDER BY t.created_at,t.id LIMIT 200`, realm, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := make([]domain.DelegatedTask, 0)
	for rows.Next() {
		var task domain.DelegatedTask
		if err := scanDelegatedTask(rows, &task); err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}
