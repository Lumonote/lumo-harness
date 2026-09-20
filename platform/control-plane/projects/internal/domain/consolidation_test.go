package domain

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func signal(id, kind, summary string, at time.Time) DecisionSignal {
	return DecisionSignal{ID: id, Kind: kind, Summary: summary, CreatedAt: at}
}

func hasFlag(report ConsolidationReport, left, right string) *DecisionFlag {
	for i := range report.Flags {
		f := report.Flags[i]
		if (f.Left == left && f.Right == right) || (f.Left == right && f.Right == left) {
			return &report.Flags[i]
		}
	}
	return nil
}

// §24.4 判据 5：矛盾**只标注**。这里钉住「报告里没有任何能表达裁决的字段」——
// 想加「哪条赢」的实现会先撞红这条用例。
func TestConsolidationReportIsFlagOnly(t *testing.T) {
	now := time.Now().UTC()
	report := Consolidate([]DecisionSignal{
		signal("dec_a", DecisionKindDecision, "发布日期改到周五", now),
		signal("dec_b", DecisionKindDecision, "发布日期改到下周三", now.Add(-time.Minute)),
	}, DecisionIndexDefaultLimit)

	if report.Policy != ConsolidationPolicy {
		t.Fatalf("policy = %q, want %q（报告不是裁决结果）", report.Policy, ConsolidationPolicy)
	}
	for _, f := range report.Flags {
		if f.Action != DecisionFlagAction {
			t.Fatalf("flag 的 action = %q，本层唯一的动词是 %q", f.Action, DecisionFlagAction)
		}
		switch f.Reason {
		case DecisionFlagSharedTopic, DecisionFlagDuplicate:
		default:
			t.Fatalf("reason 闭集外: %q", f.Reason)
		}
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("序列化: %v", err)
	}
	// 反证法式的守卫：任何形如「保留/作废/赢家」的字段名都不该出现在报告里。
	for _, forbidden := range []string{"winner", "keep", "drop", "resolve", "supersede"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("报告里出现了 %q 形状的字段——只标注不裁决:\n%s", forbidden, encoded)
		}
	}
}

// 去重：规范化后（大小写/空白/标点）逐字相同即同组，且**不重复**报成矛盾候选。
func TestConsolidateDeduplicates(t *testing.T) {
	now := time.Now().UTC()
	report := Consolidate([]DecisionSignal{
		signal("dec_c", DecisionKindTrap, "动账单服务前先联系张工", now),
		signal("dec_a", DecisionKindTrap, "动账单服务前，先联系张工。", now),
		signal("dec_b", DecisionKindTrap, "  动账单服务前先联系张工 ", now),
	}, DecisionIndexDefaultLimit)

	if len(report.Duplicates) != 1 {
		t.Fatalf("应有 1 组重复: %+v", report.Duplicates)
	}
	group := report.Duplicates[0]
	want := []string{"dec_a", "dec_b", "dec_c"}
	for i, id := range want {
		if group[i] != id {
			t.Fatalf("重复组应按 id 排序 %v, got %v", want, group)
		}
	}
	// 同组内 2 条 flag（首个与其余配对），且理由是 duplicate-summary 而不是 shared-topic。
	if len(report.Flags) != 2 {
		t.Fatalf("重复组应产出 2 条 flag: %+v", report.Flags)
	}
	for _, f := range report.Flags {
		if f.Reason != DecisionFlagDuplicate || f.Overlap != 1 {
			t.Fatalf("重复的 flag 形状: %+v", f)
		}
	}
}

// 矛盾候选：§24.4 举的那对例子（改到周五 vs 改到下周三）必须被标出来。
func TestConsolidateFlagsSharedTopic(t *testing.T) {
	now := time.Now().UTC()
	report := Consolidate([]DecisionSignal{
		signal("dec_new", DecisionKindDecision, "发布日期改到周五", now),
		signal("dec_old", DecisionKindDecision, "发布日期改到下周三", now.Add(-time.Hour)),
		// 无关决策：同项目但不同话题，不得被标
		signal("dec_other", DecisionKindDecision, "联系张工开通账单只读账号", now.Add(-2*time.Hour)),
	}, DecisionIndexDefaultLimit)

	flag := hasFlag(report, "dec_new", "dec_old")
	if flag == nil {
		t.Fatalf("同一话题的两种说法必须被标: %+v", report.Flags)
	}
	if flag.Reason != DecisionFlagSharedTopic || flag.Overlap < DecisionOverlapThreshold {
		t.Fatalf("flag 形状: %+v", flag)
	}
	for _, f := range report.Flags {
		if f.Left == "dec_other" || f.Right == "dec_other" {
			t.Fatalf("无关决策被误标: %+v", f)
		}
	}
}

// 跨 kind 不比：kind 是最粗的话题分类，decision 与 ownership 之间词面重合不构成矛盾信号。
func TestConsolidateDoesNotCompareAcrossKinds(t *testing.T) {
	now := time.Now().UTC()
	report := Consolidate([]DecisionSignal{
		signal("dec_1", DecisionKindDecision, "发布日期改到周五", now),
		signal("dec_2", DecisionKindBoundary, "发布日期改到下周三", now),
	}, DecisionIndexDefaultLimit)
	if len(report.Flags) != 0 {
		t.Fatalf("跨 kind 不该产生 flag: %+v", report.Flags)
	}
}

// 剪枝候选 = 索引上限之外的行，按最旧优先。行的顺序必须与索引读面同序
// （created_at DESC, id DESC），否则「索引里有什么」与「该剪什么」会互相矛盾。
func TestConsolidatePruneCandidatesFollowIndexOrder(t *testing.T) {
	base := time.Now().UTC()
	rows := []DecisionSignal{
		signal("dec_1", DecisionKindDecision, "第一条", base.Add(-4*time.Minute)),
		signal("dec_2", DecisionKindDecision, "第二条", base.Add(-3*time.Minute)),
		signal("dec_3", DecisionKindDecision, "第三条", base.Add(-2*time.Minute)),
		signal("dec_4", DecisionKindDecision, "第四条", base.Add(-1*time.Minute)),
		signal("dec_5", DecisionKindDecision, "第五条", base),
	}
	report := Consolidate(rows, 2)
	// 索引按新在前只留 dec_5, dec_4；候选 = 其余三条，最旧的最先处理。
	want := []string{"dec_1", "dec_2", "dec_3"}
	if fmt.Sprint(report.PruneCandidates) != fmt.Sprint(want) {
		t.Fatalf("剪枝候选 = %v, want %v", report.PruneCandidates, want)
	}
	// 上限之内不报候选
	if got := Consolidate(rows, 5).PruneCandidates; len(got) != 0 {
		t.Fatalf("未超上限不该有候选: %v", got)
	}
	// 同一时刻用 id 倒序兜平手：与 SQL 的 ORDER BY created_at DESC, id DESC 同序。
	same := []DecisionSignal{
		signal("dec_a", DecisionKindDecision, "同刻 a", base),
		signal("dec_b", DecisionKindDecision, "同刻 b", base),
	}
	if got := Consolidate(same, 1).PruneCandidates; len(got) != 1 || got[0] != "dec_a" {
		t.Fatalf("平手时应剪 id 较小的那个: %v", got)
	}
}

// 判据：固化任务对空输入不 panic，且输出是空集而不是 nil（JSON 里 null 与 [] 的差别
// 会让消费方各写一份兜底）。
func TestConsolidateEmpty(t *testing.T) {
	report := Consolidate(nil, 0)
	if report.Examined != 0 || report.IndexCap != DecisionIndexDefaultLimit {
		t.Fatalf("空输入的报告: %+v", report)
	}
	if report.Duplicates == nil || report.Flags == nil || report.PruneCandidates == nil {
		t.Fatalf("空集必须是 [] 而不是 nil: %+v", report)
	}
}

// 确定性：同一批输入两次运行必须逐字相同（报告要能进 diff、能当判据）。
func TestConsolidateIsDeterministic(t *testing.T) {
	now := time.Now().UTC()
	rows := []DecisionSignal{}
	for i := 0; i < 40; i++ {
		rows = append(rows, signal(
			fmt.Sprintf("dec_%02d", i), DecisionKindDecision,
			fmt.Sprintf("发布节奏第 %d 次调整到周五", i/2), now.Add(-time.Duration(i)*time.Minute)))
	}
	first, err := json.Marshal(Consolidate(rows, 8))
	if err != nil {
		t.Fatalf("序列化: %v", err)
	}
	second, err := json.Marshal(Consolidate(rows, 8))
	if err != nil {
		t.Fatalf("序列化: %v", err)
	}
	if string(first) != string(second) {
		t.Fatalf("同一批输入两次结果不同:\n%s\n%s", first, second)
	}
}

// 有界：两两比较窗口与 flag 条数都有上限，触顶时 Truncated 必须为真。
func TestConsolidateIsBounded(t *testing.T) {
	now := time.Now().UTC()
	rows := []DecisionSignal{}
	for i := 0; i < DecisionPairwiseRows+5; i++ {
		rows = append(rows, signal(
			fmt.Sprintf("dec_%04d", i), DecisionKindDecision,
			fmt.Sprintf("把发布窗口挪到第 %d 周的周五", i), now.Add(-time.Duration(i)*time.Minute)))
	}
	report := Consolidate(rows, DecisionIndexDefaultLimit)
	if len(report.Flags) > DecisionMaxFlags {
		t.Fatalf("flag 条数 %d 超上限 %d", len(report.Flags), DecisionMaxFlags)
	}
	if !report.Truncated {
		t.Fatalf("窗口外还有 %d 行没被比较，Truncated 必须为真: %+v", len(rows)-DecisionPairwiseRows, report)
	}
	if report.PairwiseWindow != DecisionPairwiseRows {
		t.Fatalf("报告要写明比较窗口: %d", report.PairwiseWindow)
	}
}

// 频率说明必须出现在**每一份**报告里，且本层不携带周期常量。
//
// 为什么值得单列一条：读报告的人可能看到的是一份空报告，而空报告的两种成因完全相反
// （记忆干净 / 固化任务从没跑过）。频率是运营参数，报告只能把「默认关闭、须显式配置」
// 说出来，不能替读者猜。反过来说，本层若出现任何形如「每隔 N 分钟」的常量，就是把
// §16 R4 明确拒绝的编造默认值塞进了判据层。
func TestConsolidationReportCarriesFrequencyNote(t *testing.T) {
	report := Consolidate(nil, DecisionIndexDefaultLimit)
	if report.FrequencyNote != DecisionFrequencyNote {
		t.Fatalf("报告缺频率说明: %q", report.FrequencyNote)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("序列化: %v", err)
	}
	if !strings.Contains(string(encoded), `"frequency_note"`) {
		t.Fatalf("频率说明要出现在序列化结果里（消费方据此渲染）:\n%s", encoded)
	}
}
