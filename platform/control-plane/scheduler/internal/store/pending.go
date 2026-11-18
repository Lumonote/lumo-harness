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
	tx, err := s.beginWork(ctx)
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
	// 一次取出每个队列的前 limit 个到期任务（队列内顺序：EDF → 优先级 → 入队时刻），
	// 再在内存里按「虚拟服务量 → 优先级 → 入队时刻」逐个挑队首。全局顺序里被选中的永远是
	// 某个队列的队首，所以这与「每取一条就对整个到期集合重排一次」逐条等价，
	// 而数据库只排序一次。并发安全来自 checkFencing 持有的排他准入锁：所有改动
	// 虚拟服务量的路径都先过它。
	rows, err := tx.Query(ctx, `SELECT t.task_id,t.realm,t.cluster_id,t.requires,t.priority,t.residency,
		 t.deadline_ms,t.queue,t.weight,t.avoid_nodes,t.created_at,t.worker_id,t.project_id,t.preferred_clusters,
		 q.virtual_finish
		 FROM (SELECT p.*, row_number() OVER (PARTITION BY p.realm,p.queue
		         ORDER BY CASE WHEN p.deadline_ms=0 THEN 1 ELSE 0 END,p.deadline_ms,p.priority DESC,p.created_at,p.task_id) AS rn
		       FROM scheduler_tasks p WHERE p.state='PENDING' AND p.next_check_at <= `+nowMS+`) t
		 JOIN scheduler_queue_fairness q ON q.realm=t.realm AND q.queue=t.queue
		 WHERE t.rn <= $1 ORDER BY t.realm,t.queue,t.rn`, limit)
	if err != nil {
		return nil, err
	}
	type pendingQueue struct {
		realm, queue string
		finish       float64
		served       float64
		tasks        []domain.Task
		created      []int64
		changed      bool
	}
	var queues []*pendingQueue
	for rows.Next() {
		var t domain.Task
		var requires, avoid, preferred string
		var enqueued int64
		var finish float64
		if err := rows.Scan(&t.TaskID, &t.Realm, &t.ClusterID, &requires, &t.Priority, &t.Residency, &t.DeadlineMS,
			&t.Queue, &t.Weight, &avoid, &enqueued, &t.WorkerID, &t.ProjectID, &preferred, &finish); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(requires), &t.Requires); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(avoid), &t.AvoidNodes); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(preferred), &t.PreferredClusters); err != nil {
			rows.Close()
			return nil, err
		}
		t.EnqueuedAt = time.UnixMilli(enqueued)
		t.FromPending = true
		last := len(queues) - 1
		if last < 0 || queues[last].realm != t.Realm || queues[last].queue != t.Queue {
			queues = append(queues, &pendingQueue{realm: t.Realm, queue: t.Queue, finish: finish})
			last++
		}
		queues[last].tasks = append(queues[last].tasks, t)
		queues[last].created = append(queues[last].created, enqueued)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 跨队列的比较里**没有 deadline**。deadline 由请求体给出、任何调用方都能带，
	// 让它排在公平序之前，一个租户给每个任务带上很小的 deadline 就排到了所有租户
	// 的无 deadline 任务前面。它只在队列内生效（上面窗口函数的 ORDER BY）：
	// 调用方可以决定自己的任务谁先，不能决定自己比别人先。
	before := func(a, b *pendingQueue) bool {
		x, y := a.tasks[0], b.tasks[0]
		if a.finish != b.finish {
			return a.finish < b.finish
		}
		if x.Priority != y.Priority {
			return x.Priority > y.Priority
		}
		if a.created[0] != b.created[0] {
			return a.created[0] < b.created[0]
		}
		return x.TaskID < y.TaskID
	}
	out := make([]domain.Task, 0, limit)
	selected := make([]string, 0, limit)
	for len(out) < limit {
		var best *pendingQueue
		for _, q := range queues {
			if len(q.tasks) > 0 && (best == nil || before(q, best)) {
				best = q
			}
		}
		if best == nil {
			break
		}
		t := best.tasks[0]
		best.tasks, best.created = best.tasks[1:], best.created[1:]
		_, weight := normalizedQueue(t)
		best.finish += 1.0 / float64(weight)
		best.served += 1.0 / float64(weight)
		best.changed = true
		out = append(out, t)
		selected = append(selected, t.TaskID)
	}
	for _, q := range queues {
		if !q.changed {
			continue
		}
		// 写增量而不是绝对值：退还（DeferPending）不取准入锁，绝对值会把它盖掉。
		if _, err := tx.Exec(ctx, `UPDATE scheduler_queue_fairness SET virtual_finish=virtual_finish+$3
		 WHERE realm=$1 AND queue=$2`, q.realm, q.queue, q.served); err != nil {
			return nil, err
		}
	}
	if len(selected) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE scheduler_tasks SET next_check_at=`+nowMS+`+$2,
		 schedule_checks=schedule_checks+1 WHERE task_id=ANY($1)`, selected, retryAfter.Milliseconds()); err != nil {
			return nil, err
		}
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
	// 被选中时队列已记了 1/weight 的虚拟服务量（TakePending），而放不下的任务没有
	// 得到任何服务：同一条语句里退还，否则队首长期放不下的队列会在公平序里越排越后。
	_, err := s.pool.Exec(ctx, `WITH d AS (UPDATE scheduler_tasks SET pending_reason=$2,
	 next_check_at=`+nowMS+`+LEAST($4::bigint, $3::bigint * (1::bigint << LEAST(GREATEST(schedule_checks-1,0),10)))
	 WHERE task_id=$1 AND state='PENDING' RETURNING realm,queue,weight)
	 UPDATE scheduler_queue_fairness q SET virtual_finish=q.virtual_finish-1.0/LEAST(GREATEST(d.weight,1),$5)
	 FROM d WHERE q.realm=d.realm AND q.queue=d.queue`, taskID, reason, base.Milliseconds(), maximum.Milliseconds(), MaxQueueWeight)
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

// CapacityWaiterAhead 是否已有不低于该任务优先级的同 realm 任务在等容量。
//
// 只看 pending_reason='no-capacity'：因没有兼容节点或版本闸门排队的任务等的不是
// 槽位，让新提交排在它们后面只会白白增加延迟。集群约束不相交的任务互不相干。
func (s *Store) CapacityWaiterAhead(ctx context.Context, task domain.Task) (bool, error) {
	var ahead bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM scheduler_tasks
		WHERE state='PENDING' AND pending_reason='no-capacity' AND realm=$1 AND priority >= $2
		  AND task_id <> $3 AND ($4 = '' OR cluster_id = '' OR cluster_id = $4))`,
		task.Realm, task.Priority, task.TaskID, task.ClusterID).Scan(&ahead)
	return ahead, err
}

// WakeCapacityWaiters 让至多 limit 个等容量的任务跳过剩余退避（最早入队者优先）。
// 调用方在发现槽位释放时使用；有上限，所以积压很深时一次释放不会改写整张表。
func (s *Store) WakeCapacityWaiters(ctx context.Context, limit int) error {
	_, err := s.pool.Exec(ctx, `UPDATE scheduler_tasks SET next_check_at = 0
		WHERE task_id IN (SELECT task_id FROM scheduler_tasks
			WHERE state='PENDING' AND pending_reason='no-capacity' AND next_check_at > `+nowMS+`
			ORDER BY created_at LIMIT $1)`, limit)
	return err
}
