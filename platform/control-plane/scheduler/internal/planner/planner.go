// Package planner 过滤式放置决策（spec §1：不做打分公式——A4 P2）。
package planner

import (
	"math"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Pick 在候选节点里选负载比最低者；同负载按 node_id 字典序（确定性，防抖）。
// 无候选（能力不匹配或全满）返回 nil。
func Pick(task domain.Task, nodes []domain.Node, active map[string]int) *domain.Node {
	var best *domain.Node
	bestRatio := math.Inf(1)
	for i := range nodes {
		n := &nodes[i]
		if !n.Satisfies(task.Requires) {
			continue
		}
		a := active[n.NodeID]
		if a >= n.Capacity {
			continue
		}
		ratio := float64(a) / float64(n.Capacity)
		if ratio < bestRatio || (ratio == bestRatio && best != nil && n.NodeID < best.NodeID) {
			best, bestRatio = n, ratio
		}
	}
	return best
}
