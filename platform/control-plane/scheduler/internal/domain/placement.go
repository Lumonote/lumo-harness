// 跨集群偏好打分（§7.4.1 的 `clusterTag/region` 标签偏好 + 会话亲和）。
//
// ## 为什么这里要写「打分」而 scheduler 此前明确「不做打分公式」
//
// 评审 A4【P2】否掉的是架构 §6.2 那条 `score = w1*constraintMatch + w2*affinityGain
// + w3*(1-load) − w4*crossAZcost`，理由不是「不该打分」，而是**它不可实现**：各项
// 未定义值域、未定义归一化、`affinityGain` 干脆没有定义。A4 的建议是「逐项定义
// 值域 [0,1]、归一化方式、默认权重与调参流程」。
//
// 本文件就是那份定义，且只有**两项**：负载与亲和。硬约束（realm / cluster /
// residency / capability / 反亲和 / 集群健康 / 版本一致）**不参与打分**——它们在
// EligibleNodes 里就已经把候选筛掉了，把硬约束折进分数等于让一个不满足硬约束的
// 节点靠别的项补回来。`constraintMatch` 之所以在架构里是个乘数项，是因为那里
// 假设候选集不先过滤；这里不是。
//
// ## 两项的值域与归一化（A4 要求的那份定义）
//
//	loadScore(node)     = clamp(1 - active/capacity, 0, 1)   ∈ [0,1]
//	affinityScore(node) = 见 AffinityScore                    ∈ [0,1]
//	score               = load*loadScore + affinity*affinityScore
//
// ## 调参流程与那条唯一要紧的不变量
//
// 亲和分是**有界**的：一个候选要凭亲和分赢过另一个，负载差必须小于 `affinity/load`
// （见 AffinityBound）。默认 `load=1, affinity=0.25` 意味着**亲和永远翻转不了
// 25 个百分点的负载差**——想更保守就把 affinity 调小，想关掉就设 0。
// 这条不变量由用例钉住（`TestAffinityCannotFlipLoadGapBeyondBound`），而不是由
// 「默认值看起来挺小」担保：默认值是拍出来的，不变量是能验的。
package domain

import (
	"fmt"
	"math"
)

// PlacementWeights 偏好打分的权重。
//
// 只有两项，且都无量纲（作用于已经归一化到 [0,1] 的分项）。
type PlacementWeights struct {
	// Load 负载项权重。必须 > 0：它是**唯一**保证「负载低的候选优先」的项，
	// 设成 0 等于把放置退化成「按亲和硬选」，那会让一个集群被写满而另一个空转。
	Load float64 `json:"load"`
	// Affinity 亲和项权重。≥ 0；0 表示关闭偏好排序（等价于此前的纯负载最小）。
	Affinity float64 `json:"affinity"`
}

// DefaultPlacementWeights 默认权重。
//
// 亲和默认**非零**：它只在调用方真的给了偏好输入（PreferredClusters 或
// ProjectActiveByCluster）时才产生非零分，没有输入时两个候选的亲和分都是 0，
// 排序与「纯负载最小」逐字节相同（见 planner.PickWeighted 的用例）。也就是说
// 打开它不会改变任何既有部署的放置分布，除非有人开始声明偏好。
func DefaultPlacementWeights() PlacementWeights {
	return PlacementWeights{Load: 1, Affinity: 0.25}
}

// Validate 校验权重，非法时点名变量。
//
// 非法取值**拒绝启动**而不是静默回落默认值：一个打错字的
// `LUMO_PLACEMENT_AFFINITY_WEIGHT=0.25%` 解析失败后回落默认值，症状是
// 「配了没用」；而 `load=0` 是实打实的分布错误（见 Load 的注释）。
func (w PlacementWeights) Validate() error {
	if math.IsNaN(w.Load) || math.IsInf(w.Load, 0) || w.Load <= 0 {
		return fmt.Errorf("LUMO_PLACEMENT_LOAD_WEIGHT 必须是正的有限数，当前 %v", w.Load)
	}
	if math.IsNaN(w.Affinity) || math.IsInf(w.Affinity, 0) || w.Affinity < 0 {
		return fmt.Errorf("LUMO_PLACEMENT_AFFINITY_WEIGHT 必须 ≥ 0 且有限，当前 %v", w.Affinity)
	}
	return nil
}

// AffinityBound 亲和分能翻转的**最大负载差**（= affinity/load）。
//
// 推导：候选 A（亲和 1、负载比 rA）要赢过候选 B（亲和 0、负载比 rB）需要
// `load*(1-rA) + affinity > load*(1-rB)`，即 `rA - rB < affinity/load`。
// 所以「负载比高出超过这个数」的候选永远不可能仅凭亲和胜出。
//
// 这个数就是调参时要看的那个：它直接回答「偏好最多能把多少负载不平衡换掉」。
func (w PlacementWeights) AffinityBound() float64 {
	if w.Load <= 0 {
		return 0
	}
	return w.Affinity / w.Load
}

// AffinityInputs 亲和打分的两个来源。
//
// 两个来源都「有则用、无则 0」，且**显式偏好优先**：给了 PreferredClusters 就不再
// 看项目亲和。优先级而不是加权求和，是为了不引入第三个权重——两个来源各有权重
// 时需要回答「谁该更大」，而那个问题没有客观答案。
type AffinityInputs struct {
	// PreferredClusters 调用方声明的集群偏好集合（当集合用，顺序不参与打分）。
	PreferredClusters []string
	// ProjectActiveByCluster 该任务所属项目在各集群上的活跃任务数（会话/项目亲和）。
	ProjectActiveByCluster map[string]int
}

// AffinityScore 亲和分 ∈ [0,1]（纯函数）。
//
//   - 声明了集群偏好：命中 1、未命中 0。这是**离散**偏好，不做部分匹配——
//     部分匹配需要定义「多像才算像」，而那又回到 A4 说的「未定义」。
//   - 否则按项目亲和：`本项目在该集群的活跃数 / 各集群最大值`。用最大值而不是
//     总和归一化：总和会让「项目任务很少」与「项目任务很多但很分散」得到同样低的
//     分，而这两种情况的正确处置不同（前者无所谓、后者恰恰该收敛到一处）。
//   - 两个来源都没有：0（**不是** 0.5）。0 保证「没有偏好信息时排序完全由负载决定」，
//     这正是「打开这个功能不会改变既有分布」得以成立的原因。
func AffinityScore(clusterID string, in AffinityInputs) float64 {
	if len(in.PreferredClusters) > 0 {
		for _, preferred := range in.PreferredClusters {
			if preferred == clusterID {
				return 1
			}
		}
		return 0
	}
	if len(in.ProjectActiveByCluster) == 0 {
		return 0
	}
	peak := 0
	for _, count := range in.ProjectActiveByCluster {
		if count > peak {
			peak = count
		}
	}
	if peak <= 0 {
		return 0
	}
	return clamp01(float64(in.ProjectActiveByCluster[clusterID]) / float64(peak))
}

// PlacementScore 候选节点的得分 ∈ [0, load+affinity]（纯函数）。
//
// active 是该节点当前活跃任务数；capacity < 1 时按 1 处理（注册端点要求 ≥1，
// 但这里不能依赖上游校验——除零会让 NaN 参与比较，而 NaN 的比较全是 false，
// 结果是**静默地选不出节点**）。
func PlacementScore(node Node, active int, in AffinityInputs, w PlacementWeights) float64 {
	capacity := node.Capacity
	if capacity < 1 {
		capacity = 1
	}
	load := 1 - float64(active)/float64(capacity)
	return w.Load*clamp01(load) + w.Affinity*AffinityScore(node.ClusterID, in)
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}
