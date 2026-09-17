// Package planner 放置决策：硬约束在 EligibleNodes 里过滤，候选之间的取舍由
// domain.PlacementScore 打分（值域/归一化/权重定义见 domain/placement.go）。
//
// 此前的注释是「不做打分公式——A4 P2」。那句话在 2026-09-17 之前是对的：A4 否掉的
// 是架构 §6.2 那条未定义值域与归一化的公式，而当时没有第二个候选维度，负载最小
// 就等于「不做打分」。C1 的跨集群偏好打分把第二个维度带进来了，于是按 A4 的建议
// 把值域、归一化、默认权重与调参口径逐项定义出来，公式才有资格存在。
package planner

import (
	"math"
	"sort"
	"time"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

// Pick 在候选节点里选负载比最低者；同负载按 node_id 字典序（确定性，防抖）。
// 无候选（能力不匹配或全满）返回 nil。
//
// 等价于 PickWeighted 用 domain.DefaultPlacementWeights()。保留这个名字是为了让
// 「默认权重下的行为与此前逐字节相同」这件事有一个**可断言**的入口：用例直接比较
// 两者的返回值，而不是靠读代码相信亲和项在无输入时恒为 0。
func Pick(task domain.Task, nodes []domain.Node, active map[string]int) *domain.Node {
	return PickWeighted(task, nodes, active, domain.DefaultPlacementWeights())
}

// PickWeighted 在候选节点里选得分最高者；同分按 node_id 字典序（确定性，防抖）。
//
// 打分定义与调参口径见 domain/placement.go（A4 要求的那份值域/归一化/权重定义）。
// 与 Pick 的差别只有一项：候选之间的比较从「负载比最小」换成
// `load*(1-loadRatio) + affinity*affinityScore`。
//
// 排序的**确定性**是硬要求：得分相同必须落到 node_id 字典序，否则同一个任务在两次
// 循环里可能落到不同节点，而 drain 循环是每秒跑的——那会变成「任务在节点之间抖动」，
// 症状是同一个任务反复被派发。
func PickWeighted(task domain.Task, nodes []domain.Node, active map[string]int, w domain.PlacementWeights) *domain.Node {
	var best *domain.Node
	bestScore := math.Inf(-1)
	affinity := domain.AffinityInputs{
		PreferredClusters:      task.PreferredClusters,
		ProjectActiveByCluster: task.ProjectActiveByCluster,
	}
	eligible := EligibleNodes(task, nodes)
	for i := range eligible {
		n := &eligible[i]
		a := active[n.NodeID]
		if a >= n.Capacity {
			continue
		}
		score := domain.PlacementScore(*n, a, affinity, w)
		if score > bestScore || (score == bestScore && best != nil && n.NodeID < best.NodeID) {
			best, bestScore = n, score
		}
	}
	return best
}

// VersionBlockedCandidates 统计因版本一致性前置而被排除的候选数**上界**。
//
// 存在的唯一理由是让「全局任务因为版本分叉在排队」与「全局任务因为没有容量在排队」
// 分得开——两者在响应上都是 202 + PENDING，只看响应无法区分，而处置完全相反
// （前者去把滚动升级做完，后者去扩容）。
//
// 为什么是上界而不是精确值：它不复刻 EligibleNodes 的其余硬约束（capability /
// residency / 反亲和），所以会把「本来也会被别的约束挡掉」的节点算进来。精确值需要
// 让 EligibleNodes 返回分类结果，那会给放置路径的每个调用点加一份没人看的返回结构；
// 而这个数只用来打日志与计数，宁可偏高也不要为了精确而改热路径的形状。
//
// 只在 Pick 返回 nil 的**未命中路径**上调用。
func VersionBlockedCandidates(task domain.Task, nodes []domain.Node) int {
	if task.ClusterID != "" {
		return 0 // 集群固定放置不受版本闸门影响
	}
	blocked := 0
	for _, n := range nodes {
		if n.Realm != task.Realm {
			continue
		}
		if n.ClusterVersionUnproven {
			blocked++
		}
	}
	return blocked
}

// EligibleNodes returns hard-constraint-compatible nodes without applying
// capacity. It is shared by normal placement and preemption so preemption
// cannot bypass realm, cluster, residency, capability, anti-affinity, or
// cluster-health constraints.
func EligibleNodes(task domain.Task, nodes []domain.Node) []domain.Node {
	out := make([]domain.Node, 0, len(nodes))
	for _, n := range nodes {
		if n.Realm != task.Realm {
			continue
		}
		if task.ClusterID != "" && n.ClusterID != task.ClusterID {
			continue
		}
		// 集群失联（§7.4.1）：suspect 与 down 的集群不接受**新**放置，已有任务不动。
		//
		// 闸门放在这里而不是上游剪枝（「列完节点先把坏集群的节点删掉」）：本函数
		// 同时被正常放置与抢占使用，就是为了让抢占绕不过硬约束，而集群健康是硬约束
		// 的一种。删上游会让约束可被绕过——那正是这条注释存在的理由。
		//
		// 判定不了（能力关闭 / 集群未注册）一律放行：把「注册表没配好」也当成拒绝，
		// 会让整个平台停止放置。
		if n.ClusterState.BlocksPlacement() {
			continue
		}
		// 版本一致性前置（§7.4.1「同一版本先完成全集群分发才允许全局调度」）：
		// 只拦**全局**任务。集群固定放置是运维的显式意图，闸门不该把它也拦掉——
		// 拦下显式意图不会让部署变对，只会让人去把闸门关掉。
		//
		// 那条 `task.ClusterID == ""` 是**这条闸门的一半**，不能省：节点上的
		// ClusterVersionUnproven 是一条事实（这个集群的版本没被证明一致），
		// 目录层生成它时还不知道要放的是什么任务。实现的第一版把裁决揉进了字段名，
		// 于是「指定了 cluster_id 的放置」也被拦——本函数的那条用例就是这么抓住它的。
		if task.ClusterID == "" && n.ClusterVersionUnproven {
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
		out = append(out, n)
	}
	return out
}

// FullEligibleNodes identifies compatible nodes that are currently full. It
// does not select a victim; the store rechecks physical capacity and chooses
// a lower-priority active task atomically close to the control request.
func FullEligibleNodes(task domain.Task, nodes []domain.Node, active map[string]int) []domain.Node {
	eligible := EligibleNodes(task, nodes)
	out := make([]domain.Node, 0, len(eligible))
	for _, n := range eligible {
		if active[n.NodeID] >= n.Capacity {
			out = append(out, n)
		}
	}
	return out
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
