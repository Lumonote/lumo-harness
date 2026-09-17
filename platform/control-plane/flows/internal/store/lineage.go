package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lumo-harness/platform/flows/internal/lineage"
)

// 编译期断言：Store 必须满足 lineage.ProjectorStore（消费方定义接口，存储层实现），
// 依赖方向 store → lineage（lineage 不反向 import store），与 schedule → store 同构。
var _ lineage.ProjectorStore = (*Store)(nil)

// LineageEdgeRecord 是血缘链查询返回的一条边（已投影/未投影都算，outbox 是权威事实源）。
type LineageEdgeRecord struct {
	FromNode string `json:"from"`
	ToNode   string `json:"to"`
	EdgeType string `json:"type"`
}

// LineageEnabled 报告血缘投影是否已开启（即 Nebula 是否配置）。未配置时发布不写 outbox、
// 读查询面返回「不可用」而非空列表——与 requirement #2/#4 一致，绝不伪造成功。
func (s *Store) LineageEnabled() bool { return s.lineageEnabled }

// SetLineageEnabled 由启动器根据 LUMO_FLOW_NEBULA_URL 是否配置来开关血缘捕获。
// 只在启动时调用一次，运行期不变，因此 Store 上的布尔字段无需加锁。
func (s *Store) SetLineageEnabled(v bool) { s.lineageEnabled = v }

// writeLineageWithinTx 在发布快照的同一事务里把血缘边落成 outbox 行。
// 唯一约束 (flow_id,version,from_node,to_node,edge_type) + ON CONFLICT DO NOTHING
// 保证幂等：同一版本被重复发布（极端竞态）不会产生重复边，不只靠客户端自觉。
func (s *Store) writeLineageWithinTx(ctx context.Context, tx pgx.Tx, edges []lineage.Edge) error {
	if len(edges) == 0 {
		return nil
	}
	flowIDs := make([]string, len(edges))
	versions := make([]int32, len(edges))
	realms := make([]string, len(edges))
	froms := make([]string, len(edges))
	tos := make([]string, len(edges))
	types := make([]string, len(edges))
	fromOps := make([]string, len(edges))
	toOps := make([]string, len(edges))
	for i, e := range edges {
		flowIDs[i] = e.FlowID
		versions[i] = int32(e.Version)
		realms[i] = e.Realm
		froms[i] = e.FromNode
		tos[i] = e.ToNode
		types[i] = e.EdgeType
		fromOps[i] = e.FromOperator
		toOps[i] = e.ToOperator
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO flow_lineage_outbox
		  (flow_id, version, realm, from_node, to_node, edge_type, from_operator, to_operator)
		SELECT * FROM UNNEST(
		  $1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
		ON CONFLICT (flow_id, version, from_node, to_node, edge_type) DO NOTHING`,
		flowIDs, versions, realms, froms, tos, types, fromOps, toOps)
	return err
}

// ClaimPending 取一批待投影血缘边。并发安全靠 SQL 的 FOR UPDATE SKIP LOCKED：多副本各自
// 跳过已被别人认领的行，互不阻塞也不重复搬运。claimed_at 提供崩溃回收——投影器崩在
// 「认领后、标记前」时，行会在 5 分钟后被重新认领，不会卡死。
func (s *Store) ClaimPending(ctx context.Context, limit int) ([]lineage.PendingEdge, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		WITH picked AS (
			SELECT id FROM flow_lineage_outbox
			WHERE projected_at IS NULL
			  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
			  AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
			ORDER BY id
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		UPDATE flow_lineage_outbox o SET claimed_at = now()
		FROM picked WHERE o.id = picked.id
		RETURNING o.id, o.flow_id, o.version, o.realm, o.from_node, o.to_node,
		          o.edge_type, o.from_operator, o.to_operator, o.attempts`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []lineage.PendingEdge{}
	for rows.Next() {
		var (
			id, attempts                              int64
			flowID, realm, fromNode, toNode, edgeType string
			fromOp, toOp                              string
			version                                   int32
		)
		if err := rows.Scan(&id, &flowID, &version, &realm, &fromNode, &toNode, &edgeType, &fromOp, &toOp, &attempts); err != nil {
			return nil, err
		}
		out = append(out, lineage.PendingEdge{
			ID:       id,
			Attempts: int(attempts),
			Edge: lineage.Edge{
				FlowID: flowID, Version: int(version), Realm: realm,
				FromNode: fromNode, ToNode: toNode, EdgeType: edgeType,
				FromOperator: fromOp, ToOperator: toOp,
			},
		})
	}
	return out, rows.Err()
}

// MarkProjected 标记一批边已成功投影到图引擎（置 projected_at 并释放认领锁）。
func (s *Store) MarkProjected(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE flow_lineage_outbox SET projected_at = now(), claimed_at = NULL, updated_at = now()
		WHERE id = ANY($1)`, ids)
	return err
}

// MarkFailed 记录某条边投影失败：累加 attempts、写可见原因、算好下次尝试时刻（退避），
// 并释放认领以便退避窗口后重投。原因落库是「绝不伪造成功」的一部分——巡检能直接看到。
func (s *Store) MarkFailed(ctx context.Context, id int64, reason string, attempts int, nextAttempt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE flow_lineage_outbox
		SET claimed_at = NULL, attempts = $2, last_error = $3, next_attempt_at = $4, updated_at = now()
		WHERE id = $1`, id, attempts, reason, nextAttempt)
	return err
}

// ErrLineageUnavailable 表示血缘查询面在血缘捕获未启用时不可用（不是「没有血缘」）。
// 调用方必须据此返回明确的不可用原因，绝不能把空结果当成「该节点无血缘」。
var ErrLineageUnavailable = errors.New("血缘查询面不可用：未配置 Nebula 图引擎（LUMO_FLOW_NEBULA_URL 为空）；血缘捕获与图投影均未启用")

// LineageNeighbors 回答「某条血缘链上游/下游是什么」。
//
// 读取口径（requirement #4 要求在两选一里明确一个）：**回放 PG outbox 事实，不查 Nebula**。
// 理由：outbox 是血缘的权威源，Nebula 只是它的呈现层（A5：不引入第二个查询引擎），
// 因此走 PG 既能让结果不受投影延迟影响（投影器还没搬完也能给出正确答案），也不必让
// 读路径依赖一个可选外部组件。这与 knowledge 插件在 Nebula 未配置时回落 PG 递归 CTE 同构。
//
// 但「捕获是否开着」与「有没有血缘」是两件事：`lineageEnabled=false` 时 outbox **按构造
// 必然为空**（发布根本不写行），此时返回空列表就是在说谎——调用方会读成「这个节点没有
// 上下游」。所以未启用时返回 ErrLineageUnavailable，让查询面能给出可读的不可用原因。
//
// direction 取 "up"（所有上游祖先）或 "down"（所有下游后代）；maxHops <= 0 时按 16 跳封顶，
// 避免 LLM 生成的深链失控（与 graph-provider 的 MAX_DEPTH 同思路）。
//
// 本查询**不按 realm 过滤**，这不是遗漏：`flows.id` 是全局主键（见 store.go 的 DDL），
// realm 只用于回答「这个 realm 的人能不能看见这条流程」，不参与血缘的身份。边上的 realm
// 是给图引擎与审计用的隔离标签。
func (s *Store) LineageNeighbors(ctx context.Context, flowID string, version int, nodeID, direction string, maxHops int) ([]LineageEdgeRecord, error) {
	if flowID == "" || nodeID == "" || version < 1 {
		return nil, ErrNotFound
	}
	if !s.lineageEnabled {
		return nil, ErrLineageUnavailable
	}
	if maxHops <= 0 || maxHops > 64 {
		maxHops = 16
	}
	switch direction {
	case "up", "down":
	default:
		return nil, errors.New("direction 只能是 up 或 down")
	}

	var rows pgx.Rows
	var err error
	if direction == "up" {
		// 上游：以 to_node = 目标 起跳，递归沿 to_node = 当前 from_node 向上走。
		rows, err = s.pool.Query(ctx, `
			WITH RECURSIVE up(from_node, to_node, edge_type, hop) AS (
				SELECT from_node, to_node, edge_type, 0
				FROM flow_lineage_outbox
				WHERE flow_id = $1 AND version = $2 AND to_node = $3
				UNION ALL
				SELECT e.from_node, e.to_node, e.edge_type, up.hop + 1
				FROM up
				JOIN flow_lineage_outbox e
				  ON e.flow_id = $1 AND e.version = $2 AND e.to_node = up.from_node
				WHERE up.hop < $4
			)
			SELECT DISTINCT from_node, to_node, edge_type FROM up ORDER BY from_node, to_node, edge_type`, flowID, version, nodeID, maxHops)
	} else {
		// 下游：以 from_node = 目标 起跳，递归沿 from_node = 当前 to_node 向下走。
		rows, err = s.pool.Query(ctx, `
			WITH RECURSIVE down(from_node, to_node, edge_type, hop) AS (
				SELECT from_node, to_node, edge_type, 0
				FROM flow_lineage_outbox
				WHERE flow_id = $1 AND version = $2 AND from_node = $3
				UNION ALL
				SELECT e.from_node, e.to_node, e.edge_type, down.hop + 1
				FROM down
				JOIN flow_lineage_outbox e
				  ON e.flow_id = $1 AND e.version = $2 AND e.from_node = down.to_node
				WHERE down.hop < $4
			)
			SELECT DISTINCT from_node, to_node, edge_type FROM down`, flowID, version, nodeID, maxHops)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LineageEdgeRecord{}
	for rows.Next() {
		var r LineageEdgeRecord
		if err := rows.Scan(&r.FromNode, &r.ToNode, &r.EdgeType); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
