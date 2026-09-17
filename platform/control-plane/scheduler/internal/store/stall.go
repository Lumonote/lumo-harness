package store

import (
	"context"
	"fmt"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// ActiveStates 占据节点槽位、不允许开新 attempt 的状态。
//
// 从 domain 常量拼出来，不在 SQL 里写字符串字面量：字面量一旦与状态机脱节，
// 改状态名时这里会静默漏掉一个，而漏掉的那一态会变成「永远不会被判定停滞」——
// 又一条看起来对、实际不工作的规则。
func ActiveStates() []string {
	return []string{
		string(domain.StatePlaced),
		string(domain.StateRunning),
		string(domain.StateCancelling),
	}
}

// StalledActive 一个活跃任务及其当前 attempt 的静默时长。
type StalledActive struct {
	TaskID    string
	Realm     string
	ClusterID string
	NodeID    string
	Attempt   int
	State     string
	// StalledMS 距该 attempt 最近一次被写入的毫秒数。**由库端算**（nowMS 减
	// updated_at），不在应用侧相减：应用与库的时钟不一定一致，跨时钟相减会把
	// 时钟偏差算成停滞时长——偏差大一点就可能凭空造出一批「停滞 8 小时」的任务。
	StalledMS int64
}

// StalledActiveTasks 取全部活跃任务（PLACED / RUNNING / CANCELLING）。
//
// 时钟取 **attempt 行**的 updated_at，不是 scheduler_tasks.updated_at。后者只在
// 状态**跃迁**时前进（见 reconcile：stateRank 不前进就不写 updated_at），于是一个
// 正常跑了 9 小时的 RUNNING 任务与「卡死 9 小时」在它眼里完全一样——拿它当停滞
// 判据会成批误杀长任务。attempt 行则在每次对账上报时无条件刷新，更接近「最近
// 一次听到它的消息」。
//
// 精度受限于节点上报频率，这一点无法在存储层弥补，所以判定侧还必须有更硬的
// 闸门（节点必须已不在目录中），时长只当宽限期用。见 server 侧 stalledBy。
//
// 查询带 WHERE state = ANY(...)，非活跃任务（含全部终态）不进结果集：终态行只增
// 不减，扫它们会让这个循环随着历史线性变慢。
func (s *Store) StalledActiveTasks(ctx context.Context) ([]StalledActive, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.task_id, t.realm, t.cluster_id, COALESCE(t.node_id, ''), t.attempt, t.state,
		       (`+nowMS+` - COALESCE(a.updated_at, t.updated_at)) AS stalled_ms
		FROM scheduler_tasks t
		LEFT JOIN scheduler_task_attempts a
		       ON a.task_id = t.task_id AND a.attempt = t.attempt
		WHERE t.state = ANY($1)`, ActiveStates())
	if err != nil {
		return nil, fmt.Errorf("scheduler: 查询活跃任务失败: %w", err)
	}
	defer rows.Close()
	var out []StalledActive
	for rows.Next() {
		var row StalledActive
		if err := rows.Scan(&row.TaskID, &row.Realm, &row.ClusterID, &row.NodeID,
			&row.Attempt, &row.State, &row.StalledMS); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描活跃任务失败: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// DeadLetterRecord 一条死信台账记录。判据的三个量（节点、停滞时长、快照年龄）
// 都落库，这样事后能复核这个决定当时依据了什么。
type DeadLetterRecord struct {
	TaskID     string
	Attempt    int
	Realm      string
	ClusterID  string
	NodeID     string
	Reason     string
	StalledMS  int64
	SnapshotMS int64
}

// DeadLetter 把一个已确认停滞的活跃任务转成死信，并留下台账。
//
// 条件写，两个条件缺一不可：状态仍是活跃的、attempt 仍是调用方观测到的那一代。
// 任一不成立就说明期间有人推进了它（节点回来了、被重试了、被取消了）——那时
// **什么都不做**才是对的。这个检查不能省：判定与落库之间隔着一次数据库往返和
// 一轮目录刷新，把「刚才观察到的事实」当成「现在仍然成立」是这类收割逻辑最
// 常见的错法。返回 false 表示条件已不成立、什么都没改，这不是错误。
//
// 终态用 FAILED 而不是 ABORTED：ABORTED 在状态机里的含义是「应请求停止」，
// 用它表达「平台放弃了」会让事后分不清两者。放弃这件事本身记在台账里。
//
// 台账与状态在同一事务内落库：分开写会出现「任务已 FAILED 但没人知道为什么」
// 的窗口，而死信的全部价值就在于解释那个 FAILED。
func (s *Store) DeadLetter(ctx context.Context, rec DeadLetterRecord) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE scheduler_tasks SET state = $3, updated_at = `+nowMS+`
		WHERE task_id = $1 AND attempt = $2 AND state = ANY($4)`,
		rec.TaskID, rec.Attempt, string(domain.StateFailed), ActiveStates())
	if err != nil {
		return false, fmt.Errorf("scheduler: 写死信状态失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}

	if _, err := tx.Exec(ctx, `
		UPDATE scheduler_task_attempts SET state = $3, updated_at = `+nowMS+`
		WHERE task_id = $1 AND attempt = $2`,
		rec.TaskID, rec.Attempt, string(domain.StateFailed)); err != nil {
		return false, fmt.Errorf("scheduler: 写死信 attempt 失败: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_dead_letters
			(task_id, attempt, realm, cluster_id, node_id, reason, stalled_ms, snapshot_ms, recorded_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,`+nowMS+`)
		ON CONFLICT (task_id, attempt) DO NOTHING`,
		rec.TaskID, rec.Attempt, rec.Realm, rec.ClusterID, rec.NodeID,
		rec.Reason, rec.StalledMS, rec.SnapshotMS); err != nil {
		return false, fmt.Errorf("scheduler: 写死信台账失败: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("scheduler: 提交死信失败: %w", err)
	}
	return true, nil
}

// DeadLetterRecorded 查询一个 (task_id, attempt) 是否已进死信台账。
// 供测试与运维核对用——台账是事后唯一能区分「平台放弃」与「节点回报失败」的地方。
func (s *Store) DeadLetterRecorded(ctx context.Context, taskID string, attempt int) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM scheduler_dead_letters WHERE task_id = $1 AND attempt = $2)`,
		taskID, attempt).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("scheduler: 查询死信台账失败: %w", err)
	}
	return exists, nil
}
