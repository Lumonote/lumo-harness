package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

func ensureQueueFairness(ctx context.Context, tx pgx.Tx, task domain.Task) error {
	queue, _ := normalizedQueue(task)
	_, err := tx.Exec(ctx, `INSERT INTO scheduler_queue_fairness AS q(realm,queue,virtual_finish)
	 VALUES($1,$2,COALESCE((SELECT min(f.virtual_finish) FROM scheduler_queue_fairness f
	 WHERE EXISTS(SELECT 1 FROM scheduler_tasks p WHERE p.realm=f.realm AND p.queue=f.queue AND p.state='PENDING')),0))
	 ON CONFLICT(realm,queue) DO UPDATE SET virtual_finish=GREATEST(q.virtual_finish,EXCLUDED.virtual_finish)`, task.Realm, queue)
	return err
}

// TakePending advances durable weighted virtual service before returning a
// bounded batch. Selection uses the entire due queue, not a globally truncated
// priority prefix. A crash or leadership change retains both fairness and the
// short selection lease; unplaceable heads cannot hide other queues forever.
func (s *Store) TakePending(ctx context.Context, lease *domain.Lease, limit int, retryAfter time.Duration) ([]domain.Task, error) {
	if limit < 1 || limit > 4096 || retryAfter < time.Millisecond {
		return nil, fmt.Errorf("scheduler: invalid pending batch or retry interval")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := checkFencing(ctx, tx, lease); err != nil {
		return nil, err
	}
	// Backfill queue cursors for tasks created before the fairness schema. New
	// submissions already join the active floor inside QueueTask.
	if _, err := tx.Exec(ctx, `INSERT INTO scheduler_queue_fairness(realm,queue,virtual_finish)
		SELECT DISTINCT t.realm,t.queue,COALESCE((SELECT min(q.virtual_finish) FROM scheduler_queue_fairness q
		 WHERE EXISTS(SELECT 1 FROM scheduler_tasks p WHERE p.realm=q.realm AND p.queue=q.queue AND p.state='PENDING')),0)
		FROM scheduler_tasks t WHERE t.state='PENDING'
		ON CONFLICT(realm,queue) DO NOTHING`); err != nil {
		return nil, err
	}
	out := make([]domain.Task, 0, limit)
	selected := make([]string, 0, limit)
	for len(out) < limit {
		var t domain.Task
		var requires, avoid, preferred string
		var enqueued int64
		err := tx.QueryRow(ctx, `SELECT t.task_id,t.realm,t.cluster_id,t.requires,t.priority,t.residency,
		 t.deadline_ms,t.queue,t.weight,t.avoid_nodes,t.created_at,t.worker_id,t.project_id,t.preferred_clusters
		 FROM scheduler_tasks t JOIN scheduler_queue_fairness q ON q.realm=t.realm AND q.queue=t.queue
		 WHERE t.state='PENDING' AND t.next_check_at <= `+nowMS+` AND t.task_id<>ALL($1::text[])
		 ORDER BY CASE WHEN t.deadline_ms=0 THEN 1 ELSE 0 END,t.deadline_ms,
		 q.virtual_finish,t.priority DESC,t.created_at,t.task_id LIMIT 1 FOR UPDATE OF t,q`, selected).
			Scan(&t.TaskID, &t.Realm, &t.ClusterID, &requires, &t.Priority, &t.Residency, &t.DeadlineMS,
				&t.Queue, &t.Weight, &avoid, &enqueued, &t.WorkerID, &t.ProjectID, &preferred)
		if err == pgx.ErrNoRows {
			break
		}
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(requires), &t.Requires); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(avoid), &t.AvoidNodes); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(preferred), &t.PreferredClusters); err != nil {
			return nil, err
		}
		t.EnqueuedAt = time.UnixMilli(enqueued)
		t.FromPending = true
		_, weight := normalizedQueue(t)
		if _, err := tx.Exec(ctx, `UPDATE scheduler_queue_fairness SET virtual_finish=virtual_finish+1.0/$3
		 WHERE realm=$1 AND queue=$2`, t.Realm, t.Queue, weight); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE scheduler_tasks SET next_check_at=`+nowMS+`+$2,
		 schedule_checks=schedule_checks+1 WHERE task_id=$1`, t.TaskID, retryAfter.Milliseconds()); err != nil {
			return nil, err
		}
		out = append(out, t)
		selected = append(selected, t.TaskID)
	}
	return out, tx.Commit(ctx)
}

// DeferPending records the operational cause and backs off only a task that
// remains pending. Rechecks are bounded, so a recovered device is rediscovered.
func (s *Store) DeferPending(ctx context.Context, taskID, reason string, base, maximum time.Duration) error {
	if base < time.Millisecond || maximum < base {
		return fmt.Errorf("scheduler: invalid pending backoff")
	}
	switch reason {
	case "worker-directory-unavailable", "no-compatible-node", "no-capacity", "version-blocked", "catalog-unavailable", "store-unavailable":
	default:
		return fmt.Errorf("scheduler: invalid pending reason %q", reason)
	}
	_, err := s.pool.Exec(ctx, `UPDATE scheduler_tasks SET pending_reason=$2,
	 next_check_at=`+nowMS+`+LEAST($4::bigint, $3::bigint * (1::bigint << LEAST(GREATEST(schedule_checks-1,0),10)))
	 WHERE task_id=$1 AND state='PENDING'`, taskID, reason, base.Milliseconds(), maximum.Milliseconds())
	return err
}

type PendingReason struct {
	Reason        string
	Count         int64
	OldestSeconds float64
}

func (s *Store) PendingReasons(ctx context.Context) ([]PendingReason, error) {
	rows, err := s.pool.Query(ctx, `SELECT pending_reason,count(*),GREATEST(0,(`+nowMS+`-min(created_at))/1000.0)
	 FROM scheduler_tasks WHERE state='PENDING' GROUP BY pending_reason`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingReason
	for rows.Next() {
		var p PendingReason
		if err := rows.Scan(&p.Reason, &p.Count, &p.OldestSeconds); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
