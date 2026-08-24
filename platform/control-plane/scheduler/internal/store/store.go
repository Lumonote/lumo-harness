// Package store 实现调度服务的持久化：租约、放置事务、任务生命周期。
//
// fencing 校验点是放置事务内对租约行的 FOR UPDATE 锁：它同时把并发放置
// 串行化，槽位计数因此无竞态（spec §4）。
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/scheduler/internal/dispatch"
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
