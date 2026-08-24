// Package store 实现调度服务的持久化：租约、放置事务、任务生命周期。
//
// fencing 校验点是放置事务内对租约行的 FOR UPDATE 锁：它同时把并发放置
// 串行化，槽位计数因此无竞态（spec §4）。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/scheduler/internal/dispatch"
	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// nowMS 库端当前时刻（毫秒）。所有租约与时间比较都走它，不用节点本地时钟。
const nowMS = `(EXTRACT(EPOCH FROM now()) * 1000)::bigint`

// DDL 调度服务的表结构（幂等）。
const DDL = `
CREATE TABLE IF NOT EXISTS scheduler_leader_lease (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder        TEXT    NOT NULL,
  fencing_token BIGINT  NOT NULL,
  expires_at    BIGINT  NOT NULL
);

-- 预插空租约行：让 acquire 的 UPSERT 恒走 UPDATE 分支，语义单一
INSERT INTO scheduler_leader_lease (id, holder, fencing_token, expires_at)
SELECT 1, '', 0, 0 WHERE NOT EXISTS (SELECT 1 FROM scheduler_leader_lease WHERE id = 1);

CREATE TABLE IF NOT EXISTS scheduler_nodes (
  node_id       TEXT    PRIMARY KEY,
  cluster_id    TEXT    NOT NULL,
  capacity      INTEGER NOT NULL,
  capabilities  TEXT    NOT NULL,  -- JSON 数组文本（NUL 教训：payload 类列一律 TEXT）
  registered_at BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_tasks (
  task_id       TEXT    PRIMARY KEY,
  realm         TEXT    NOT NULL,
  cluster_id    TEXT    NOT NULL,
  requires      TEXT    NOT NULL,  -- JSON 文本
  priority      INTEGER NOT NULL DEFAULT 0,
  state         TEXT    NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 0,
  node_id       TEXT,
  fencing_token BIGINT  NOT NULL DEFAULT 0,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_pending
  ON scheduler_tasks (priority DESC, created_at) WHERE state = 'PENDING';

CREATE TABLE IF NOT EXISTS scheduler_dispatch_outbox (
  id         BIGSERIAL PRIMARY KEY,
  task_id    TEXT    NOT NULL,
  attempt    INTEGER NOT NULL,
  node_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,  -- JSON 文本
  claimed_by TEXT,
  claimed_at BIGINT,
  created_at BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON scheduler_dispatch_outbox (node_id, id) WHERE claimed_by IS NULL;

-- 对账账本（降级占位语义：只接收 + 去重 + 落账）
CREATE TABLE IF NOT EXISTS scheduler_reconcile_ledger (
  entry_id    TEXT   PRIMARY KEY,
  task_id     TEXT   NOT NULL,
  cluster_id  TEXT   NOT NULL,
  state       TEXT   NOT NULL,
  recorded_at BIGINT NOT NULL
);
`

// Store 调度服务持久层。
type Store struct {
	pool *pgxpool.Pool
	sink dispatch.Sink
}

// New 建立连接池；默认派发落点为 PG outbox（§13.2 本地替代 RocketMQ）。
func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 连接 PG 失败: %w", err)
	}
	return &Store{pool: pool, sink: dispatch.PgSink{}}, nil
}

// NewWithSink 注入派发落点（测试注入故障 sink 验证回滚；生产换 relay 语义）。
func NewWithSink(ctx context.Context, dsn string, sink dispatch.Sink) (*Store, error) {
	s, err := New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s.sink = sink
	return s, nil
}

// Init 幂等建表（含预插空租约行）。
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("scheduler: 建表失败: %w", err)
	}
	return nil
}

// Pool 暴露连接池给同进程的目录与测试组件。
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Close 关闭连接池。
func (s *Store) Close() { s.pool.Close() }

// Acquire 建租 / 续租 / 接管三种情形一条语句完成（session-log 同形）。
//
// 续租不换 token（换则持有者自己的在途写会被自己的新 token 判为过期），
// 易主才 +1。返回 ErrNotAcquired 表示他人持有未过期租约——调用方不应等待。
func (s *Store) Acquire(ctx context.Context, holder string, ttlMs int64) (*domain.Lease, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO scheduler_leader_lease (id, holder, fencing_token, expires_at)
		VALUES (1, $1, 1, `+nowMS+` + $2)
		ON CONFLICT (id) DO UPDATE SET
			holder = EXCLUDED.holder,
			fencing_token = CASE WHEN scheduler_leader_lease.holder = EXCLUDED.holder
				THEN scheduler_leader_lease.fencing_token
				ELSE scheduler_leader_lease.fencing_token + 1 END,
			expires_at = EXCLUDED.expires_at
		WHERE scheduler_leader_lease.holder = EXCLUDED.holder
		   OR scheduler_leader_lease.expires_at < `+nowMS+`
		RETURNING holder, fencing_token, expires_at`,
		holder, ttlMs)
	var l domain.Lease
	if err := row.Scan(&l.Holder, &l.FencingToken, &l.ExpiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotAcquired
		}
		return nil, fmt.Errorf("scheduler: acquire 失败: %w", err)
	}
	return &l, nil
}

// Release 令租约立即过期而非删行：token 高水位不回落，删行会让下一个
// 持有者从 1 重新开始，旧持有者的过期令牌反而「复活」（spec §3 不变式 3）。
func (s *Store) Release(ctx context.Context, holder string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE scheduler_leader_lease SET expires_at = 0
		WHERE id = 1 AND holder = $1`, holder); err != nil {
		return fmt.Errorf("scheduler: release 失败: %w", err)
	}
	return nil
}

// CurrentLease 读取当前租约；无持有者（expires_at=0 空租约哨兵）返回 nil。
func (s *Store) CurrentLease(ctx context.Context) (*domain.Lease, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT holder, fencing_token, expires_at FROM scheduler_leader_lease WHERE id = 1`)
	var l domain.Lease
	if err := row.Scan(&l.Holder, &l.FencingToken, &l.ExpiresAt); err != nil {
		return nil, fmt.Errorf("scheduler: 读租约失败: %w", err)
	}
	if l.ExpiresAt == 0 {
		return nil, nil
	}
	return &l, nil
}

// checkFencing 校验本节点仍是当前代 leader：holder、token、租约未过期三者全对。
// FOR UPDATE 锁租约行——同时把并发放置串行化（槽位闸无竞态的前提，spec §4）。
func checkFencing(ctx context.Context, tx pgx.Tx, lease *domain.Lease) error {
	var token int64
	err := tx.QueryRow(ctx, `
		SELECT fencing_token FROM scheduler_leader_lease
		WHERE id = 1 AND holder = $1 AND expires_at > `+nowMS+`
		FOR UPDATE`, lease.Holder).Scan(&token)
	if errors.Is(err, pgx.ErrNoRows) {
		// holder 已易主，或租约已过期（此刻任何人可接管，本节点已无排他性）
		return &domain.FencedOutError{Token: lease.FencingToken}
	}
	if err != nil {
		return fmt.Errorf("scheduler: 读租约失败: %w", err)
	}
	if token != lease.FencingToken {
		return &domain.FencedOutError{Token: lease.FencingToken, Current: token}
	}
	return nil
}

// PlaceTask 把任务放到指定节点：fencing 校验 + 槽位闸 + attempt 单飞 + outbox 同事务。
//
// 幂等语义：任务已有活跃 attempt 时返回既有放置，不产生第二次派发；
// 旧 attempt 已终态（或任务仅 PENDING）时开启 attempt+1。
// attempt 单飞由本事务的 FOR UPDATE + 状态检查保证——task_id 是主键，
// 每任务只有一行，无需 spec §4 初稿设想的唯一部分索引。
func (s *Store) PlaceTask(ctx context.Context, lease *domain.Lease, task domain.Task, nodeID string) (domain.Placement, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := checkFencing(ctx, tx, lease); err != nil {
		return domain.Placement{}, err
	}

	// 槽位闸：事务内计数。租约行 FOR UPDATE 已把并发放置串行化，计数无竞态。
	var capacity int
	if err := tx.QueryRow(ctx,
		`SELECT capacity FROM scheduler_nodes WHERE node_id = $1`, nodeID).Scan(&capacity); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Placement{}, &domain.NoCapacityError{}
		}
		return domain.Placement{}, fmt.Errorf("scheduler: 查询节点容量失败: %w", err)
	}
	var active int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM scheduler_tasks
		WHERE node_id = $1 AND state IN ('PLACED', 'RUNNING')`, nodeID).Scan(&active); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 槽位计数失败: %w", err)
	}
	if active >= capacity {
		return domain.Placement{}, &domain.NoCapacityError{}
	}

	// attempt 单飞判定
	var prevState string
	var prevNode *string
	var prevAttempt int
	var prevToken int64
	err = tx.QueryRow(ctx, `
		SELECT state, node_id, attempt, fencing_token FROM scheduler_tasks
		WHERE task_id = $1 FOR UPDATE`, task.TaskID).
		Scan(&prevState, &prevNode, &prevAttempt, &prevToken)
	if err == nil && domain.TaskState(prevState).Active() {
		if err := tx.Commit(ctx); err != nil {
			return domain.Placement{}, fmt.Errorf("scheduler: 提交幂等返回失败: %w", err)
		}
		p := domain.Placement{TaskID: task.TaskID, Attempt: prevAttempt,
			State: domain.TaskState(prevState), FencingToken: prevToken}
		if prevNode != nil {
			p.NodeID = *prevNode
		}
		return p, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return domain.Placement{}, fmt.Errorf("scheduler: 查询任务失败: %w", err)
	}
	attempt := 1
	if err == nil {
		attempt = prevAttempt + 1 // 终态或 PENDING：开启新 attempt
	}

	requiresJSON, err := json.Marshal(task.Requires)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 序列化 requires 失败: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, priority, state, attempt, node_id, fencing_token, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'PLACED', $6, $7, $8, `+nowMS+`, `+nowMS+`)
		ON CONFLICT (task_id) DO UPDATE SET
			state = 'PLACED', attempt = $6, node_id = $7,
			fencing_token = $8, requires = $4, updated_at = `+nowMS+``,
		task.TaskID, task.Realm, task.ClusterID, string(requiresJSON), task.Priority,
		attempt, nodeID, lease.FencingToken); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写任务失败: %w", err)
	}

	if err := s.sink.WriteInto(ctx, tx, dispatch.Envelope{
		TaskID:    task.TaskID,
		Attempt:   attempt,
		NodeID:    nodeID,
		Realm:     task.Realm,
		ClusterID: task.ClusterID,
		Priority:  task.Priority,
		Requires:  task.Requires,
	}); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写派发失败: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 提交放置失败: %w", err)
	}
	return domain.Placement{
		TaskID: task.TaskID, NodeID: nodeID, Attempt: attempt,
		State: domain.StatePlaced, FencingToken: lease.FencingToken,
	}, nil
}

// QueueTask 无候选节点时把任务落 PENDING（drain loop 后续重试）。
// 幂等：活跃 attempt 保持不变；终态任务重置回 PENDING（保留 attempt 高水位，
// 下次放置自然 +1）。
func (s *Store) QueueTask(ctx context.Context, lease *domain.Lease, task domain.Task) (domain.TaskState, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := checkFencing(ctx, tx, lease); err != nil {
		return "", err
	}

	var state string
	err = tx.QueryRow(ctx, `SELECT state FROM scheduler_tasks WHERE task_id = $1 FOR UPDATE`, task.TaskID).Scan(&state)
	if err == nil {
		if domain.TaskState(state).Terminal() {
			if _, err := tx.Exec(ctx, `
				UPDATE scheduler_tasks SET state = 'PENDING', updated_at = `+nowMS+`
				WHERE task_id = $1`, task.TaskID); err != nil {
				return "", fmt.Errorf("scheduler: 重置排队失败: %w", err)
			}
			state = string(domain.StatePending)
		}
		if err := tx.Commit(ctx); err != nil {
			return "", fmt.Errorf("scheduler: 提交排队失败: %w", err)
		}
		return domain.TaskState(state), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("scheduler: 查询任务失败: %w", err)
	}

	requiresJSON, err := json.Marshal(task.Requires)
	if err != nil {
		return "", fmt.Errorf("scheduler: 序列化 requires 失败: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, priority, state, attempt, fencing_token, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'PENDING', 0, $6, `+nowMS+`, `+nowMS+`)`,
		task.TaskID, task.Realm, task.ClusterID, string(requiresJSON), task.Priority, lease.FencingToken); err != nil {
		return "", fmt.Errorf("scheduler: 写排队任务失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("scheduler: 提交排队失败: %w", err)
	}
	return domain.StatePending, nil
}

// CompleteTask 执行器回报终态：仅从活跃态转终态，幂等。
// 不需要 fencing：这不是放置决策（N1 只管放置写入），状态条件 UPDATE 天然幂等。
func (s *Store) CompleteTask(ctx context.Context, taskID string, final domain.TaskState) (domain.Placement, error) {
	if !final.Terminal() {
		return domain.Placement{}, fmt.Errorf("scheduler: 非终态回报 %q", final)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE scheduler_tasks SET state = $2, updated_at = `+nowMS+`
		WHERE task_id = $1 AND state IN ('PLACED', 'RUNNING')`, taskID, string(final))
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 回报终态失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return s.GetPlacement(ctx, taskID) // 已终态 → 幂等返回现有；不存在 → TaskNotFound
	}
	return s.GetPlacement(ctx, taskID)
}

// GetPlacement 查询任务当前状态（API 观测用）。
func (s *Store) GetPlacement(ctx context.Context, taskID string) (domain.Placement, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT state, node_id, attempt, fencing_token FROM scheduler_tasks WHERE task_id = $1`, taskID)
	var p domain.Placement
	var state string
	var nodeID *string
	if err := row.Scan(&state, &nodeID, &p.Attempt, &p.FencingToken); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Placement{}, &domain.TaskNotFoundError{TaskID: taskID}
		}
		return domain.Placement{}, fmt.Errorf("scheduler: 查询放置失败: %w", err)
	}
	p.TaskID = taskID
	p.State = domain.TaskState(state)
	if nodeID != nil {
		p.NodeID = *nodeID
	}
	return p, nil
}

// PendingTasks 供 drain loop 取排队任务（priority 高者先，同优先级先到先得）。
func (s *Store) PendingTasks(ctx context.Context, limit int) ([]domain.Task, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT task_id, realm, cluster_id, requires, priority FROM scheduler_tasks
		WHERE state = 'PENDING' ORDER BY priority DESC, created_at LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 取排队任务失败: %w", err)
	}
	defer rows.Close()
	var out []domain.Task
	for rows.Next() {
		var t domain.Task
		var requires string
		if err := rows.Scan(&t.TaskID, &t.Realm, &t.ClusterID, &requires, &t.Priority); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描排队任务失败: %w", err)
		}
		if err := json.Unmarshal([]byte(requires), &t.Requires); err != nil {
			return nil, fmt.Errorf("scheduler: 解析 requires 失败: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ActiveCounts 每节点活跃放置数（放置规划的槽位输入）。
func (s *Store) ActiveCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT node_id, count(*) FROM scheduler_tasks
		WHERE state IN ('PLACED', 'RUNNING') GROUP BY node_id`)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 活跃计数失败: %w", err)
	}
	defer rows.Close()
	out := make(map[string]int)
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描活跃计数失败: %w", err)
		}
		out[id] = n
	}
	return out, rows.Err()
}

// ClaimDispatch 执行节点认领派发给它的信封；claimed_by 置位即被取走（幂等）。
//
// 两处刻意为之：① 结果按 id 排序返回——`UPDATE ... RETURNING` 的行序不保证，
// 而派发队列必须 FIFO，故用 CTE 在外层再排一次；② SKIP LOCKED 让多个节点
// 并发认领互不阻塞（各取各的行，不会重复投递）。
func (s *Store) ClaimDispatch(ctx context.Context, nodeID string, limit int) ([]dispatch.Envelope, error) {
	rows, err := s.pool.Query(ctx, `
		WITH picked AS (
			SELECT id FROM scheduler_dispatch_outbox
			WHERE node_id = $1 AND claimed_by IS NULL
			ORDER BY id LIMIT $2
			FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE scheduler_dispatch_outbox o
			SET claimed_by = $1, claimed_at = `+nowMS+`
			FROM picked WHERE o.id = picked.id
			RETURNING o.id, o.payload
		)
		SELECT payload FROM claimed ORDER BY id`, nodeID, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 认领派发失败: %w", err)
	}
	defer rows.Close()
	var out []dispatch.Envelope
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描派发失败: %w", err)
		}
		var env dispatch.Envelope
		if err := json.Unmarshal([]byte(payload), &env); err != nil {
			return nil, fmt.Errorf("scheduler: 解析派发失败: %w", err)
		}
		out = append(out, env)
	}
	return out, rows.Err()
}

// ReconcileEntry 集群本地放置记录（降级对账，占位语义）。
type ReconcileEntry struct {
	EntryID   string `json:"entry_id"`
	TaskID    string `json:"task_id"`
	ClusterID string `json:"cluster_id"`
	State     string `json:"state"`
}

// Reconcile 对账占位语义（spec §6）：接收 + 去重 + 落账，需 leader。
// 多集群的合并裁决逻辑留给 §7.4 集群 Scheduler 交付时实现——接口形状现在定死。
func (s *Store) Reconcile(ctx context.Context, lease *domain.Lease, entries []ReconcileEntry) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("scheduler: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := checkFencing(ctx, tx, lease); err != nil {
		return 0, err
	}
	inserted := 0
	for _, e := range entries {
		if e.EntryID == "" {
			continue
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO scheduler_reconcile_ledger (entry_id, task_id, cluster_id, state, recorded_at)
			VALUES ($1, $2, $3, $4, `+nowMS+`)
			ON CONFLICT (entry_id) DO NOTHING`,
			e.EntryID, e.TaskID, e.ClusterID, e.State)
		if err != nil {
			return 0, fmt.Errorf("scheduler: 对账落账失败: %w", err)
		}
		inserted += int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("scheduler: 提交对账失败: %w", err)
	}
	return inserted, nil
}
