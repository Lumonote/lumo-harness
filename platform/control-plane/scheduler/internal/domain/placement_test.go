package domain

import (
	"math"
	"strings"
	"testing"
)

// TestAffinityScoreSources 两个来源各自的取值与优先级。
//
// 两个来源的**优先级**（显式偏好盖过项目亲和）是这里最要紧的一条：它不是加权求和，
// 因为加权求和需要回答「谁该更大」，而那个问题没有客观答案（A4 点名的病）。
func TestAffinityScoreSources(t *testing.T) {
	tests := []struct {
		name    string
		cluster string
		in      AffinityInputs
		want    float64
	}{
		{"没有任何输入 → 0（不是 0.5）", "c1", AffinityInputs{}, 0},
		{"只有空的项目表 → 0", "c1", AffinityInputs{ProjectActiveByCluster: map[string]int{}}, 0},
		{"项目表全 0 → 0（分母兜底，不是 NaN）", "c1", AffinityInputs{ProjectActiveByCluster: map[string]int{"c1": 0}}, 0},
		{"项目表有值但本集群为 0 → 0", "c2", AffinityInputs{ProjectActiveByCluster: map[string]int{"c1": 4}}, 0},
		{"项目表按最大值归一：峰值集群 = 1", "c1", AffinityInputs{ProjectActiveByCluster: map[string]int{"c1": 4, "c2": 2}}, 1},
		{"项目表按最大值归一：非峰值 = 1/2", "c2", AffinityInputs{ProjectActiveByCluster: map[string]int{"c1": 4, "c2": 2}}, 0.5},
		{"显式偏好命中 → 1（顺序不参与）", "c2", AffinityInputs{PreferredClusters: []string{"c1", "c2"}}, 1},
		{"显式偏好未命中 → 0", "c3", AffinityInputs{PreferredClusters: []string{"c1", "c2"}}, 0},
		{
			"显式偏好**盖过**项目亲和（未命中就是 0，不看项目表）",
			"c3",
			AffinityInputs{PreferredClusters: []string{"c1"}, ProjectActiveByCluster: map[string]int{"c3": 9}},
			0,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := AffinityScore(tc.cluster, tc.in); got != tc.want {
				t.Fatalf("AffinityScore(%q) = %v, 期望 %v", tc.cluster, got, tc.want)
			}
		})
	}
}

// TestAffinityCannotFlipLoadGapBeyondBound 那条唯一要紧的不变量。
//
// 断言的是**边界的两侧**，而不是「默认权重看起来挺小」：
//
//	score = load*(1-r) + affinity*a
//	带亲和的候选赢 ⟺ 它的负载比高出对方的幅度 < affinity/load
//
// 所以 bound-ε 处亲和必须赢，bound+ε 处亲和必须输。这条不变量是「打开偏好打分
// 不会把负载均衡搞坏」的全部依据——没有它，调参就只是拍数。
func TestAffinityCannotFlipLoadGapBeyondBound(t *testing.T) {
	w := DefaultPlacementWeights()
	bound := w.AffinityBound()
	if bound != 0.25 {
		t.Fatalf("默认权重的边界应为 0.25，得到 %v", bound)
	}
	const capacity = 1000
	// 亲和候选的负载比固定 0.5；对照候选的负载比在它下方 gap 处。
	const affinityRatio = 0.5
	cases := []struct {
		name         string
		gap          float64
		affinityWins bool
	}{
		{"差值远小于边界 → 亲和赢", bound - 0.1, true},
		{"差值恰好等于边界 → 不赢（严格小于才是赢）", bound, false},
		{"差值大于边界 → 亲和输", bound + 0.1, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plainRatio := affinityRatio - tc.gap
			affinityNode := Node{NodeID: "with-affinity", ClusterID: "preferred", Capacity: capacity}
			plainNode := Node{NodeID: "plain", ClusterID: "other", Capacity: capacity}
			in := AffinityInputs{PreferredClusters: []string{"preferred"}}
			affinityScore := PlacementScore(affinityNode, int(affinityRatio*capacity), in, w)
			plainScore := PlacementScore(plainNode, int(plainRatio*capacity), in, w)
			if got := affinityScore > plainScore; got != tc.affinityWins {
				t.Fatalf("负载差 %v（边界 %v）：亲和赢=%v, 期望 %v（亲和分 %v vs 负载分 %v）",
					tc.gap, bound, got, tc.affinityWins, affinityScore, plainScore)
			}
		})
	}
}

// TestAffinityBoundScalesWithWeights 边界随权重走，而不是写死 0.25。
func TestAffinityBoundScalesWithWeights(t *testing.T) {
	cases := []struct {
		w    PlacementWeights
		want float64
	}{
		{PlacementWeights{Load: 1, Affinity: 0.25}, 0.25},
		{PlacementWeights{Load: 2, Affinity: 0.25}, 0.125},
		{PlacementWeights{Load: 1, Affinity: 0}, 0},
		{PlacementWeights{Load: 0, Affinity: 1}, 0}, // load=0 非法，但这里不能除零
	}
	for _, tc := range cases {
		if got := tc.w.AffinityBound(); got != tc.want {
			t.Fatalf("AffinityBound(%+v) = %v, 期望 %v", tc.w, got, tc.want)
		}
	}
}

// TestPlacementScoreIsAlwaysFinite 打分永远不能产出 NaN。
//
// 为什么值得单独一条：NaN 的比较全是 false，所以 `score > bestScore` 在 NaN 面前
// 恒不成立——结果是**静默地选不出任何节点**，而症状（任务一直排队）与「没有容量」
// 一模一样。除零是这里唯一的来源，所以 capacity 的兜底必须是可断言的。
func TestPlacementScoreIsAlwaysFinite(t *testing.T) {
	w := DefaultPlacementWeights()
	in := AffinityInputs{PreferredClusters: []string{"c1"}}
	cases := []struct {
		name   string
		node   Node
		active int
	}{
		{"capacity 为 0（不该出现，但不得除零）", Node{NodeID: "n", ClusterID: "c1", Capacity: 0}, 3},
		{"capacity 为负", Node{NodeID: "n", ClusterID: "c1", Capacity: -5}, 1},
		{"active 超过 capacity（负载分为负 → 必须夹到 0）", Node{NodeID: "n", ClusterID: "c1", Capacity: 10}, 99},
		{"active 为 0", Node{NodeID: "n", ClusterID: "c1", Capacity: 10}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := PlacementScore(tc.node, tc.active, in, w)
			if math.IsNaN(got) || math.IsInf(got, 0) {
				t.Fatalf("得分不是有限数: %v", got)
			}
			if got < 0 || got > w.Load+w.Affinity {
				t.Fatalf("得分越界 [0,%v]: %v", w.Load+w.Affinity, got)
			}
		})
	}
}

// TestPlacementWeightsValidate 非法权重必须被拒绝并点名变量。
func TestPlacementWeightsValidate(t *testing.T) {
	bad := []struct {
		name string
		w    PlacementWeights
		want string
	}{
		{"load 为 0", PlacementWeights{Load: 0, Affinity: 1}, "LUMO_PLACEMENT_LOAD_WEIGHT"},
		{"load 为负", PlacementWeights{Load: -1, Affinity: 0}, "LUMO_PLACEMENT_LOAD_WEIGHT"},
		{"load 为 NaN", PlacementWeights{Load: math.NaN(), Affinity: 0}, "LUMO_PLACEMENT_LOAD_WEIGHT"},
		{"load 为 Inf", PlacementWeights{Load: math.Inf(1), Affinity: 0}, "LUMO_PLACEMENT_LOAD_WEIGHT"},
		{"affinity 为负", PlacementWeights{Load: 1, Affinity: -0.1}, "LUMO_PLACEMENT_AFFINITY_WEIGHT"},
		{"affinity 为 NaN", PlacementWeights{Load: 1, Affinity: math.NaN()}, "LUMO_PLACEMENT_AFFINITY_WEIGHT"},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.w.Validate()
			if err == nil {
				t.Fatal("非法权重必须报错")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("错误信息必须点名变量 %s，得到 %v", tc.want, err)
			}
		})
	}
	if err := DefaultPlacementWeights().Validate(); err != nil {
		t.Fatalf("默认权重必须合法: %v", err)
	}
	// affinity = 0 是**合法**的关闭方式，不能与「配错了」混为一谈。
	if err := (PlacementWeights{Load: 1, Affinity: 0}).Validate(); err != nil {
		t.Fatalf("affinity=0 是合法的关闭档: %v", err)
	}
}
