// Package dispatch 定义放置派发落点。
//
// 本地实现写 PG outbox（与放置同事务，§13.2 的 RocketMQ 替代——PG 事务
// 天然提供「扣槽位 + 发任务」的原子性）；生产实现同一接口换 relay 语义。
package dispatch

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Envelope 投递给执行节点的任务信封（outbox payload，JSON 文本）。
type Envelope struct {
	TaskID     string               `json:"task_id"`
	Attempt    int                  `json:"attempt"`
	NodeID     string               `json:"node_id"`
	Realm      string               `json:"realm"`
	WorkerID   string               `json:"worker_id,omitempty"`
	ProjectID  string               `json:"project_id,omitempty"`
	ClusterID  string               `json:"cluster_id"`
	Priority   int                  `json:"priority"`
	Requires   []domain.Requirement `json:"requires"`
	DeadlineMS int64                `json:"deadline_ms,omitempty"`
	Queue      string               `json:"queue,omitempty"`
	Weight     int                  `json:"weight,omitempty"`
	AvoidNodes []string             `json:"avoid_nodes,omitempty"`
}

// Sink 派发落点：必须在放置事务内写入，保证「放置 ⟺ 派发」原子。
type Sink interface {
	WriteInto(ctx context.Context, tx pgx.Tx, env Envelope) error
}

// PgSink 本地实现：写 scheduler_dispatch_outbox。
type PgSink struct{}

func (PgSink) WriteInto(ctx context.Context, tx pgx.Tx, env Envelope) error {
	payload, err := json.Marshal(env)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO scheduler_dispatch_outbox (task_id, attempt, node_id, payload, created_at)
		VALUES ($1, $2, $3, $4, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)`,
		env.TaskID, env.Attempt, env.NodeID, string(payload)); err != nil {
		return err
	}
	return nil
}
