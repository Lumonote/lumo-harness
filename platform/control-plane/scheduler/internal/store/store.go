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
	"time"

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
  realm         TEXT    NOT NULL DEFAULT '',
  cluster_id    TEXT    NOT NULL,
  capacity      INTEGER NOT NULL,
  capabilities  TEXT    NOT NULL,  -- JSON 数组文本（NUL 教训：payload 类列一律 TEXT）
  residency     TEXT    NOT NULL DEFAULT '',
	control_url   TEXT    NOT NULL DEFAULT '',
  registered_at BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_tasks (
  task_id       TEXT    PRIMARY KEY,
  realm         TEXT    NOT NULL,
  cluster_id    TEXT    NOT NULL,
  requires      TEXT    NOT NULL,  -- JSON 文本
  priority      INTEGER NOT NULL DEFAULT 0,
  residency     TEXT    NOT NULL DEFAULT '',
  deadline_ms   BIGINT  NOT NULL DEFAULT 0,
  queue         TEXT    NOT NULL DEFAULT 'default',
  weight        INTEGER NOT NULL DEFAULT 1,
  avoid_nodes   TEXT    NOT NULL DEFAULT '[]',
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
	delivered_at BIGINT,
  created_at BIGINT  NOT NULL
);

ALTER TABLE scheduler_dispatch_outbox ADD COLUMN IF NOT EXISTS delivered_at BIGINT;
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS residency TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS control_url TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS realm TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS residency TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS deadline_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS queue TEXT NOT NULL DEFAULT 'default';
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS avoid_nodes TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON scheduler_dispatch_outbox (node_id, id) WHERE claimed_by IS NULL AND delivered_at IS NULL;

-- 对账账本（降级占位语义：只接收 + 去重 + 落账）
CREATE TABLE IF NOT EXISTS scheduler_reconcile_ledger (
  entry_id    TEXT   PRIMARY KEY,
  task_id     TEXT   NOT NULL,
  cluster_id  TEXT   NOT NULL,
  state       TEXT   NOT NULL,
  recorded_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_task_attempts (
  task_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  realm         TEXT NOT NULL,
  cluster_id    TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  state         TEXT NOT NULL,
  fencing_token BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (task_id, attempt)
);

-- Durable control-plane intent. The execution RPC is a delivery attempt, not
-- the source of truth: retries and failures remain observable after a node or
-- Scheduler restart.
CREATE TABLE IF NOT EXISTS scheduler_control_commands (
  task_id       TEXT NOT NULL,
  command       TEXT NOT NULL CHECK (command IN ('CANCEL','PREEMPT')),
  attempt       INTEGER NOT NULL DEFAULT 0,
  node_id       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('REQUESTED','ACKNOWLEDGED','FAILED')),
  detail        TEXT NOT NULL DEFAULT '',
  requested_at  BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (task_id, command)
);

-- Existing deployments originally accepted only CANCEL. Keep the migration
-- explicit so PREEMPT is never silently treated as an ordinary cancellation.
ALTER TABLE scheduler_control_commands DROP CONSTRAINT IF EXISTS scheduler_control_commands_command_check;
ALTER TABLE scheduler_control_commands ADD CONSTRAINT scheduler_control_commands_command_check
  CHECK (command IN ('CANCEL','PREEMPT'));
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
	// Multiple scheduler replicas may initialize the same database concurrently.
	// PostgreSQL's IF NOT EXISTS does not serialize creation of the backing
	// relation/type, so guard the whole schema transaction with a cluster-wide
	// advisory lock before executing the DDL.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("scheduler: 开启建表事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(781234567)`); err != nil {
		return fmt.Errorf("scheduler: 获取建表锁失败: %w", err)
	}
	if _, err := tx.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("scheduler: 建表失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("scheduler: 提交建表事务失败: %w", err)
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
		`SELECT capacity FROM scheduler_nodes WHERE node_id = $1 AND realm = $2`, nodeID, task.Realm).Scan(&capacity); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Placement{}, &domain.NoCapacityError{}
		}
		return domain.Placement{}, fmt.Errorf("scheduler: 查询节点容量失败: %w", err)
	}
	var active int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM scheduler_tasks
		WHERE node_id = $1 AND state IN ('PLACED', 'RUNNING', 'CANCELLING')`, nodeID).Scan(&active); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 槽位计数失败: %w", err)
	}
	if active >= capacity {
		return domain.Placement{}, &domain.NoCapacityError{}
	}

	// attempt 单飞判定
	var prevState string
	var prevNode *string
	var prevAttempt int
	var prevRealm string
	var prevToken int64
	err = tx.QueryRow(ctx, `
		SELECT state, realm, node_id, attempt, fencing_token FROM scheduler_tasks
		WHERE task_id = $1 FOR UPDATE`, task.TaskID).
		Scan(&prevState, &prevRealm, &prevNode, &prevAttempt, &prevToken)
	if err == nil && prevRealm != task.Realm {
		return domain.Placement{}, fmt.Errorf("scheduler: task_id 已由另一 realm 使用")
	}
	if err == nil && domain.TaskState(prevState).Active() {
		if err := tx.Commit(ctx); err != nil {
			return domain.Placement{}, fmt.Errorf("scheduler: 提交幂等返回失败: %w", err)
		}
		p := domain.Placement{TaskID: task.TaskID, Realm: task.Realm, Attempt: prevAttempt,
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
	avoidNodesJSON, err := json.Marshal(task.AvoidNodes)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 序列化反亲和节点失败: %w", err)
	}
	queue, weight := normalizedQueue(task)
	if _, err := tx.Exec(ctx, `
			INSERT INTO scheduler_tasks
				(task_id, realm, cluster_id, requires, priority, residency, deadline_ms, queue, weight, avoid_nodes, state, attempt, node_id, fencing_token, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PLACED', $11, $12, $13, `+nowMS+`, `+nowMS+`)
			ON CONFLICT (task_id) DO UPDATE SET
				state = 'PLACED', attempt = $11, node_id = $12,
				fencing_token = $13, requires = $4, residency = $6, deadline_ms = $7,
				queue = $8, weight = $9, avoid_nodes = $10, updated_at = `+nowMS+``,
		task.TaskID, task.Realm, task.ClusterID, string(requiresJSON), task.Priority,
		task.Residency, task.DeadlineMS, queue, weight, string(avoidNodesJSON), attempt, nodeID, lease.FencingToken); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写任务失败: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_task_attempts
			(task_id, attempt, realm, cluster_id, node_id, state, fencing_token, updated_at)
		VALUES ($1,$2,$3,$4,$5,'PLACED',$6,`+nowMS+`)
		ON CONFLICT (task_id, attempt) DO UPDATE SET node_id = EXCLUDED.node_id,
			state = EXCLUDED.state, fencing_token = EXCLUDED.fencing_token, updated_at = EXCLUDED.updated_at`,
		task.TaskID, attempt, task.Realm, task.ClusterID, nodeID, lease.FencingToken); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写 attempt 失败: %w", err)
	}

	if err := s.sink.WriteInto(ctx, tx, dispatch.Envelope{
		TaskID:     task.TaskID,
		Attempt:    attempt,
		NodeID:     nodeID,
		Realm:      task.Realm,
		ClusterID:  task.ClusterID,
		Priority:   task.Priority,
		Requires:   task.Requires,
		DeadlineMS: task.DeadlineMS, Queue: queue, Weight: weight, AvoidNodes: task.AvoidNodes,
	}); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 写派发失败: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 提交放置失败: %w", err)
	}
	return domain.Placement{
		TaskID: task.TaskID, Realm: task.Realm, NodeID: nodeID, Attempt: attempt,
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
	requiresJSON, err := json.Marshal(task.Requires)
	if err != nil {
		return "", fmt.Errorf("scheduler: 序列化 requires 失败: %w", err)
	}
	avoidNodesJSON, err := json.Marshal(task.AvoidNodes)
	if err != nil {
		return "", fmt.Errorf("scheduler: 序列化反亲和节点失败: %w", err)
	}
	queue, weight := normalizedQueue(task)

	var state string
	var existingRealm string
	err = tx.QueryRow(ctx, `SELECT state, realm FROM scheduler_tasks WHERE task_id = $1 FOR UPDATE`, task.TaskID).Scan(&state, &existingRealm)
	if err == nil && existingRealm != task.Realm {
		return "", fmt.Errorf("scheduler: task_id 已由另一 realm 使用")
	}
	if err == nil {
		if domain.TaskState(state).Terminal() {
			if _, err := tx.Exec(ctx, `
				UPDATE scheduler_tasks SET state = 'PENDING', requires = $2, priority = $3,
					residency = $4, deadline_ms = $5, queue = $6, weight = $7, avoid_nodes = $8,
					updated_at = `+nowMS+`
				WHERE task_id = $1`, task.TaskID, string(requiresJSON), task.Priority,
				task.Residency, task.DeadlineMS, queue, weight, string(avoidNodesJSON)); err != nil {
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

	if _, err := tx.Exec(ctx, `
			INSERT INTO scheduler_tasks
			(task_id, realm, cluster_id, requires, priority, residency, deadline_ms, queue, weight, avoid_nodes, state, attempt, fencing_token, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', 0, $11, `+nowMS+`, `+nowMS+`)`,
		task.TaskID, task.Realm, task.ClusterID, string(requiresJSON), task.Priority, task.Residency, task.DeadlineMS, queue, weight, string(avoidNodesJSON), lease.FencingToken); err != nil {
		return "", fmt.Errorf("scheduler: 写排队任务失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("scheduler: 提交排队失败: %w", err)
	}
	return domain.StatePending, nil
}

// RecordCancelIntent durably writes a user-requested control command before
// any RPC is made to an execution node. Repeated calls retain a prior ACK and
// reopen a failed request for delivery; no task lifecycle state changes here.
func (s *Store) RecordCancelIntent(ctx context.Context, taskID string) error {
	_, err := s.recordStopIntent(ctx, taskID, domain.ControlCommandCancel, "", false, 0)
	return err
}

// RecordPreemptionIntent writes a distinct preemption command for an active
// lower-priority task. The boolean is false if the task changed state between
// selection and persistence, in which case callers must not contact its node.
func (s *Store) RecordPreemptionIntent(ctx context.Context, taskID string, attempt int, byTaskID string) (bool, error) {
	return s.recordStopIntent(ctx, taskID, domain.ControlCommandPreempt, "preempted_by="+byTaskID, true, attempt)
}

func (s *Store) recordStopIntent(ctx context.Context, taskID string, command domain.ControlCommand, detail string, activeOnly bool, expectedAttempt int) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO scheduler_control_commands
		  (task_id,command,attempt,node_id,status,detail,requested_at,updated_at)
		SELECT task_id,$2,attempt,COALESCE(node_id,''),'REQUESTED',$3,`+nowMS+`,`+nowMS+`
		FROM scheduler_tasks WHERE task_id=$1
		  AND (NOT $4::boolean OR state IN ('PLACED','RUNNING'))
		  AND ($5::integer = 0 OR attempt = $5)
		ON CONFLICT (task_id,command) DO UPDATE SET
		  attempt=EXCLUDED.attempt, node_id=EXCLUDED.node_id,
		  status=CASE WHEN scheduler_control_commands.status='ACKNOWLEDGED'
		    AND scheduler_control_commands.attempt=EXCLUDED.attempt
		    THEN scheduler_control_commands.status ELSE 'REQUESTED' END,
		  detail=CASE WHEN scheduler_control_commands.status='ACKNOWLEDGED'
		    AND scheduler_control_commands.attempt=EXCLUDED.attempt
		    THEN scheduler_control_commands.detail ELSE EXCLUDED.detail END,
		  updated_at=`+nowMS, taskID, string(command), detail, activeOnly, expectedAttempt)
	if err != nil {
		return false, fmt.Errorf("scheduler: 记录停止命令失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		if activeOnly {
			return false, nil
		}
		return false, &domain.TaskNotFoundError{TaskID: taskID}
	}
	return true, nil
}

// MarkCancelDeliveryFailed preserves a failed node-control attempt without
// touching the task state, allowing callers to retry a visible REQUESTED/FAILED
// command instead of manufacturing a terminal cancellation.
func (s *Store) MarkCancelDeliveryFailed(ctx context.Context, taskID, detail string) error {
	return s.markStopDeliveryFailed(ctx, taskID, domain.ControlCommandCancel, detail)
}

// MarkPreemptionDeliveryFailed preserves an unsuccessful stop delivery
// separately from user cancellation audit data. The task remains active.
func (s *Store) MarkPreemptionDeliveryFailed(ctx context.Context, taskID, detail string) error {
	return s.markStopDeliveryFailed(ctx, taskID, domain.ControlCommandPreempt, detail)
}

func (s *Store) markStopDeliveryFailed(ctx context.Context, taskID string, command domain.ControlCommand, detail string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE scheduler_control_commands
		SET status='FAILED',detail=$2,updated_at=`+nowMS+`
		WHERE task_id=$1 AND command=$3 AND status<>'ACKNOWLEDGED'`, taskID, detail, string(command))
	if err != nil {
		return fmt.Errorf("scheduler: 记录停止投递失败: %w", err)
	}
	return nil
}

// RequestCancel marks an already acknowledged cancellation control command as
// effective. Pending work can become ABORTED immediately; active work stays
// CANCELLING until the node reports a terminal result.
func (s *Store) RequestCancel(ctx context.Context, taskID string) (domain.Placement, error) {
	return s.requestStop(ctx, taskID, domain.ControlCommandCancel, 0)
}

// ConfirmPreemption records that the execution node accepted a preemption
// stop request. It deliberately returns CANCELLING rather than ABORTED: only
// the node's terminal report releases the slot for the waiting task.
func (s *Store) ConfirmPreemption(ctx context.Context, taskID string, attempt int) (domain.Placement, error) {
	return s.requestStop(ctx, taskID, domain.ControlCommandPreempt, attempt)
}

func (s *Store) requestStop(ctx context.Context, taskID string, command domain.ControlCommand, expectedAttempt int) (domain.Placement, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 开启停止事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p domain.Placement
	var state string
	var nodeID *string
	err = tx.QueryRow(ctx, `
		SELECT realm,state,node_id,attempt,fencing_token FROM scheduler_tasks
		WHERE task_id=$1 FOR UPDATE`, taskID).
		Scan(&p.Realm, &state, &nodeID, &p.Attempt, &p.FencingToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Placement{}, &domain.TaskNotFoundError{TaskID: taskID}
	}
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 读取待停止任务失败: %w", err)
	}
	p.TaskID = taskID
	p.State = domain.TaskState(state)
	if nodeID != nil {
		p.NodeID = *nodeID
	}
	if expectedAttempt > 0 && p.Attempt != expectedAttempt {
		// A delayed preemption request must never stop a newer retry of the
		// same logical task. Returning its current placement lets the caller
		// treat this as a harmless lost race.
		return p, nil
	}

	switch p.State {
	case domain.StatePending:
		p.State = domain.StateAborted
		if _, err := tx.Exec(ctx, `UPDATE scheduler_tasks SET state='ABORTED',updated_at=`+nowMS+` WHERE task_id=$1`, taskID); err != nil {
			return domain.Placement{}, fmt.Errorf("scheduler: 取消排队任务失败: %w", err)
		}
	case domain.StatePlaced, domain.StateRunning:
		p.State = domain.StateCancelling
		if _, err := tx.Exec(ctx, `UPDATE scheduler_tasks SET state='CANCELLING',updated_at=`+nowMS+` WHERE task_id=$1`, taskID); err != nil {
			return domain.Placement{}, fmt.Errorf("scheduler: 记录取消请求失败: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE scheduler_task_attempts SET state='CANCELLING',updated_at=`+nowMS+`
			WHERE task_id=$1 AND attempt=$2`, taskID, p.Attempt); err != nil {
			return domain.Placement{}, fmt.Errorf("scheduler: 更新取消 attempt 失败: %w", err)
		}
	case domain.StateCancelling, domain.StateCompleted, domain.StateFailed, domain.StateAborted:
		// Replayed cancellation is idempotent; retain the observable current state.
	default:
		return domain.Placement{}, fmt.Errorf("scheduler: 不支持的任务状态 %q", p.State)
	}
	confirmed, err := tx.Exec(ctx, `
		UPDATE scheduler_control_commands
		SET status='ACKNOWLEDGED',updated_at=`+nowMS+`
		WHERE task_id=$1 AND command=$2 AND attempt=$3`, taskID, string(command), p.Attempt)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 确认停止命令失败: %w", err)
	}
	if confirmed.RowsAffected() != 1 {
		return domain.Placement{}, fmt.Errorf("scheduler: 缺少已持久化的 %s 命令", command)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 提交取消事务失败: %w", err)
	}
	return p, nil
}

// FindPreemptionVictim returns one active, lower-priority task on a currently
// full node that already satisfies the waiting task's hard constraints. The
// caller supplies only those compatible full node IDs from the planner, while
// this query rechecks the persisted capacity and avoids tasks with a stop
// delivery already in flight. It never considers a different realm.
func (s *Store) FindPreemptionVictim(ctx context.Context, task domain.Task, nodeIDs []string) (*domain.PreemptionCandidate, error) {
	if len(nodeIDs) == 0 {
		return nil, nil
	}
	row := s.pool.QueryRow(ctx, `
		SELECT t.task_id,t.realm,t.node_id,t.attempt,t.priority,t.state
		FROM scheduler_tasks t
		JOIN scheduler_nodes n ON n.node_id=t.node_id AND n.realm=t.realm
		WHERE t.realm=$1 AND t.node_id=ANY($2) AND t.priority < $3
		  AND t.state IN ('PLACED','RUNNING')
		  AND n.capacity <= (
		    SELECT count(*) FROM scheduler_tasks occupying
		    WHERE occupying.node_id=t.node_id
		      AND occupying.state IN ('PLACED','RUNNING','CANCELLING')
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM scheduler_control_commands c
		    WHERE c.task_id=t.task_id AND c.attempt=t.attempt
		      AND c.status IN ('REQUESTED','ACKNOWLEDGED')
		  )
		ORDER BY t.priority ASC,t.updated_at DESC,t.task_id
		LIMIT 1`, task.Realm, nodeIDs, task.Priority)
	var candidate domain.PreemptionCandidate
	var state string
	if err := row.Scan(&candidate.TaskID, &candidate.Realm, &candidate.NodeID, &candidate.Attempt, &candidate.Priority, &state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scheduler: 查找抢占候选失败: %w", err)
	}
	candidate.State = domain.TaskState(state)
	return &candidate, nil
}

// CompleteTask 保留旧调用面；不带 attempt 的本地调用按当前任务代处理。
func (s *Store) CompleteTask(ctx context.Context, taskID string, final domain.TaskState) (domain.Placement, error) {
	return s.CompleteTaskAttempt(ctx, taskID, 0, final)
}

// CompleteTaskAttempt 执行器回报终态：attempt>0 时必须仍是当前代，迟到的旧节点
// 回报只读当前状态，不得释放新 attempt 的槽位或确认旧派发。
func (s *Store) CompleteTaskAttempt(ctx context.Context, taskID string, attempt int, final domain.TaskState) (domain.Placement, error) {
	if !final.Terminal() {
		return domain.Placement{}, fmt.Errorf("scheduler: 非终态回报 %q", final)
	}
	query := `
		UPDATE scheduler_tasks SET state = $2, updated_at = ` + nowMS + `
		WHERE task_id = $1 AND state IN ('PLACED', 'RUNNING', 'CANCELLING')`
	args := []any{taskID, string(final)}
	if attempt > 0 {
		query += ` AND attempt = $3`
		args = append(args, attempt)
	}
	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 回报终态失败: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return s.GetPlacement(ctx, taskID) // 已终态 → 幂等返回现有；不存在 → TaskNotFound
	}
	if _, err := s.pool.Exec(ctx, `
			UPDATE scheduler_task_attempts SET state = $2, updated_at = `+nowMS+`
			WHERE task_id = $1 AND attempt = (SELECT attempt FROM scheduler_tasks WHERE task_id = $1)`, taskID, string(final)); err != nil {
		return domain.Placement{}, fmt.Errorf("scheduler: 更新 attempt 终态失败: %w", err)
	}
	return s.GetPlacement(ctx, taskID)
}

// GetPlacement 查询任务当前状态（API 观测用）。
func (s *Store) GetPlacement(ctx context.Context, taskID string) (domain.Placement, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT realm, state, node_id, attempt, fencing_token FROM scheduler_tasks WHERE task_id = $1`, taskID)
	var p domain.Placement
	var state string
	var nodeID *string
	if err := row.Scan(&p.Realm, &state, &nodeID, &p.Attempt, &p.FencingToken); err != nil {
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
		SELECT task_id, realm, cluster_id, requires, priority, residency, deadline_ms, queue, weight, avoid_nodes, created_at FROM scheduler_tasks
		WHERE state = 'PENDING' ORDER BY CASE WHEN deadline_ms = 0 THEN 1 ELSE 0 END, deadline_ms, priority DESC, created_at LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: 取排队任务失败: %w", err)
	}
	defer rows.Close()
	var out []domain.Task
	for rows.Next() {
		var t domain.Task
		var requires string
		var avoidNodes string
		var enqueuedAtMS int64
		if err := rows.Scan(&t.TaskID, &t.Realm, &t.ClusterID, &requires, &t.Priority, &t.Residency, &t.DeadlineMS, &t.Queue, &t.Weight, &avoidNodes, &enqueuedAtMS); err != nil {
			return nil, fmt.Errorf("scheduler: 扫描排队任务失败: %w", err)
		}
		t.EnqueuedAt = time.UnixMilli(enqueuedAtMS)
		if err := json.Unmarshal([]byte(requires), &t.Requires); err != nil {
			return nil, fmt.Errorf("scheduler: 解析 requires 失败: %w", err)
		}
		if err := json.Unmarshal([]byte(avoidNodes), &t.AvoidNodes); err != nil {
			return nil, fmt.Errorf("scheduler: 解析反亲和节点失败: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func normalizedQueue(task domain.Task) (string, int) {
	queue := task.Queue
	if queue == "" {
		queue = "default"
	}
	weight := task.Weight
	if weight <= 0 {
		weight = 1
	}
	return queue, weight
}

// PendingCount 返回当前等待节点容量的任务数，供监控与 autoscaler 使用。
func (s *Store) PendingCount(ctx context.Context) (int64, error) {
	var count int64
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM scheduler_tasks WHERE state = 'PENDING'`).Scan(&count); err != nil {
		return 0, fmt.Errorf("scheduler: 统计排队任务失败: %w", err)
	}
	return count, nil
}

// ActiveCounts 每节点活跃放置数（放置规划的槽位输入）。
func (s *Store) ActiveCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT node_id, count(*) FROM scheduler_tasks
		WHERE state IN ('PLACED', 'RUNNING', 'CANCELLING') GROUP BY node_id`)
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

// SyncNodeSnapshot mirrors the capacity metadata selected from an external
// catalog (Nacos) into the local transaction-side slot table. Placement is
// planned from the catalog, while the final slot gate is deliberately kept in
// PG; syncing the selected snapshot closes that boundary without making PG a
// second source of node liveness.
func (s *Store) SyncNodeSnapshot(ctx context.Context, n domain.Node) error {
	caps, err := json.Marshal(n.Capabilities)
	if err != nil {
		return fmt.Errorf("scheduler: 序列化节点能力失败: %w", err)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO scheduler_nodes (node_id, realm, cluster_id, capacity, capabilities, residency, control_url, registered_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, `+nowMS+`)
		ON CONFLICT (node_id) DO UPDATE SET
			realm = EXCLUDED.realm, cluster_id = EXCLUDED.cluster_id, capacity = EXCLUDED.capacity,
			capabilities = EXCLUDED.capabilities, residency = EXCLUDED.residency,
			control_url = EXCLUDED.control_url,
			registered_at = EXCLUDED.registered_at`,
		n.NodeID, n.Realm, n.ClusterID, n.Capacity, string(caps), n.Residency, n.ControlURL)
	if err != nil {
		return fmt.Errorf("scheduler: 同步节点快照失败: %w", err)
	}
	return nil
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
			WHERE node_id = $1 AND claimed_by IS NULL AND delivered_at IS NULL
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

// AckDispatch 执行节点完成接收/处理后确认 outbox；未确认的 claim 可被重派。
func (s *Store) AckDispatch(ctx context.Context, taskID string, attempt int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE scheduler_dispatch_outbox SET delivered_at = `+nowMS+`, claimed_by = NULL
		WHERE task_id = $1 AND attempt = $2 AND delivered_at IS NULL`, taskID, attempt)
	if err != nil {
		return fmt.Errorf("scheduler: 确认派发失败: %w", err)
	}
	return nil
}

// RequeueStaleDispatch 回收失联节点认领的消息。任务已经终态时不重派，避免恢复窗口制造新 attempt。
func (s *Store) RequeueStaleDispatch(ctx context.Context, olderThanMs int64) (int64, error) {
	if olderThanMs < 1000 {
		olderThanMs = 1000
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE scheduler_dispatch_outbox o SET claimed_by = NULL, claimed_at = NULL
		WHERE o.delivered_at IS NULL AND o.claimed_by IS NOT NULL
		  AND o.claimed_at < `+nowMS+` - $1
		  AND EXISTS (SELECT 1 FROM scheduler_tasks t WHERE t.task_id = o.task_id
		    AND t.attempt = o.attempt AND t.state IN ('PLACED','RUNNING'))`, olderThanMs)
	if err != nil {
		return 0, fmt.Errorf("scheduler: 回收过期派发失败: %w", err)
	}
	return tag.RowsAffected(), nil
}

// ReconcileEntry 集群本地放置/执行记录。Attempt 是恢复合并的单调版本。
type ReconcileEntry struct {
	EntryID      string `json:"entry_id"`
	TaskID       string `json:"task_id"`
	ClusterID    string `json:"cluster_id"`
	NodeID       string `json:"node_id"`
	Attempt      int    `json:"attempt"`
	State        string `json:"state"`
	FencingToken int64  `json:"fencing_token"`
}

// Reconcile 把本地记录合并回全局任务：高 attempt 覆盖低 attempt；同 attempt 只允许
// 状态单调前进，终态不回退。ledger 仍保留每个 entry 的幂等审计记录。
func (s *Store) Reconcile(ctx context.Context, lease *domain.Lease, entries []ReconcileEntry) (int, error) {
	return s.reconcile(ctx, lease, "", entries)
}

func (s *Store) ReconcileRealm(ctx context.Context, lease *domain.Lease, realm string, entries []ReconcileEntry) (int, error) {
	return s.reconcile(ctx, lease, realm, entries)
}

func (s *Store) reconcile(ctx context.Context, lease *domain.Lease, realm string, entries []ReconcileEntry) (int, error) {
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
		if e.EntryID == "" || e.TaskID == "" || !validState(e.State) {
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
		var currentAttempt int
		var currentState string
		var currentToken int64
		query := `SELECT attempt, state, fencing_token FROM scheduler_tasks WHERE task_id = $1`
		args := []any{e.TaskID}
		if realm != "" {
			query += ` AND realm = $2`
			args = append(args, realm)
		}
		query += ` FOR UPDATE`
		err = tx.QueryRow(ctx, query, args...).Scan(&currentAttempt, &currentState, &currentToken)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, fmt.Errorf("scheduler: 读取对账任务失败: %w", err)
		}
		if e.Attempt < 1 {
			e.Attempt = currentAttempt
		}
		if e.NodeID == "" {
			e.NodeID = "unknown"
		}
		if e.FencingToken == 0 {
			e.FencingToken = currentToken
		}
		attemptQuery := `
			INSERT INTO scheduler_task_attempts
				(task_id, attempt, realm, cluster_id, node_id, state, fencing_token, updated_at)
			SELECT task_id, $2, realm, $3, $4, $5, $6, ` + nowMS + `
			FROM scheduler_tasks WHERE task_id = $1`
		attemptArgs := []any{e.TaskID, e.Attempt, e.ClusterID, e.NodeID, e.State, e.FencingToken}
		if realm != "" {
			attemptQuery += ` AND realm = $7`
			attemptArgs = append(attemptArgs, realm)
		}
		attemptQuery += `
			ON CONFLICT (task_id, attempt) DO UPDATE SET state = EXCLUDED.state,
				node_id = EXCLUDED.node_id, fencing_token = EXCLUDED.fencing_token, updated_at = EXCLUDED.updated_at`
		if _, err := tx.Exec(ctx, attemptQuery, attemptArgs...); err != nil {
			return 0, fmt.Errorf("scheduler: 写对账 attempt 失败: %w", err)
		}
		if e.Attempt > currentAttempt || (e.Attempt == currentAttempt && stateRank(e.State) > stateRank(currentState)) {
			updateQuery := `UPDATE scheduler_tasks SET attempt=$2, node_id=$3, state=$4, fencing_token=$5, updated_at=` + nowMS + ` WHERE task_id=$1`
			updateArgs := []any{e.TaskID, e.Attempt, e.NodeID, e.State, e.FencingToken}
			if realm != "" {
				updateQuery += ` AND realm = $6`
				updateArgs = append(updateArgs, realm)
			}
			if _, err := tx.Exec(ctx, updateQuery, updateArgs...); err != nil {
				return 0, fmt.Errorf("scheduler: 合并对账状态失败: %w", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("scheduler: 提交对账失败: %w", err)
	}
	return inserted, nil
}

func validState(state string) bool {
	switch domain.TaskState(state) {
	case domain.StatePending, domain.StatePlaced, domain.StateRunning, domain.StateCancelling, domain.StateCompleted, domain.StateFailed, domain.StateAborted:
		return true
	}
	return false
}

func stateRank(state string) int {
	switch domain.TaskState(state) {
	case domain.StatePending:
		return 0
	case domain.StatePlaced:
		return 1
	case domain.StateRunning:
		return 2
	case domain.StateCancelling:
		return 3
	case domain.StateCompleted, domain.StateFailed, domain.StateAborted:
		return 4
	}
	return -1
}
