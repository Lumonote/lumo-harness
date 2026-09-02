// Package catalog 节点目录：放置候选的来源。
// 本地实现 PG（Local-lite）；生产换 Nacos Naming，接口不变（铁律 21）。
package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Catalog 放置候选目录。
type Catalog interface {
	List(ctx context.Context) ([]domain.Node, error)
	Upsert(ctx context.Context, n domain.Node) error
}

// Pg 本地实现：scheduler_nodes 表。
type Pg struct {
	Pool *pgxpool.Pool
}

func (p *Pg) List(ctx context.Context) ([]domain.Node, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT node_id, realm, cluster_id, capacity, capabilities, residency, control_url FROM scheduler_nodes`)
	if err != nil {
		return nil, fmt.Errorf("catalog: 列节点失败: %w", err)
	}
	defer rows.Close()
	var out []domain.Node
	for rows.Next() {
		var n domain.Node
		var caps string
		if err := rows.Scan(&n.NodeID, &n.Realm, &n.ClusterID, &n.Capacity, &caps, &n.Residency, &n.ControlURL); err != nil {
			return nil, fmt.Errorf("catalog: 扫描节点失败: %w", err)
		}
		if err := json.Unmarshal([]byte(caps), &n.Capabilities); err != nil {
			return nil, fmt.Errorf("catalog: 解析 capabilities 失败: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (p *Pg) Upsert(ctx context.Context, n domain.Node) error {
	caps, err := json.Marshal(n.Capabilities)
	if err != nil {
		return fmt.Errorf("catalog: 序列化 capabilities 失败: %w", err)
	}
	if _, err := p.Pool.Exec(ctx, `
		INSERT INTO scheduler_nodes (node_id, realm, cluster_id, capacity, capabilities, residency, control_url, registered_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
		ON CONFLICT (node_id) DO UPDATE SET
			realm = EXCLUDED.realm, cluster_id = EXCLUDED.cluster_id, capacity = EXCLUDED.capacity,
			capabilities = EXCLUDED.capabilities,
			residency = EXCLUDED.residency,
			control_url = EXCLUDED.control_url,
			registered_at = EXCLUDED.registered_at`,
		n.NodeID, n.Realm, n.ClusterID, n.Capacity, string(caps), n.Residency, n.ControlURL); err != nil {
		return fmt.Errorf("catalog: 登记节点失败: %w", err)
	}
	return nil
}
