// 决策固化任务（§24.4 第 5 条）：去重 / 剪枝 / 矛盾标注——**只标注不裁决**。
//
// 为什么是「只标注」：自动裁决矛盾记忆 = 让机器替人做事实判断，与 §18 的信任边界冲突
// （§24.4 第 5 条原文）。两写者冲突的正确归宿是协调者在验收时裁决——系统能提供的只有
// 「这两条看起来在说同一件事」这个**信号**。
//
// 因此本文件刻意**没有**任何「哪条赢」的输出通道：报告里只有成组的 id、重合度与理由，
// 没有任何字段能表达「保留 A、作废 B」。想加这种字段的实现会先撞到 ConsolidationReport
// 的结构（Policy 恒为 flag-only，TestConsolidationReportIsFlagOnly 把这一点钉住）。
//
// 关于判据的诚实说明（§13「诚实优于完整」）：去重与剪枝是**确定性**判据；矛盾标注是
// **启发式**——词面重合度不是语义，它能抓的是「同一话题的两种说法」，抓不到「用完全不同的
// 词说反话」。阈值是旋钮不是保证，所以它输出的名字就叫 flag（候选），不叫 conflict。
//
// 触发方式（§24.4 第 5 条）：本层仍然是**纯函数**，谁什么时候调它不在本层决定。定时触发
// 走既有 TriggerBus——flows 侧注册的 `decisions.consolidate` 算子经 HTTP 调本服务的固化
// 读面（store.ConsolidateDecisions → 本函数），频率是那条 cron 自动化的表达式，**默认关闭**
// （见 DecisionFrequencyNote）。本层因此不需要知道调度器的存在。
package domain

import (
	"sort"
	"strings"
	"time"
	"unicode"
)

// DecisionSignal 固化扫描投影：只看判据用得到的四列。
//
// 为什么不复用 Decision：矛盾标注不该读到 body——正文越读越多正是「膨胀的索引」在
// 固化任务里的翻版，而判据只需要索引行。类型不同使这件事在编译期成立。
type DecisionSignal struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Summary   string    `json:"summary"`
	CreatedAt time.Time `json:"created_at"`
}

const (
	// DecisionOverlapThreshold 词面重合度阈值（Jaccard，rune bigram）。
	// 0.5 取自 §24.4 举的那对例子：「发布日期改到周五」与「发布日期改到下周三」
	// 重合 6/10 = 0.6（该被标），同项目里两条无关决策通常 < 0.1（不该被标）。
	// 这是**信号强度**的下限，不是判定的准确率——调它的效果只能靠真实项目回看。
	DecisionOverlapThreshold = 0.5
	// DecisionMaxFlags / DecisionMaxDuplicateGroups 报告的规模上限。
	// 标注本身也要有预算：一次固化任务产出上千条 flag，人不会读，只会被忽略。
	DecisionMaxFlags           = 64
	DecisionMaxDuplicateGroups = 32
	// DecisionPairwiseRows 参与两两比较的最大行数（新在前）。两两比较是 O(n²)，
	// 扫描上限 1000 行会有 50 万对；把参与面收到最近 200 条，是「记忆腐化是近期
	// 现象」这个判断的显式化——超过这个窗口的重复只能靠人去索引里看。
	DecisionPairwiseRows = 200
	// ConsolidationPolicy 恒为 flag-only。写进报告而不是只写在注释里：消费方
	// （协调者、看板）据此就知道**不该**把报告当裁决结果用。
	ConsolidationPolicy = "flag-only"
	// DecisionFrequencyNote 触发频率的说明（§24.4 第 5 条 + §16 风险 R4）。
	//
	// 设计没有给固化任务的默认频率，也**不该给**：R4 的原话是「频率与剪枝策略需要运营
	// 数据校准，本篇给不出默认值（给一个编出来的默认值比留空更糟）」。所以本仓库不内置
	// 任何周期常量——定时触发由 TriggerBus 上的一条显式 cron 自动化开启（flows 的
	// `decisions.consolidate` 算子），不建即关闭，默认值是「关」而不是「每天几点」。
	//
	// 为什么这句话要进报告而不是只写在配置里：读到报告的人（协调者、看板）看到的可能是
	// 一份空报告，而空报告的两种成因完全不同——「记忆很干净」与「固化任务从来没跑过」。
	// 频率是运营参数，报告没法替读者区分它们，只能把这件事说出来。
	DecisionFrequencyNote = "触发频率无设计默认值（§16 R4：需运营数据校准）；定时触发默认关闭，须显式配置 cron 自动化"
)

// Reason 与 Action 的闭集。Action 只有 "flag" 一个取值——`flag` 是这层的全部动词，
// 这与 §24.4「只标注不裁决」是同一条约束的两种写法。
const (
	DecisionFlagSharedTopic = "shared-topic"
	DecisionFlagDuplicate   = "duplicate-summary"
	DecisionFlagAction      = "flag"
)

// DecisionFlag 一条矛盾候选（**不是**矛盾结论）。
type DecisionFlag struct {
	Kind    string  `json:"kind"`
	Left    string  `json:"left"`
	Right   string  `json:"right"`
	Overlap float64 `json:"overlap"`
	// Reason 闭集（见 DecisionFlagSharedTopic / DecisionFlagDuplicate）：
	// shared-topic（同 kind + 词面高度重合，疑似同一件事的两种说法）
	// | duplicate-summary（规范化后逐字相同——去重那组的兜底标注）。
	Reason string `json:"reason"`
	// Action 恒为 DecisionFlagAction。存在的意义是让每一条输出都自带「这不是裁决」
	// 这句话，而不是让消费方去读文档才知道。
	Action string `json:"action"`
}

// ConsolidationReport 固化任务的完整产物。
type ConsolidationReport struct {
	Examined        int            `json:"examined"`
	IndexCap        int            `json:"index_cap"`
	Policy          string         `json:"policy"`
	Duplicates      [][]string     `json:"duplicates"`
	Flags           []DecisionFlag `json:"flags"`
	PruneCandidates []string       `json:"prune_candidates"`
	Threshold       float64        `json:"threshold"`
	PairwiseWindow  int            `json:"pairwise_window"`
	// Truncated 指出扫描是否触顶：为真时「没有更多 flag」只说明未看过的行没被看，
	// 不说明它们干净。缺了它，一份被截断的报告会在看板上表现成「记忆很健康」。
	Truncated bool `json:"truncated"`
	// FrequencyNote 恒为 DecisionFrequencyNote。它是**说明**而不是判据：报告不说
	// 「跑得够不够勤」，只说「频率由运营定、默认关闭」，把每个数字留给配置。
	FrequencyNote string `json:"frequency_note"`
}

// Consolidate 对一批 live 决策行做一次固化（纯函数，无 IO、无写路径）。
//
// indexCap 是索引层行数上限（DecisionIndexDefaultLimit 等），用来算剪枝候选：
// **超出索引上限的那部分行**就是剪枝候选。为什么这就是「剪枝」的落点：§24.4 第 2 条
// 把索引定义为常驻且有行数上限的一层，那么「哪些行已经不在常驻层里」正是需要人来决定
// 留下哪条的问题；系统只报出候选，不删也不取代任何东西。
func Consolidate(rows []DecisionSignal, indexCap int) ConsolidationReport {
	if indexCap <= 0 {
		indexCap = DecisionIndexDefaultLimit
	}
	report := ConsolidationReport{
		Examined:        len(rows),
		IndexCap:        indexCap,
		Policy:          ConsolidationPolicy,
		Duplicates:      [][]string{},
		Flags:           []DecisionFlag{},
		PruneCandidates: []string{},
		Threshold:       DecisionOverlapThreshold,
		PairwiseWindow:  DecisionPairwiseRows,
		FrequencyNote:   DecisionFrequencyNote,
	}

	// 排序先做：下面的剪枝候选与两两比较的「最近 N 条」都依赖索引顺序，而索引顺序
	// 只有 SortDecisionSignals 一处定义（store 的 ORDER BY 与它同序）。
	ordered := make([]DecisionSignal, len(rows))
	copy(ordered, rows)
	SortDecisionSignals(ordered)

	// 剪枝候选：索引上限之外的行，按「最该先处理的最旧」输出。
	if len(ordered) > indexCap {
		overflow := ordered[indexCap:]
		report.PruneCandidates = make([]string, 0, len(overflow))
		for i := len(overflow) - 1; i >= 0; i-- {
			report.PruneCandidates = append(report.PruneCandidates, overflow[i].ID)
		}
	}

	// 去重：kind + 规范化 summary 全等即同组（确定性判据，不含阈值）。
	groups := map[string][]string{}
	groupKind := map[string]string{}
	for _, row := range ordered {
		key := row.Kind + "\x00" + normalizeDecisionText(row.Summary)
		if key == row.Kind+"\x00" {
			continue // summary 全是标点空白：不参与去重，免得把它们混成一组
		}
		groups[key] = append(groups[key], row.ID)
		groupKind[key] = row.Kind
	}
	for key, ids := range groups {
		if len(ids) < 2 {
			continue
		}
		sorted := append([]string(nil), ids...)
		sort.Strings(sorted)
		if len(report.Duplicates) < DecisionMaxDuplicateGroups {
			report.Duplicates = append(report.Duplicates, sorted)
		} else {
			report.Truncated = true
		}
		// 重复同时是一条 flag：看板按 flag 聚合时不会漏掉「同一句话记了三遍」。
		for _, id := range sorted[1:] {
			if len(report.Flags) >= DecisionMaxFlags {
				report.Truncated = true
				break
			}
			report.Flags = append(report.Flags, DecisionFlag{
				Kind: groupKind[key], Left: sorted[0], Right: id,
				Overlap: 1, Reason: DecisionFlagDuplicate, Action: DecisionFlagAction,
			})
		}
	}

	// 矛盾候选：同 kind（kind 是最粗的话题分类）+ 词面重合度达阈值，且不是逐字重复
	// （逐字重复已由去重那组报过，同一对报两遍只会稀释信噪比）。
	window := ordered
	if len(window) > DecisionPairwiseRows {
		window = window[:DecisionPairwiseRows]
		report.Truncated = true // 窗口外的行没有被比较过：报告不能装作它们干净
	}
pairs:
	for i := 0; i < len(window); i++ {
		for j := i + 1; j < len(window); j++ {
			if window[i].Kind != window[j].Kind {
				continue
			}
			if normalizeDecisionText(window[i].Summary) == normalizeDecisionText(window[j].Summary) {
				continue
			}
			overlap := decisionOverlap(window[i].Summary, window[j].Summary)
			if overlap < DecisionOverlapThreshold {
				continue
			}
			if len(report.Flags) >= DecisionMaxFlags {
				report.Truncated = true
				break pairs // 到顶就停：继续比只会得到被丢弃的结果
			}
			left, right := window[i].ID, window[j].ID
			if left > right {
				left, right = right, left
			}
			report.Flags = append(report.Flags, DecisionFlag{
				Kind: window[i].Kind, Left: left, Right: right,
				Overlap: overlap, Reason: DecisionFlagSharedTopic, Action: DecisionFlagAction,
			})
		}
	}

	// 输出排序固定：同一批输入两次运行必须逐字相同，否则报告没法进 diff、也没法当判据。
	sort.Slice(report.Duplicates, func(i, j int) bool { return report.Duplicates[i][0] < report.Duplicates[j][0] })
	sort.Slice(report.Flags, func(i, j int) bool {
		if report.Flags[i].Kind != report.Flags[j].Kind {
			return report.Flags[i].Kind < report.Flags[j].Kind
		}
		if report.Flags[i].Left != report.Flags[j].Left {
			return report.Flags[i].Left < report.Flags[j].Left
		}
		return report.Flags[i].Right < report.Flags[j].Right
	})
	return report
}

// normalizeDecisionText 规范化：小写、去掉一切非字母数字与非 CJK 的字符。
//
// 为什么按 rune 而不是按词：决策是中文写的，而 Go 标准库没有分词。字符 n-gram 不需要
// 词典，且对「发布日期改到周五」这类短句足够——代价是同音同义不同字抓不到，这一点
// 写在上面的诚实说明里。
func normalizeDecisionText(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// decisionOverlap 两个字符串的 rune bigram Jaccard 重合度。空串或无法成对时返回 0。
func decisionOverlap(a, b string) float64 {
	setA := decisionBigrams(normalizeDecisionText(a))
	setB := decisionBigrams(normalizeDecisionText(b))
	if len(setA) == 0 || len(setB) == 0 {
		return 0
	}
	shared := 0
	for g := range setA {
		if setB[g] {
			shared++
		}
	}
	union := len(setA) + len(setB) - shared
	if union == 0 {
		return 0
	}
	return float64(shared) / float64(union)
}

func decisionBigrams(s string) map[string]bool {
	runes := []rune(s)
	out := map[string]bool{}
	if len(runes) == 1 {
		out[string(runes)] = true
		return out
	}
	for i := 0; i+1 < len(runes); i++ {
		out[string(runes[i:i+2])] = true
	}
	return out
}
