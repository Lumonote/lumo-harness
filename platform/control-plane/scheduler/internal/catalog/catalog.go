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

// AliveLister 目录的可选能力：报告「此刻还活着」的节点 ID。
//
// 它与 List 回答的是两个问题。List 是**放置候选**——Nacos 里 enabled=false 的节点
// 不在里面，因为不该再往上放新任务。但这样的节点只要还健康（还在续报），就还在跑
// 已有任务、事后会回报真实结果；停滞收割、任务漂移与孤儿指标要问的是「这个节点
// 是不是已经不可能再推进它的任务」，对它们来说这个节点没有消失。
//
// enabled=false 且健康的节点实际出现在两种时候（见 shared/nacos-registration.ts）：
//
//   - **就绪检查未过**：节点每 5s 续报一次，但带 enabled=false。这个状态可以持续
//     任意长——这是本能力主要保护的情况；
//   - **排空刚开始**：withdraw 把实例置为 enabled=false 并**停止续报**，所以它只在
//     Nacos 判它不健康之前的十几秒里算「健康但禁用」，之后就真的从两个集合里都消失。
//     排空本身有上限（LUMO_DRAIN_TIMEOUT_MS，默认 150s）。
//
// 下文与测试里说的「排空中的节点」是这两种情况的简称。
//
// 判据与 heartbeat 包（协作服务的节点失联判定）一致：健康即存活，不看 enabled。
//
// 调用方把返回值与 List 的结果取**并集**使用，所以没有额外信息的实现返回空集即可。
// 没有「禁用」概念的目录（PG 本地目录）不必实现它。
type AliveLister interface {
	ListAlive(ctx context.Context) ([]string, error)
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
		INSERT INTO scheduler_nodes (node_id, realm, cluster_id, capacity, capabilities, residency, control_url, registered_at, last_seen_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, (EXTRACT(EPOCH FROM now()) * 1000)::bigint, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
		ON CONFLICT (node_id) DO UPDATE SET
			realm = EXCLUDED.realm, cluster_id = EXCLUDED.cluster_id, capacity = EXCLUDED.capacity,
			capabilities = EXCLUDED.capabilities,
			residency = EXCLUDED.residency,
			control_url = EXCLUDED.control_url,
			registered_at = EXCLUDED.registered_at, last_seen_at = EXCLUDED.last_seen_at`,
		n.NodeID, n.Realm, n.ClusterID, n.Capacity, string(caps), n.Residency, n.ControlURL); err != nil {
		return fmt.Errorf("catalog: 登记节点失败: %w", err)
	}
	return nil
}
