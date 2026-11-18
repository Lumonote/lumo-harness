package store

import (
	"context"
	"fmt"
	"time"
)

// 抢占的两条约束，都建立在停止命令上的 waiter_task_id（「为谁腾的槽」）之上。
//
// 抢占是分两步兑现的：先请求停止（受害者进 CANCELLING，槽位仍被占着），等节点
// 回报终态后槽位才真正空出来，再由 drain 把等待者放上去。两步之间没有任何东西
// 把「这次停止」与「那个等待者」绑在一起时，会出两类问题：
//
//   - 槽位空出来的那一刻，取队列顺序里排在等待者前面的任务（公平序先于优先级）
//     先拿走它；等待者还是放不下，于是再杀一个——受害者白死，且可以连环发生；
//   - 受害者停止期间等待者每被重查一次都还是「放不下」，而受害者筛选只排除
//     「已有停止命令在途的那个任务」，于是每次重查再挑一个新的受害者。

// SlotReservation 一个为等待者腾出、尚未被它取走的槽位。
type SlotReservation struct {
	NodeID         string
	WaiterTaskID   string
	WaiterPriority int
}

// SlotReservations 当前有效的槽位预留。
//
// 一条预留成立的条件，缺一不可：
//
//   - 受害者的那一代 attempt 已到终态——在此之前槽位还被它占着，不需要预留；
//   - 终态落库不超过 hold——等待者始终没来取（比如该节点对它已不再合格）时，
//     不能让槽位永久空置；
//   - 等待者仍在排队，且排队原因是等容量或尚未被检查过——它被取消、被放到别处、
//     或因别的原因（没有兼容节点、版本闸门）排队时，预留立即失效。
//
// 时刻一律取库端时钟（同 StalledActiveTasks 的理由）。
func (s *Store) SlotReservations(ctx context.Context, hold time.Duration) ([]SlotReservation, error) {
	if hold < time.Millisecond {
		return nil, fmt.Errorf("scheduler: invalid reservation hold")
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.node_id, w.task_id, w.priority
		FROM scheduler_control_commands c
		JOIN scheduler_task_attempts a ON a.task_id = c.task_id AND a.attempt = c.attempt
		JOIN scheduler_tasks w ON w.task_id = c.waiter_task_id
		WHERE c.command = 'PREEMPT' AND c.waiter_task_id <> '' AND c.node_id <> ''
		  AND a.state = ANY($1) AND a.updated_at > `+nowMS+` - $2
		  AND w.state = 'PENDING' AND w.pending_reason IN ('no-capacity', 'awaiting-placement')
		ORDER BY c.node_id, w.task_id`, TerminalStates(), hold.Milliseconds())
	if err != nil {
		return nil, fmt.Errorf("scheduler: 查询槽位预留失败: %w", err)
	}
	defer rows.Close()
	var out []SlotReservation
	for rows.Next() {
		var r SlotReservation
		if err := rows.Scan(&r.NodeID, &r.WaiterTaskID, &r.WaiterPriority); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描槽位预留失败: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PreemptionOutstanding 该等待者是否已有一次尚未兑现的抢占。为真时不得再为它
// 挑新的受害者。
//
// 「尚未兑现」是两段：
//
//   - 停止在途：命令已发出或已被节点确认，受害者那一代仍是活跃态。以命令最近一次
//     写入起算，超过 stopGrace 不再算数——节点一直不回报终态时，等待者不能被一个
//     卡死的受害者永久挡住。投递失败（FAILED）不算在途：那次停止没有送达，
//     应当允许重试；
//   - 槽位已腾出、等待者还没取走：与 SlotReservations 同一条期限（hold）。过了
//     期限预留失效，槽位可能已被别人拿走，等待者有权重新抢占。
func (s *Store) PreemptionOutstanding(ctx context.Context, waiterTaskID string, stopGrace, hold time.Duration) (bool, error) {
	if waiterTaskID == "" {
		return false, nil
	}
	var outstanding bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM scheduler_control_commands c
			JOIN scheduler_task_attempts a ON a.task_id = c.task_id AND a.attempt = c.attempt
			WHERE c.command = 'PREEMPT' AND c.waiter_task_id = $1
			  AND ((a.state = ANY($2) AND c.status IN ('REQUESTED', 'ACKNOWLEDGED')
			        AND c.updated_at > `+nowMS+` - $4)
			    OR (a.state = ANY($3) AND a.updated_at > `+nowMS+` - $5)))`,
		waiterTaskID, ActiveStates(), TerminalStates(), stopGrace.Milliseconds(), hold.Milliseconds()).Scan(&outstanding)
	if err != nil {
		return false, fmt.Errorf("scheduler: 查询未兑现的抢占失败: %w", err)
	}
	return outstanding, nil
}

// WakePending 让指定的排队任务跳过剩余退避。只动仍在排队且确实在退避中的行。
//
// 给预留的等待者用：WakeCapacityWaiters 按入队时刻唤醒有限个，积压很深时不保证
// 轮到它，而预留是有期限的。
func (s *Store) WakePending(ctx context.Context, taskIDs []string) error {
	if len(taskIDs) == 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `UPDATE scheduler_tasks SET next_check_at = 0
		WHERE task_id = ANY($1) AND state = 'PENDING' AND next_check_at > `+nowMS, taskIDs); err != nil {
		return fmt.Errorf("scheduler: 唤醒排队任务失败: %w", err)
	}
	return nil
}
