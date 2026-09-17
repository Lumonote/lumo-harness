package planner

import (
	"fmt"
	"testing"

	"github.com/lumo-harness/platform/scheduler/internal/domain"
)

func node(id, cluster string, capacity int) domain.Node {
	return domain.Node{NodeID: id, Realm: "dev", ClusterID: cluster, Capacity: capacity}
}

// TestPickWeightedMatchesPickUnderDefaultWeights 默认权重下的行为必须与此前的纯负载最小**逐字节相同**。
//
// 这是「打开偏好打分不会改变任何既有部署的放置分布」这句话的全部依据，所以它必须
// 是一条可断言的用例而不是一句注释：亲和分只在调用方真的给了偏好输入时才非零，
// 没有输入时两个候选的亲和分都是 0，比较就退化成负载比。
//
// 形状特意覆盖了「同负载靠 node_id 定序」「容量不同」「部分节点满」三档，
// 因为它们正是旧的 ratio 比较里有分支的地方。
func TestPickWeightedMatchesPickUnderDefaultWeights(t *testing.T) {
	task := domain.Task{TaskID: "t1", Realm: "dev"}
	shapes := []struct {
		name   string
		nodes  []domain.Node
		active map[string]int
	}{
		{
			"负载比不同",
			[]domain.Node{node("a", "c1", 10), node("b", "c2", 10)},
			map[string]int{"a": 5, "b": 1},
		},
		{
			"同负载 → 按 node_id 字典序",
			[]domain.Node{node("b", "c2", 10), node("a", "c1", 10)},
			map[string]int{"a": 3, "b": 3},
		},
		{
			"容量不同但比值相同 → 仍是 node_id 定序",
			[]domain.Node{node("z", "c1", 100), node("y", "c2", 10)},
			map[string]int{"z": 50, "y": 5},
		},
		{
			"负载比相同而 node_id 大小与输入顺序相反",
			[]domain.Node{node("n9", "c1", 4), node("n2", "c2", 4)},
			map[string]int{"n9": 1, "n2": 1},
		},
		{
			"有节点已满（跳过）",
			[]domain.Node{node("a", "c1", 2), node("b", "c2", 2)},
			map[string]int{"a": 2, "b": 0},
		},
		{
			"全部满 → 无候选",
			[]domain.Node{node("a", "c1", 1), node("b", "c2", 1)},
			map[string]int{"a": 1, "b": 1},
		},
	}
	for _, tc := range shapes {
		t.Run(tc.name, func(t *testing.T) {
			want := Pick(task, tc.nodes, tc.active)
			got := PickWeighted(task, tc.nodes, tc.active, domain.DefaultPlacementWeights())
			if (want == nil) != (got == nil) {
				t.Fatalf("nil 性不一致: Pick=%v PickWeighted=%v", want, got)
			}
			if want != nil && want.NodeID != got.NodeID {
				t.Fatalf("默认权重下必须与 Pick 同序: Pick=%s PickWeighted=%s", want.NodeID, got.NodeID)
			}
		})
	}
}

// TestAffinityReordersWithinBound 亲和只在边界之内翻转，且翻转的方向是对的。
func TestAffinityReordersWithinBound(t *testing.T) {
	const capacity = 1000
	// preferred 集群的节点负载比 0.5，other 集群 0.5-gap。
	affinityNode := node("aff", "preferred", capacity)
	plainNode := node("plain", "other", capacity)

	t.Run("差值在边界内 → 亲和胜出", func(t *testing.T) {
		active := map[string]int{"aff": 500, "plain": 400} // gap = 0.1 < 0.25
		task := domain.Task{TaskID: "t", Realm: "dev", PreferredClusters: []string{"preferred"}}
		got := PickWeighted(task, []domain.Node{plainNode, affinityNode}, active, domain.DefaultPlacementWeights())
		if got == nil || got.NodeID != "aff" {
			t.Fatalf("边界内亲和应胜出，得到 %v", got)
		}
	})

	t.Run("差值超出边界 → 负载胜出（偏好不能把均衡搞坏）", func(t *testing.T) {
		active := map[string]int{"aff": 500, "plain": 100} // gap = 0.4 > 0.25
		task := domain.Task{TaskID: "t", Realm: "dev", PreferredClusters: []string{"preferred"}}
		got := PickWeighted(task, []domain.Node{plainNode, affinityNode}, active, domain.DefaultPlacementWeights())
		if got == nil || got.NodeID != "plain" {
			t.Fatalf("超出边界时必须按负载选，得到 %v", got)
		}
	})

	t.Run("亲和权重设为 0 → 退回纯负载最小", func(t *testing.T) {
		active := map[string]int{"aff": 500, "plain": 400}
		task := domain.Task{TaskID: "t", Realm: "dev", PreferredClusters: []string{"preferred"}}
		got := PickWeighted(task, []domain.Node{plainNode, affinityNode}, active,
			domain.PlacementWeights{Load: 1, Affinity: 0})
		if got == nil || got.NodeID != "plain" {
			t.Fatalf("亲和权重 0 时必须按负载选，得到 %v", got)
		}
	})
}

// TestProjectAffinityKeepsWorkOnOneCluster 会话/项目亲和在真实形状下的效果。
//
// 这个形状是架构 §7.4.1 那句「同一会话的任务尽可能留在原集群」的最小复现：
// 项目已有 3 个任务在 c1、0 个在 c2，两个集群各有一个同样空的节点 →
// 新任务应当落到 c1（而不是靠 node_id 字典序碰巧落到谁）。
func TestProjectAffinityKeepsWorkOnOneCluster(t *testing.T) {
	task := domain.Task{
		TaskID: "t", Realm: "dev", ProjectID: "p1",
		ProjectActiveByCluster: map[string]int{"c1": 3},
	}
	// node_id 刻意让 c2 的节点字典序更小，以证明不是靠定序碰巧选中的。
	nodes := []domain.Node{node("aaa", "c2", 10), node("zzz", "c1", 10)}
	got := PickWeighted(task, nodes, map[string]int{}, domain.DefaultPlacementWeights())
	if got == nil || got.ClusterID != "c1" {
		t.Fatalf("项目亲和应把任务留在已有工作的集群上，得到 %v", got)
	}
	// 去掉亲和输入（ProjectActiveByCluster 为空）后应当落到字典序更小的那个 ——
	// 这半边才是「亲和真的起了作用」的对照。
	plain := domain.Task{TaskID: "t", Realm: "dev", ProjectID: "p1"}
	if got := PickWeighted(plain, nodes, map[string]int{}, domain.DefaultPlacementWeights()); got == nil || got.NodeID != "aaa" {
		t.Fatalf("无亲和输入时应退回字典序定序，得到 %v", got)
	}
}

// TestVersionGateBlocksGlobalButNotPinned 版本闸门只拦全局任务。
func TestVersionGateBlocksGlobalButNotPinned(t *testing.T) {
	blocked := node("n1", "c1", 4)
	blocked.ClusterVersionUnproven = true

	t.Run("全局任务：被拦的节点不进候选", func(t *testing.T) {
		got := Pick(domain.Task{TaskID: "t", Realm: "dev"}, []domain.Node{blocked}, map[string]int{})
		if got != nil {
			t.Fatalf("全局任务不该落到版本不一致的节点上，得到 %v", got)
		}
	})

	t.Run("集群固定放置：不受影响（运维的显式意图）", func(t *testing.T) {
		task := domain.Task{TaskID: "t", Realm: "dev", ClusterID: "c1"}
		got := Pick(task, []domain.Node{blocked}, map[string]int{})
		if got == nil || got.NodeID != "n1" {
			t.Fatalf("指定了 cluster_id 的放置必须放行，得到 %v", got)
		}
	})

	t.Run("抢占路径同样绕不过（共用 EligibleNodes 的全部意义）", func(t *testing.T) {
		full := blocked
		if got := FullEligibleNodes(domain.Task{TaskID: "t", Realm: "dev"}, []domain.Node{full}, map[string]int{"n1": 4}); len(got) != 0 {
			t.Fatalf("抢占不该绕过版本闸门，得到 %v", got)
		}
		task := domain.Task{TaskID: "t", Realm: "dev", ClusterID: "c1"}
		if got := FullEligibleNodes(task, []domain.Node{full}, map[string]int{"n1": 4}); len(got) != 1 {
			t.Fatalf("固定放置的抢占仍应看到该节点，得到 %v", got)
		}
	})
}

// TestVersionBlockedCandidatesIsRealmScopedUpperBound 诊断计数的作用域与上界语义。
//
// 它只用来把「因为版本分叉在排队」与「因为没有容量在排队」分开，所以它必须是
// **只多不少**的：漏报会让真正的原因看不见，多报只会让日志上的数偏大（而日志里
// 的字段名已经写着 blocked_candidates）。
func TestVersionBlockedCandidatesIsRealmScopedUpperBound(t *testing.T) {
	blocked := node("n1", "c1", 4)
	blocked.ClusterVersionUnproven = true
	otherRealm := node("n2", "c1", 4)
	otherRealm.Realm = "prod"
	otherRealm.ClusterVersionUnproven = true
	ok := node("n3", "c2", 4)

	nodes := []domain.Node{blocked, otherRealm, ok}
	if got := VersionBlockedCandidates(domain.Task{TaskID: "t", Realm: "dev"}, nodes); got != 1 {
		t.Fatalf("全局任务只应统计同 realm 被拦的节点，得到 %d", got)
	}
	// 指定了集群的任务不受版本闸门影响 → 计数必须是 0，否则日志会把「排队因为没容量」
	// 说成「因为版本分叉」。
	if got := VersionBlockedCandidates(domain.Task{TaskID: "t", Realm: "dev", ClusterID: "c1"}, nodes); got != 0 {
		t.Fatalf("固定放置不该计入版本拦截，得到 %d", got)
	}
}

// TestAffinityTieBreakIsDeterministic 同分必须落到 node_id 字典序。
//
// drain 循环是每秒跑的：同分不定序会让同一个任务在两次循环里落到不同节点，
// 症状是「任务在节点之间抖动」，而它看起来像随机故障。
func TestAffinityTieBreakIsDeterministic(t *testing.T) {
	task := domain.Task{TaskID: "t", Realm: "dev", PreferredClusters: []string{"c1", "c2"}}
	nodes := []domain.Node{node("m", "c2", 10), node("a", "c1", 10), node("z", "c2", 10)}
	for i := 0; i < 20; i++ {
		got := PickWeighted(task, nodes, map[string]int{}, domain.DefaultPlacementWeights())
		if got == nil || got.NodeID != "a" {
			t.Fatalf("第 %d 次得到 %v，同分必须稳定落在 node_id 最小的那个", i, got)
		}
	}
}

// TestPickWeightedDoesNotMutateInput 打分不得改动候选切片（调用方持有它）。
func TestPickWeightedDoesNotMutateInput(t *testing.T) {
	nodes := []domain.Node{node("b", "c2", 4), node("a", "c1", 4)}
	before := fmt.Sprint(nodes)
	task := domain.Task{TaskID: "t", Realm: "dev", PreferredClusters: []string{"c1"}}
	_ = PickWeighted(task, nodes, map[string]int{}, domain.DefaultPlacementWeights())
	if fmt.Sprint(nodes) != before {
		t.Fatalf("输入切片被改动: %s → %s", before, fmt.Sprint(nodes))
	}
}
