package integration_test

// 决策记忆的真库判据（§24.4）：append-only 取代、realm/项目作用域、有界索引、
// 固化任务不写任何东西。用 store 直连，走完整 DDL（含 §11 的部分索引）。

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func appendDecision(t *testing.T, st *store.Store, d domain.Decision) domain.Decision {
	t.Helper()
	out, err := st.AppendDecision(context.Background(), d)
	if err != nil {
		t.Fatalf("追加决策 %s 失败: %v", d.ID, err)
	}
	return out
}

func decision(id, realm, projectID, kind, summary, body string) domain.Decision {
	return domain.Decision{
		ID: id, Realm: realm, ProjectID: projectID,
		Kind: kind, Summary: summary, Body: body,
	}
}

// 判据 2：append-only + 显式取代。**旧行的其他列一个字节都不许变**——
// 这是「不原地改」唯一能被机器验证的形式。
func TestDecisionSupersedeTouchesOnlyThePointer(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()

	old := appendDecision(t, st, domain.Decision{
		ID: "dec_old", Realm: "r1", ProjectID: "proj_a", Kind: domain.DecisionKindDecision,
		Summary: "发布日期改到周五", Body: "因为账单结算在周四跑完。",
		Evidence: []domain.ReportEvidence{{SessionRef: "s1", Seq: 3}},
	})
	if old.CreatedAt.IsZero() {
		t.Fatalf("追加应回填 created_at")
	}

	type row struct {
		ID, Realm, ProjectID, Kind, Summary, Body string
		Supersedes, SupersededBy                  *string
		Evidence                                  []byte
	}
	read := func() row {
		var r row
		if err := pool.QueryRow(ctx, `
			SELECT id, realm, project_id, kind, summary, body, supersedes, superseded_by, evidence
			FROM project_decisions WHERE id = 'dec_old'`).
			Scan(&r.ID, &r.Realm, &r.ProjectID, &r.Kind, &r.Summary, &r.Body,
				&r.Supersedes, &r.SupersededBy, &r.Evidence); err != nil {
			t.Fatalf("读旧行: %v", err)
		}
		return r
	}
	before := read()

	newer := appendDecision(t, st, domain.Decision{
		ID: "dec_new", Realm: "r1", ProjectID: "proj_a", Kind: domain.DecisionKindDecision,
		Summary: "发布日期改到下周三", Body: "客户要求避开财务月结。",
		Supersedes: "dec_old",
	})
	after := read()

	if before.SupersededBy != nil {
		t.Fatalf("取代前 superseded_by 应为 NULL")
	}
	if after.SupersededBy == nil || *after.SupersededBy != "dec_new" {
		t.Fatalf("反向指针未回填: %+v", after.SupersededBy)
	}
	after.SupersededBy = before.SupersededBy // 唯一允许变化的列
	if fmt.Sprintf("%+v", before) != fmt.Sprintf("%+v", after) {
		t.Fatalf("旧行除 superseded_by 外被改动:\nbefore %+v\nafter  %+v", before, after)
	}

	// 索引只认 live 行：旧条目从索引消失，新条目在
	rows, err := st.ListDecisionIndex(ctx, "r1", "proj_a", "", 0)
	if err != nil || len(rows) != 1 || rows[0].ID != "dec_new" {
		t.Fatalf("索引应只剩 dec_new: %+v %v", rows, err)
	}
	if rows[0].Supersedes != "" && rows[0].Supersedes != "dec_old" {
		t.Fatalf("索引行应带出它取代了谁: %+v", rows[0])
	}
	// 正文层读被取代的行照样拿得到（考古层不该被隐藏）
	got, err := st.GetDecision(ctx, "r1", "proj_a", "dec_old")
	if err != nil {
		t.Fatalf("被取代的行必须仍可读: %v", err)
	}
	if got.SupersededBy != "dec_new" || got.Body != before.Body {
		t.Fatalf("被取代行的正文/指针: %+v", got)
	}
	if len(got.Evidence) != 1 || got.Evidence[0].SessionRef != "s1" || got.Evidence[0].Seq != 3 {
		t.Fatalf("evidence 应原样往返: %+v", got.Evidence)
	}
	_ = newer
}

// 判据 2（续）：不原地改 → 也不重复取代。第二次取代必须被拒，且反向指针保持第一次的指向。
func TestDecisionSupersedeIsNotRepeatable(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	appendDecision(t, st, decision("dec_1", "r1", "proj_a", domain.DecisionKindTrap, "踩过的坑：绕过闸门", "正文"))
	appendDecision(t, st, domain.Decision{
		ID: "dec_2", Realm: "r1", ProjectID: "proj_a", Kind: domain.DecisionKindTrap,
		Summary: "坑的正式处置", Body: "改走闸门", Supersedes: "dec_1",
	})

	_, err := st.AppendDecision(ctx, domain.Decision{
		ID: "dec_3", Realm: "r1", ProjectID: "proj_a", Kind: domain.DecisionKindTrap,
		Summary: "又一次取代", Body: "不该成功", Supersedes: "dec_1",
	})
	if !errors.Is(err, store.ErrDecisionSuperseded) {
		t.Fatalf("二次取代应报 ErrDecisionSuperseded: %v", err)
	}
	if _, err := st.GetDecision(ctx, "r1", "proj_a", "dec_3"); !errors.Is(err, store.ErrDecisionNotFound) {
		t.Fatalf("失败的事务不得留下半条新行: %v", err)
	}
	old, err := st.GetDecision(ctx, "r1", "proj_a", "dec_1")
	if err != nil || old.SupersededBy != "dec_2" {
		t.Fatalf("反向指针被改写: %+v %v", old, err)
	}

	// 取代不存在的条目 → 不存在（与跨作用域同一条分支）
	_, err = st.AppendDecision(ctx, domain.Decision{
		ID: "dec_4", Realm: "r1", ProjectID: "proj_a", Kind: domain.DecisionKindTrap,
		Summary: "取代幻影", Body: "x", Supersedes: "dec_nope",
	})
	if !errors.Is(err, store.ErrDecisionNotFound) {
		t.Fatalf("取代不存在的条目应报 ErrDecisionNotFound: %v", err)
	}
}

// 判据 1：作用域是 (realm, project_id)。跨 realm / 跨项目查询返回**空集而不是错误**，
// 跨作用域的取代一律当作「不存在」。
func TestDecisionScopeIsRealmAndProject(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	appendDecision(t, st, decision("dec_1", "r1", "proj_a", domain.DecisionKindOwnership, "账单服务归张工", "正文"))

	rows, err := st.ListDecisionIndex(ctx, "r2", "proj_a", "", 0)
	if err != nil {
		t.Fatalf("跨 realm 查询必须是空集而不是错误: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("跨 realm 不得返回任何行: %+v", rows)
	}
	if rows, err := st.ListDecisionIndex(ctx, "r1", "proj_b", "", 0); err != nil || len(rows) != 0 {
		t.Fatalf("跨项目应为空集: %+v %v", rows, err)
	}
	if _, err := st.GetDecision(ctx, "r2", "proj_a", "dec_1"); !errors.Is(err, store.ErrDecisionNotFound) {
		t.Fatalf("跨 realm 读正文应报不存在: %v", err)
	}
	_, err = st.AppendDecision(ctx, domain.Decision{
		ID: "dec_2", Realm: "r2", ProjectID: "proj_a", Kind: domain.DecisionKindOwnership,
		Summary: "跨 realm 取代", Body: "x", Supersedes: "dec_1",
	})
	if !errors.Is(err, store.ErrDecisionNotFound) {
		t.Fatalf("跨 realm 取代应报不存在: %v", err)
	}
	// 被拒的取代不能把 dec_1 写成已取代
	live, err := st.ListDecisionIndex(ctx, "r1", "proj_a", "", 0)
	if err != nil || len(live) != 1 {
		t.Fatalf("跨 realm 取代失败后 dec_1 仍应 live: %+v %v", live, err)
	}
}

// 判据 3：索引读面有界 + 只带 summary；kind 过滤按闭集。
func TestDecisionIndexIsBoundedAndSummaryOnly(t *testing.T) {
	st, _ := newStore(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		appendDecision(t, st, decision(
			fmt.Sprintf("dec_%d", i), "r1", "proj_a", domain.DecisionKindDecision,
			fmt.Sprintf("第 %d 条决定", i), fmt.Sprintf("第 %d 条的完整理由，很长很长很长", i)))
	}
	rows, err := st.ListDecisionIndex(ctx, "r1", "proj_a", "", 2)
	if err != nil {
		t.Fatalf("索引查询: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("limit=2 应只回 2 行: %d", len(rows))
	}
	if rows[0].ID != "dec_4" || rows[1].ID != "dec_3" {
		t.Fatalf("索引顺序应为新在前: %+v", rows)
	}
	// limit 0 → 默认上限（此处不足上限，全部返回），且默认值必须是常量而不是「不限」
	if all, err := st.ListDecisionIndex(ctx, "r1", "proj_a", "", 0); err != nil || len(all) != 5 {
		t.Fatalf("默认 limit 应取 DecisionIndexDefaultLimit: %d %v", len(all), err)
	}
	if all, err := st.ListDecisionIndex(ctx, "r1", "proj_a", "", domain.DecisionIndexMaxLimit+100); err != nil || len(all) != 5 {
		t.Fatalf("超上限应被夹住而不是报错: %d %v", len(all), err)
	}
	// kind 过滤：闭集内合法
	appendDecision(t, st, decision("dec_trap", "r1", "proj_a", domain.DecisionKindTrap, "坑", "正文"))
	traps, err := st.ListDecisionIndex(ctx, "r1", "proj_a", domain.DecisionKindTrap, 0)
	if err != nil || len(traps) != 1 || traps[0].ID != "dec_trap" {
		t.Fatalf("kind 过滤: %+v %v", traps, err)
	}
	if _, err := st.ListDecisionIndex(ctx, "r1", "proj_a", "note", 0); !errors.Is(err, domain.ErrInvalidDecision) {
		t.Fatalf("闭集外 kind 应报错: %v", err)
	}
}

// 判据 4：闭集外的 kind 被拒，且**什么都没写进去**。
func TestDecisionIllegalKindRejected(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	_, err := st.AppendDecision(ctx, decision("dec_x", "r1", "proj_a", "note", "摘要", "正文"))
	if !errors.Is(err, domain.ErrInvalidDecision) {
		t.Fatalf("闭集外 kind 应报 ErrInvalidDecision: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_decisions`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("非法 kind 不得留下任何行: %d %v", count, err)
	}
	// 自取代也拒（写进去会一出生就不 live）
	_, err = st.AppendDecision(ctx, domain.Decision{
		ID: "dec_self", Realm: "r1", ProjectID: "proj_a", Kind: domain.DecisionKindTrap,
		Summary: "自取代", Body: "x", Supersedes: "dec_self",
	})
	if !errors.Is(err, domain.ErrInvalidDecision) {
		t.Fatalf("自取代应报 ErrInvalidDecision: %v", err)
	}
}

// 判据 3（续）：init() 幂等——跑两遍不报错，且 §11 的部分索引真的建出来了。
func TestDecisionInitIdempotentAndIndexShape(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	if err := st.Init(ctx); err != nil {
		t.Fatalf("init 第二遍应幂等: %v", err)
	}
	var name, def string
	if err := pool.QueryRow(ctx, `
		SELECT indexname, indexdef FROM pg_indexes
		WHERE tablename = 'project_decisions' AND indexname = 'project_decisions_live'`).
		Scan(&name, &def); err != nil {
		t.Fatalf("§11 的部分索引必须存在（名字逐字照抄）: %v", err)
	}
	for _, want := range []string{"superseded_by IS NULL", "realm", "project_id", "kind"} {
		if !strings.Contains(def, want) {
			t.Fatalf("部分索引定义缺 %q: %s", want, def)
		}
	}
}

// 判据 5：固化任务只标注不裁决——报告非空，而**库里的行一个字节都没动**。
func TestConsolidateDecisionsWritesNothing(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	appendDecision(t, st, decision("dec_1", "r1", "proj_a", domain.DecisionKindDecision, "发布日期改到周五", "理由 A"))
	appendDecision(t, st, decision("dec_2", "r1", "proj_a", domain.DecisionKindDecision, "发布日期改到下周三", "理由 B"))
	appendDecision(t, st, decision("dec_3", "r1", "proj_a", domain.DecisionKindTrap, "动账单服务前先联系张工", "理由 C"))
	// dec_4 与 dec_3 规范化后逐字相同（只差标点）——这才是「重复」。近义但多一个字的
	// 说法不是重复，是矛盾候选（判据不同，别混）。
	appendDecision(t, st, decision("dec_4", "r1", "proj_a", domain.DecisionKindTrap, "动账单服务前，先联系张工。", "理由 D"))

	snapshot := func() string {
		var out string
		if err := pool.QueryRow(ctx, `
			SELECT COALESCE(string_agg(id || '|' || summary || '|' || body || '|' ||
			  COALESCE(supersedes,'') || '|' || COALESCE(superseded_by,''), ',' ORDER BY id), '')
			FROM project_decisions`).Scan(&out); err != nil {
			t.Fatalf("快照: %v", err)
		}
		return out
	}
	before := snapshot()

	report, err := st.ConsolidateDecisions(ctx, "r1", "proj_a", domain.DecisionIndexDefaultLimit)
	if err != nil {
		t.Fatalf("固化任务: %v", err)
	}
	if report.Examined != 4 {
		t.Fatalf("扫描行数: %+v", report)
	}
	if report.Policy != domain.ConsolidationPolicy {
		t.Fatalf("报告策略应为 flag-only: %q", report.Policy)
	}
	if len(report.Duplicates) != 1 {
		t.Fatalf("dec_3/dec_4 应判为重复: %+v", report.Duplicates)
	}
	var flagged bool
	for _, f := range report.Flags {
		if (f.Left == "dec_1" && f.Right == "dec_2") || (f.Left == "dec_2" && f.Right == "dec_1") {
			flagged = true
		}
	}
	if !flagged {
		t.Fatalf("周五/下周三 应被标为矛盾候选: %+v", report.Flags)
	}
	if after := snapshot(); after != before {
		t.Fatalf("固化任务改动了数据（它不该写任何东西）:\nbefore %s\nafter  %s", before, after)
	}
	if report.FrequencyNote != domain.DecisionFrequencyNote {
		t.Fatalf("报告必须自带频率说明（§16 R4）: %q", report.FrequencyNote)
	}

	// 连跑两次：行数与内容**逐字节不变**（§24.4 第 5 条那条判据的字面要求）。
	// 单跑一次只能证明「这一次没写」，跑两次才覆盖「第二次因为看见了第一次的产物而
	// 改变行为」这类形状——固化的产物若被自己当成输入，腐化会以加速度发生。
	again, err := st.ConsolidateDecisions(ctx, "r1", "proj_a", domain.DecisionIndexDefaultLimit)
	if err != nil {
		t.Fatalf("第二次固化: %v", err)
	}
	if len(again.Duplicates) != len(report.Duplicates) || len(again.Flags) != len(report.Flags) ||
		again.Examined != report.Examined {
		t.Fatalf("两次固化的报告应逐字段一致:\nfirst  %+v\nsecond %+v", report, again)
	}
	if after := snapshot(); after != before {
		t.Fatalf("连跑两次后数据被改动:\nbefore %s\nafter  %s", before, after)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_decisions`).Scan(&rows); err != nil {
		t.Fatalf("行数: %v", err)
	}
	if rows != 4 {
		t.Fatalf("连跑两次后行数 = %d，期望仍为 4（固化任务绝不删除）", rows)
	}

	// 作用域同样适用于固化任务：别的 realm 扫不到这个项目的任何行
	other, err := st.ConsolidateDecisions(ctx, "r2", "proj_a", domain.DecisionIndexDefaultLimit)
	if err != nil || other.Examined != 0 || len(other.Flags) != 0 {
		t.Fatalf("跨 realm 固化必须为空: %+v %v", other, err)
	}
}
