// Package planner 过滤式放置决策（spec §1：不做打分公式——A4 P2）。
package planner

import (
	"math"
	"sort"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Pick 在候选节点里选负载比最低者；同负载按 node_id 字典序（确定性，防抖）。
// 无候选（能力不匹配或全满）返回 nil。
func Pick(task domain.Task, nodes []domain.Node, active map[string]int) *domain.Node {
	var best *domain.Node
	bestRatio := math.Inf(1)
	for i := range nodes {
		n := &nodes[i]
		if n.Realm != task.Realm {
			continue
		}
		if task.ClusterID != "" && n.ClusterID != task.ClusterID {
			continue
		}
		if contains(task.AvoidNodes, n.NodeID) {
			continue
		}
		if task.Residency != "" && n.Residency != task.Residency {
			continue
		}
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

func contains(items []string, wanted string) bool {
	for _, item := range items {
		if item == wanted {
			return true
		}
	}
	return false
}

// OrderPending applies EDF first, then weighted fair queuing within the same
// deadline class. A queue receives one turn per weight unit, while priority
// and enqueue time keep each queue deterministic. The returned slice is a
// reordered copy, so callers retain ownership of their input.
func OrderPending(tasks []domain.Task, now time.Time) []domain.Task {
	out := append([]domain.Task(nil), tasks...)
	queues := make(map[string][]domain.Task)
	for _, task := range out {
		queue := task.Queue
		if queue == "" {
			queue = "default"
		}
		queues[queue] = append(queues[queue], task)
	}
	for queue := range queues {
		sort.SliceStable(queues[queue], func(i, j int) bool {
			a, b := queues[queue][i], queues[queue][j]
			if a.DeadlineMS != b.DeadlineMS {
				if a.DeadlineMS == 0 {
					return false
				}
				if b.DeadlineMS == 0 {
					return true
				}
				return a.DeadlineMS < b.DeadlineMS
			}
			if a.Priority != b.Priority {
				return a.Priority > b.Priority
			}
			return a.EnqueuedAt.Before(b.EnqueuedAt)
		})
	}
	// Explicit-deadline tasks are globally EDF ordered. The remaining tasks are
	// emitted by weighted round robin to prevent a hot tenant queue from
	// starving other queues.
	urgent := make([]domain.Task, 0, len(out))
	deadline := make([]domain.Task, 0, len(out))
	regular := make(map[string][]domain.Task)
	for queue, items := range queues {
		for len(items) > 0 && items[0].DeadlineMS != 0 {
			if items[0].DeadlineMS <= now.UnixMilli() {
				urgent = append(urgent, items[0])
			} else {
				deadline = append(deadline, items[0])
			}
			items = items[1:]
		}
		regular[queue] = items
	}
	sort.SliceStable(urgent, func(i, j int) bool {
		if urgent[i].DeadlineMS != urgent[j].DeadlineMS {
			return urgent[i].DeadlineMS < urgent[j].DeadlineMS
		}
		return urgent[i].Priority > urgent[j].Priority
	})
	sort.SliceStable(deadline, func(i, j int) bool {
		if deadline[i].DeadlineMS != deadline[j].DeadlineMS {
			return deadline[i].DeadlineMS < deadline[j].DeadlineMS
		}
		if deadline[i].Priority != deadline[j].Priority {
			return deadline[i].Priority > deadline[j].Priority
		}
		return deadline[i].TaskID < deadline[j].TaskID
	})
	ordered := append(append([]domain.Task(nil), urgent...), deadline...)
	served := make(map[string]int)
	for {
		chosen := ""
		bestRatio := math.Inf(1)
		for queue, items := range regular {
			if len(items) == 0 {
				continue
			}
			weight := items[0].Weight
			if weight <= 0 {
				weight = 1
			}
			ratio := float64(served[queue]) / float64(weight)
			if ratio < bestRatio || (ratio == bestRatio && (chosen == "" || queue < chosen)) {
				chosen, bestRatio = queue, ratio
			}
		}
		if chosen == "" {
			break
		}
		ordered = append(ordered, regular[chosen][0])
		regular[chosen] = regular[chosen][1:]
		served[chosen]++
	}
	return ordered
}
