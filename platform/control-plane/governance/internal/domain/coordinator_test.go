package domain

import "testing"

// §24.7 / §24.8 的 Go 侧判据测试。判据源在 `shared/seam-contracts/coordinator.ts`，
// 这里逐条钉住它——尤其是**缺省**与**阈值边界**这两类只有在两侧都写错时才不报错的地方。

func TestIntegrationGatePassesOnlyWhenBothEvidencePass(t *testing.T) {
	cases := []struct {
		contractTests bool
		smoke         bool
		want          IntegrationVerdict
	}{
		{true, true, IntegrationPass},
		{true, false, IntegrationRejectBatch},
		{false, true, IntegrationRejectBatch},
		{false, false, IntegrationRejectBatch},
	}
	for _, c := range cases {
		got := IntegrationGate(IntegrationGateFacts{ContractTestsPass: c.contractTests, SmokePass: c.smoke})
		if got != c.want {
			t.Fatalf("contractTests=%v smoke=%v: got %q, want %q", c.contractTests, c.smoke, got, c.want)
		}
	}
	// 零值即「没有证据」，必须打回：这是 fail-closed 的实现方式，
	// 漏填字段与验证不过在这里是同一条路径。
	if got := IntegrationGate(IntegrationGateFacts{}); got != IntegrationRejectBatch {
		t.Fatalf("absent evidence produced %q, want %q", got, IntegrationRejectBatch)
	}
}

// TestIntegrationGateHangsOnTheReviewEdge 是闸门的**落点**测试：
// 它挂在 `IN_REVIEW → DONE` 这条边上，打回时整批回 `ROUTING`（§24.7 + §23.3），
// 且不新增状态、不改闭集（对照 domain.go 的 businessStates）。
func TestIntegrationGateHangsOnTheReviewEdge(t *testing.T) {
	pass := IntegrationGateFacts{ContractTestsPass: true, SmokePass: true}
	fail := IntegrationGateFacts{}

	next, verdict, err := TransitionBusinessTaskGated(BusinessInReview, "complete", pass)
	if err != nil || next != BusinessDone || verdict != IntegrationPass {
		t.Fatalf("passing batch: next=%q verdict=%q err=%v", next, verdict, err)
	}
	next, verdict, err = TransitionBusinessTaskGated(BusinessInReview, "complete", fail)
	if err != nil {
		t.Fatalf("batch rejection must be a verdict, not an error: %v", err)
	}
	if next != BusinessRouting || verdict != IntegrationRejectBatch {
		t.Fatalf("rejected batch: next=%q verdict=%q, want %q / %q", next, verdict, BusinessRouting, IntegrationRejectBatch)
	}

	// 闸门只在这个边上问一次：其余边上不读事实，verdict 恒为 pass（不适用 ≠ 通过，
	// 但两者都不该让调用方在审计里写出一条假的打回）。
	for _, edge := range []struct{ from, event, want string }{
		{BusinessDraft, "route", BusinessRouting},
		{BusinessRouting, "assign", BusinessAssigned},
		{BusinessExecuting, "verify", BusinessVerifying},
		{BusinessVerifying, "submit_review", BusinessInReview},
		{BusinessInReview, "submit_review", BusinessInReview},
	} {
		next, verdict, err := TransitionBusinessTaskGated(edge.from, edge.event, fail)
		if err != nil || next != edge.want || verdict != IntegrationPass {
			t.Fatalf("%s --%s--> next=%q verdict=%q err=%v, want %q / pass",
				edge.from, edge.event, next, verdict, err, edge.want)
		}
	}

	// 不存在的边仍然拒绝，闸门不给它开后门（DRAFT 上根本没有 complete）。
	if _, _, err := TransitionBusinessTaskGated(BusinessDraft, "complete", pass); err == nil {
		t.Fatal("complete from DRAFT was accepted; the closed set must not widen")
	}
}

func TestReviewerEligibilityFollowsTheCoordinatorContract(t *testing.T) {
	diverse := func(mutate func(*ReviewerFacts)) ReviewerFacts {
		facts := ReviewerFacts{
			Dispatcher: "coordinator", Reviewer: "reviewer",
			DispatcherPreset: "swe", ReviewerPreset: "swe",
			DispatcherModel: "opus", ReviewerModel: "opus",
			DispatcherNode: "node-a", ReviewerNode: "node-a",
			AffectedArtifacts: 1,
		}
		mutate(&facts)
		return facts
	}

	cases := []struct {
		name     string
		facts    ReviewerFacts
		eligible bool
		reason   ReviewerIneligibility
	}{
		{
			// 顺序判据：invalid-input 排在 self-review 之前（与 TS 一致），
			// 否则「数据坏了」会被记成「审查者不合格」——判据失真的方向恰好是放行。
			name:   "invalid input outranks self review",
			facts:  ReviewerFacts{Dispatcher: "same", Reviewer: "same", AffectedArtifacts: -1},
			reason: ReviewerInvalidInput,
		},
		{
			name:   "dispatcher cannot review its own run",
			facts:  ReviewerFacts{Dispatcher: "coordinator", Reviewer: "coordinator", AffectedArtifacts: 1},
			reason: ReviewerSelfReview,
		},
		{
			// 三个维度全空：缺省不视为「不同」。
			name:   "absent dimensions are homogeneous",
			facts:  ReviewerFacts{Dispatcher: "coordinator", Reviewer: "reviewer"},
			reason: ReviewerHomogeneous,
		},
		{
			// 只给了一侧的值同样不算「可证不同」——同一条纪律的另一半。
			name: "one-sided values are not evidence of diversity",
			facts: ReviewerFacts{
				Dispatcher: "coordinator", Reviewer: "reviewer",
				DispatcherPreset: "swe", DispatcherModel: "opus", DispatcherNode: "node-a",
				AffectedArtifacts: 1,
			},
			reason: ReviewerHomogeneous,
		},
		{
			name:   "identical values are homogeneous",
			facts:  diverse(func(f *ReviewerFacts) {}),
			reason: ReviewerHomogeneous,
		},
		{
			// 阈值边界：2 个产出物时「换节点」还够用。
			name:     "different node below the threshold is enough",
			facts:    diverse(func(f *ReviewerFacts) { f.ReviewerNode = "node-b"; f.AffectedArtifacts = 2 }),
			eligible: true,
		},
		{
			// 达到阈值后「换了个节点」不构成多样性：同一份权重、同一套盲区。
			name:   "different node at the threshold is not diversity",
			facts:  diverse(func(f *ReviewerFacts) { f.ReviewerNode = "node-b"; f.AffectedArtifacts = 3 }),
			reason: ReviewerHighImpactNeedsModelDiversity,
		},
		{
			name:     "different model at the threshold is diversity",
			facts:    diverse(func(f *ReviewerFacts) { f.ReviewerModel = "sonnet"; f.AffectedArtifacts = 3 }),
			eligible: true,
		},
		{
			name:     "different preset at the threshold is diversity",
			facts:    diverse(func(f *ReviewerFacts) { f.ReviewerPreset = "reviewer"; f.AffectedArtifacts = 3 }),
			eligible: true,
		},
		{
			// 节点 + 模型同时不同，阈值上当然合格（这一条防的是把条件写反）。
			name: "model and node both differ above the threshold",
			facts: diverse(func(f *ReviewerFacts) {
				f.ReviewerModel, f.ReviewerNode = "sonnet", "node-b"
				f.AffectedArtifacts = 9
			}),
			eligible: true,
		},
		{
			// 高影响 + 只有 preset 不同 = 合格（preset 是模型的等价物）。
			name:     "preset only, high impact",
			facts:    diverse(func(f *ReviewerFacts) { f.ReviewerPreset = "reviewer"; f.AffectedArtifacts = 3 }),
			eligible: true,
		},
	}

	closedSet := map[ReviewerIneligibility]bool{
		ReviewerSelfReview: true, ReviewerHomogeneous: true,
		ReviewerHighImpactNeedsModelDiversity: true, ReviewerInvalidInput: true,
	}
	for _, c := range cases {
		got := ReviewerEligibility(c.facts)
		if got.Eligible != c.eligible || got.Reason != c.reason {
			t.Fatalf("%s: got eligible=%v reason=%q, want eligible=%v reason=%q",
				c.name, got.Eligible, got.Reason, c.eligible, c.reason)
		}
		// 两个不变量：不合格必有闭集里的理由；合格必不带理由。
		if got.Eligible && got.Reason != "" {
			t.Fatalf("%s: eligible verdict carried reason %q", c.name, got.Reason)
		}
		if !got.Eligible && !closedSet[got.Reason] {
			t.Fatalf("%s: reason %q is outside the closed set", c.name, got.Reason)
		}
	}

	// 阈值常量本身也是契约的一部分（§24.8 的「3 个产出物」）。
	if HighImpactArtifacts != 3 {
		t.Fatalf("HighImpactArtifacts = %d, want 3", HighImpactArtifacts)
	}
}

// §24.8 规则 3 的阈值档位（治理面独有的一组判据，见文件头）。
//
// 测的是「判不出来」这一档：它是这条判据里唯一容易写错、且写错的方向恰好是放行的地方——
// 把无从证明的影响面并进「可证地小」，就等于给一次没人能证明的小改动发了「只作提示」的通行证。
func TestReviewDispositionSeparatesUnprovableFromProvablySmall(t *testing.T) {
	cases := []struct {
		name   string
		impact ReviewImpact
		want   ReviewDisposition
	}{
		// 零值 = 没有这个数。**不是**「0 个产出物」——这正是本类型存在的理由。
		{"no producer for the count", ReviewImpact{}, ReviewImpactUnprovable},
		// 生产者出现后仍可能判不出来（例如那一次执行没有可用的证据）；同样是不可证。
		{"producer gave no value", ReviewImpact{Artifacts: 0, Proven: false}, ReviewImpactUnprovable},
		{"provably none is below the threshold", ReviewImpact{Artifacts: 0, Proven: true}, ReviewBelowThreshold},
		// 边界两侧：阈值常量取自 HighImpactArtifacts（下面那条断言钉住它 = 3），
		// 所以这里写 `-1` / 常量本身，而不是写死 2 / 3。
		{"one below the threshold", ReviewImpact{Artifacts: HighImpactArtifacts - 1, Proven: true}, ReviewBelowThreshold},
		{"at the threshold", ReviewImpact{Artifacts: HighImpactArtifacts, Proven: true}, ReviewMandated},
		{"above the threshold", ReviewImpact{Artifacts: HighImpactArtifacts + 6, Proven: true}, ReviewMandated},
	}
	for _, c := range cases {
		if got := ReviewDispositionFor(c.impact); got != c.want {
			t.Fatalf("%s: got %q, want %q", c.name, got, c.want)
		}
	}

	// 三档闭集：多出来的值意味着有人另加了一档，而记录侧（审计/看板）会静默认不出它。
	closedSet := map[ReviewDisposition]bool{
		ReviewBelowThreshold: true, ReviewMandated: true, ReviewImpactUnprovable: true,
	}
	for _, c := range cases {
		if !closedSet[ReviewDispositionFor(c.impact)] {
			t.Fatalf("%s: disposition outside the closed set", c.name)
		}
	}
}

// 阈值判断只有一份实现：`ReviewerEligibility` 的第 4 条不再自己比一次 `>= HighImpactArtifacts`，
// 而是问 `ReviewDispositionFor`。这条用例钉住「两条路给出同一个答案」——判据合并之后，
// 唯一能把它们再拆开的动作就是有人改回写死比较。
func TestEligibilityAndDispositionAgreeOnTheThreshold(t *testing.T) {
	for _, artifacts := range []int{0, 1, HighImpactArtifacts - 1, HighImpactArtifacts, HighImpactArtifacts + 1} {
		facts := ReviewerFacts{
			Dispatcher: "coordinator", Reviewer: "reviewer",
			DispatcherPreset: "swe", ReviewerPreset: "swe",
			DispatcherModel: "opus", ReviewerModel: "opus",
			DispatcherNode: "node-a", ReviewerNode: "node-b",
			AffectedArtifacts: artifacts,
		}
		// 只换了节点：阈值以下合格，达到阈值则因为缺模型级多样性而不合格。
		mandated := ReviewDispositionFor(ReviewImpact{Artifacts: artifacts, Proven: true}) == ReviewMandated
		got := ReviewerEligibility(facts)
		if got.Eligible == mandated {
			t.Fatalf("artifacts=%d: eligibility and the threshold disagree (eligible=%v mandated=%v)", artifacts, got.Eligible, mandated)
		}
	}
}
