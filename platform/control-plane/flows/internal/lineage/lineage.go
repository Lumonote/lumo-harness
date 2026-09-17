// Package lineage 实现缺口 C7「流程血缘 → Nebula」（architecture.md §9.2）。
//
// 设计取舍（与 A5 决策一致，且对齐 dsh-plugins/knowledge 的图投影做法）：
//
//   - 血缘的**事实**只落 PG 一张 outbox 表（flow_lineage_outbox），不引入第二个
//     存储/查询引擎——Nebula 只是这张事实的**呈现层**（A5 已拍板：不引入第二个存储）。
//   - 因此「流程提交」只把血缘边写进 PG outbox（与发布快照同一事务）；后台投影器异步
//     把 outbox 搬运到 Nebula。Nebula 不可用不会让发布变慢或失败——这正是解耦的目的。
//   - 未配置 Nebula（LUMO_FLOW_NEBULA_URL 为空）时整体关闭：不写 outbox 行、不起投影器、
//     启动日志与 /metrics 都说清楚（绝不伪造成功）。读查询面此时返回明确的「不可用」原因，
//     而不是空列表冒充「没有血缘」（与 E7 教训同源：结果集被悄悄放大/缩小比报错危险）。
//
// 本文件是**纯函数**：DAG → 血缘边集合，不碰任何 I/O，便于表驱动单测。
package lineage

import (
	"fmt"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

// 血缘边的语义分类。DAG 边在架构里被要求区分数据流与控制流；本仓库的 Definition
// 未强制每种边都声明类型，缺省按数据流处理。
const (
	// EdgeTypeData 数据流：上游算子的输出喂给下游算子（默认类型）。
	EdgeTypeData = "data"
	// EdgeTypeControl 控制流：调度 / 分支依赖。算子目录若未来引入分支算子时使用。
	EdgeTypeControl = "control"
)

// Edge 是 DAG 中一条有向血缘边，足以在图里定位两个算子节点。
//
// FlowID + Version 把边锚定到某个流程的某个「已发布版本快照」（不可变），所以即使
// 跨版本 node id 相同，也会落成不同的边——这正是 requirement #5 的边界之一。
type Edge struct {
	FlowID       string
	Version      int
	Realm        string
	FromNode     string
	ToNode       string
	EdgeType     string
	FromOperator string
	ToOperator   string
}

// Extract 把一份流程定义抽成血缘边集合（纯函数，不碰 I/O）。
//
// realm 由调用方传入并原样写到每条边上：它是发布事务里已有的字段，抹掉它会让 outbox 的
// realm 列永远为空——而空列不等于「没有 realm 隔离」，只是「我们没记」。图引擎与审计
// 都按边上携带的 realm 做隔离，所以这里必须带上。
//
// 入参 def 应是已通过 domain.ValidateDefinition 的合法 DAG；这里仍做一次轻量防御
// （空定义、自环、环），因为血缘是独立入口，不能假设调用方一定先验过（否则环会让
// 下游拓扑遍历死循环）。重复边（同一 From→To 出现多次）去重；算子名缺失记为 ""（节点
// 身份仍由 node id 保证，只是图上少一个可读标签），不报错——缺算子名不应让整条血缘消失。
//
// 返回错误仅当「定义本身不可作为 DAG」：空定义（无节点）、自环、环。任何其他情况
// （缺算子名、重复边）都正常返回，保证「发布」不因血缘抽取而失败。
func Extract(def *domain.Definition, flowID string, version int, realm string) ([]Edge, error) {
	if def == nil || len(def.Nodes) == 0 {
		return nil, fmt.Errorf("血缘抽取需要非空流程定义（至少含一个节点）")
	}
	if version < 1 {
		return nil, fmt.Errorf("血缘只能锚定到已发布版本（version >= 1），收到 %d", version)
	}
	operators := make(map[string]string, len(def.Nodes))
	for _, n := range def.Nodes {
		operators[n.ID] = n.Operator // 缺失即为 ""，这里不报错
	}
	seen := make(map[edgeKey]bool)
	edges := make([]Edge, 0, len(def.Edges))
	for _, e := range def.Edges {
		if _, ok := operators[e.From]; !ok {
			return nil, fmt.Errorf("血缘抽取拒绝悬空边: 边 %s→%s 的起点不在节点集合里", e.From, e.To)
		}
		if _, ok := operators[e.To]; !ok {
			return nil, fmt.Errorf("血缘抽取拒绝悬空边: 边 %s→%s 的终点不在节点集合里", e.From, e.To)
		}
		if e.From == e.To {
			// 自环对血缘无意义（一个算子不能既是自己上游又是下游），直接拒绝。
			return nil, fmt.Errorf("血缘抽取拒绝自环: 节点 %s 不能指向自己", e.From)
		}
		typ := e.Type
		if typ == "" {
			typ = EdgeTypeData // 定义未声明类型时默认数据流
		}
		k := edgeKey{from: e.From, to: e.To, typ: typ}
		if seen[k] {
			continue // 重复边去重
		}
		seen[k] = true
		edges = append(edges, Edge{
			FlowID:       flowID,
			Version:      version,
			Realm:        realm,
			FromNode:     e.From,
			ToNode:       e.To,
			EdgeType:     typ,
			FromOperator: operators[e.From],
			ToOperator:   operators[e.To],
		})
	}
	// 环检测（Kahn）。上游 ValidateDefinition 已保证无环，这里独立再验一次：
	// 血缘抽取是独立入口，不能假设调用方一定先验过；环会让下游递归遍历永不出界。
	if err := detectCycle(def); err != nil {
		return nil, err
	}
	return edges, nil
}

type edgeKey struct {
	from, to, typ string
}

func detectCycle(def *domain.Definition) error {
	adj := make(map[string][]string, len(def.Nodes))
	indeg := make(map[string]int, len(def.Nodes))
	for _, n := range def.Nodes {
		adj[n.ID] = nil
		indeg[n.ID] = 0
	}
	for _, e := range def.Edges {
		adj[e.From] = append(adj[e.From], e.To)
		indeg[e.To]++
	}
	queue := make([]string, 0, len(indeg))
	for id, d := range indeg {
		if d == 0 {
			queue = append(queue, id)
		}
	}
	visited := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		visited++
		for _, next := range adj[cur] {
			indeg[next]--
			if indeg[next] == 0 {
				queue = append(queue, next)
			}
		}
	}
	if visited != len(adj) {
		return fmt.Errorf("血缘抽取拒绝含环定义：拓扑排序未收敛")
	}
	return nil
}
