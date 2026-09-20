package domain

import "fmt"

// §24 集群模式多智能体协同的判据源（Go 侧）。
//
// 权威判据在 TypeScript：`platform/shared/seam-contracts/coordinator.ts`（P6a 已落地）。
// 本文件是它的 **Go 双实现**，只承载 P6c 切片的两组：
//
//   - §24.7 组合正确性 —— {@link IntegrationGate}、{@link TransitionBusinessTaskGated}
//   - §24.8 异构审查者 —— {@link ReviewerEligibility}
//
// §24.5 的两组（动作放行三档 `classifyAction`、兜底回落 `fallbackVerdict`）不在本切片内，
// 落在 control 插件侧；这里不预置半成品，避免出现两份「谁也没接上」的判据。
//
// # 判据与 TS 侧 `coordinator.ts` 逐条对齐
//
// 同一个 §24.7/§24.8，两侧必须给出同一个答案，否则会出现「协调者按 Go 判据说可以过、
// 插件按 TS 判据说不能过」这种谁也解释不了的组合。对齐关系如下（TS 行号按 P6a 落地的
// `coordinator.ts`）：
//
//	| TS `coordinator.ts`                              | 本文件                                        |
//	| ---                                              | ---                                           |
//	| `integrationVerdict`（第 170–175 行）             | `IntegrationGate`                             |
//	| `HIGH_IMPACT_ARTIFACTS = 3`（第 178 行）          | `HighImpactArtifacts`                         |
//	| `reviewerEligibility`（第 219–247 行）            | `ReviewerEligibility`                         |
//	| `ReviewerIneligibility` 四值（第 184–188 行）     | `ReviewerIneligibility` 四常量                |
//
// 逐条判据：
//
//	| # | 判据（TS 注释里的编号）                  | TS 行为                       | Go 行为                       |
//	| --- | ---                                   | ---                           | ---                           |
//	| 1 | `affectedArtifacts` 非非负安全整数       | `invalid-input`               | `ReviewerInvalidInput`        |
//	| 2 | `dispatcher === reviewer`              | `self-review`                 | `ReviewerSelfReview`          |
//	| 3 | 三维都不可证不同                         | `homogeneous`                 | `ReviewerHomogeneous`         |
//	| 4 | `>= 3` 且模型/preset 都不可证不同         | `high-impact-…`               | `ReviewerHighImpact…`         |
//	| 5 | 其余                                    | `eligible: true`              | `Eligible: true`              |
//
// 判据**有序**，先命中先返回；顺序本身就是优先级，两侧不得各自重排。第 1 条排在最前
// 也是 TS 的原样（`coordinator.ts` 先做输入校验再谈职责分离），照抄过来才不会在
// 「dispatcher == reviewer 且 affectedArtifacts 为负」这种输入上分叉。
//
// 另有**一组没有 TS 对应物**的判据：{@link ReviewImpact} / {@link ReviewDisposition} /
// {@link ReviewDispositionFor}。它们不是 §24.8 的判据本身，而是**规则 3 的触发阈值**
// 在治理面的档位——TS 侧没有「治理面证明不了影响面」这件事（插件的入参里这个数总是有值），
// 所以它只在这一侧存在，且是 `HighImpactArtifacts` 唯一的比较处。
//
// # 与 TS 的两处**有意**的表面差异（行为等价，写在这里免得被当成漂移）
//
//  1. TS 用 `undefined` 表示缺省，Go 用空串。于是「显式传空串」在 TS 侧算**已给值**
//     （`'' !== 'x'` 成立 → 算异构），在 Go 侧算**缺省**（不算异构）。Go 这一侧更严，
//     方向是对的：判不出差别时按没差别处理，而「没差别」在 §24.8 里是拒绝侧。
//  2. TS 的 `!Number.isSafeInteger` 里有「非整数」这一半，Go 的 `int` 从类型上就构造
//     不出小数，故只保留 `< 0`。JS 侧的小数输入在 Go 侧根本进不来，不构成能力缺失。
//
// # 为什么全是不抛异常的纯判定函数
//
// 这些函数**用返回值表达判定，不用 panic/error**。「拿不到判定」与「判定为不合格」是
// 两个不同的事实，混成一个 error 会让调用方把「数据坏了」记成「审查者不合格」——
// 判据失真的方向恰好是**放行**（error 被吞掉就当没这回事），所以宁可让每个失败都带上
// 闭集里的理由。TS 侧同理，只有 `counter()` 对**调用方传错字段**才 throw。

// IntegrationGateFacts 是组合验证闸门的两条证据（§24.7）。
//
// 两个字段都是普通 bool：**缺省即 false**。这不是偷懒，是 fail-closed 的实现方式——
// 「没跑契约测试」与「契约测试没过」在判定上必须同归打回，否则漏填一个字段就等于静默放行。
type IntegrationGateFacts struct {
	/** 契约测试（`shared/seam-contracts` 的 TS/Go 双实现天然可做）是否通过。 */
	ContractTestsPass bool
	/** 集成冒烟是否通过。 */
	SmokePass bool
}

// IntegrationVerdict 是闸门结论的闭集。与 TS 的 `'pass' | 'reject-batch'` 同集。
//
// 特意**没有** `reject-run` 这一档：逐 Run 打回正是 §24.7 要禁掉的形状（见
// {@link IntegrationGate} 的说明）。少一个值，调用方就少一条走错的路。
type IntegrationVerdict string

const (
	// IntegrationPass 表示本批通过组合验证，`IN_REVIEW → DONE` 这条边走通。
	IntegrationPass IntegrationVerdict = "pass"
	// IntegrationRejectBatch 表示**整批**打回：业务态回 `ROUTING`，不产生逐 Run 打回。
	IntegrationRejectBatch IntegrationVerdict = "reject-batch"
)

// IntegrationGate 是组合验证闸门（§24.7）：批级判定，**不是**逐 Run 判定。
//
// # 为什么是批级而不是逐 Run
//
// §24.7 的核心警告是「每条线程的局部正确性不保证组合正确性」——各自 CI 全绿，合起来
// 跑不起来，且冲突是**滞后**的。既然失败的是「组合」而不是某个 Run，逐 Run 打回就没有
// 承接它的主体：把 A 打回改好，B 又因为别的原因坏了，再打回 B——协调者会停在
// 「A 改好、B 又坏」的循环里，永远收敛不到一个通过态。因此这道闸门在**批次**上问一次。
//
// 返回 `IntegrationRejectBatch` 时调用方把业务态整体回退（§23.3 已定义的
// `IN_REVIEW → ROUTING`），见 {@link TransitionBusinessTaskGated}。
func IntegrationGate(facts IntegrationGateFacts) IntegrationVerdict {
	if facts.ContractTestsPass && facts.SmokePass {
		return IntegrationPass
	}
	return IntegrationRejectBatch
}

// HighImpactArtifacts 是要求**模型级**异构的产出物数阈值（§24.8，TS 同名常量）。
const HighImpactArtifacts = 3

// ReviewImpact 是本批**改动影响面**（§24.8 规则 3 的 `affectedArtifacts`）的事实。
//
// # 为什么是两个字段而不是一个 int
//
// 「证明不了」与「0 个产出物」必须在判定上分得开。把前者写成 0，阈值判断
// （`>= HighImpactArtifacts`）就会把一次无从证明的大改动读成影响面小，而判据失真的方向
// 恰好是放行。于是零值表示**无从证明**，不是「0 个产出物」。
//
// 治理面今天**没有**这个数的生产者（逐条排除见 `store.TransitionBusinessTask` 的
// `review_impact` 注释与设计说明 §14.5），所以调用方眼下只会传零值进来；生产者出现时
// 需要改的也只是「谁来填 Proven」——判据本身不用动。
type ReviewImpact struct {
	// Artifacts 是产出物数。仅在 Proven 为 true 时有值——为 false 时它**不是 0 个**，
	// 是「没有这个数」，读它的人不该得到一个能拿去比较的数。
	Artifacts int
	// Proven 报告 Artifacts 是否来自**可证的事实**（已经发生、不由调用方声明）。
	Proven bool
}

// ReviewDisposition 是 §24.8 规则 3（改动影响面 ≥3 个产出物 → 强制独立审查）在治理面的
// **处置档**（闭集）。
//
// 三档而不是一个 bool：「判不出来」必须与「可证地小」分开。把前者并进后者，就是拿未知当小，
// 而 §24.8 的豁免（阈值以下只作提示）是一条**需要证据**的结论——没有证据就不发这张通行证。
// 与 {@link ReviewerEligibility} 的「缺省即同源」是同一条纪律的两个落点。
type ReviewDisposition string

const (
	// ReviewBelowThreshold 影响面**可证地**低于阈值：按 §24.8 只作提示。
	ReviewBelowThreshold ReviewDisposition = "below-threshold"
	// ReviewMandated 影响面**可证地**达到阈值：强制独立审查。
	ReviewMandated ReviewDisposition = "mandated"
	// ReviewImpactUnprovable 影响面无从证明：判不出该不该强制，**不假设它小**。
	ReviewImpactUnprovable ReviewDisposition = "impact-unprovable"
)

// ReviewDispositionFor 是 §24.8 规则 3 的**唯一一处阈值判断**：`HighImpactArtifacts`
// 只在这里比较一次。别处（挂点、审计、看板）不得再比一次——两份阈值判断必然漂移，
// 而漂移出来的那一份通常就是没人维护的那一份。
//
// 判不出来时返回 {@link ReviewImpactUnprovable}，**不是** {@link ReviewBelowThreshold}：
// 未知落在拒绝侧——「只作提示」这张通行证要证据，没有证据就不发。它同时也不是
// {@link ReviewMandated}：强制是一个**动作**，而动作需要可证的入参；把不可证读成可强制，
// 会让每一次单线程的自查自签都无法完成（§14.5 末已否掉那条路）。于是这一档留给调用方
// 如实记录——它记的是「本条判据缺一个可证入参」这个事实，而不是「影响面小」。
//
// 换句话：判据只回答「够不够强制」，不回答「强制做什么」；处置动作由调用方决定并在审计里
// 写出，判据不改变状态。
func ReviewDispositionFor(impact ReviewImpact) ReviewDisposition {
	if !impact.Proven {
		return ReviewImpactUnprovable
	}
	if impact.Artifacts >= HighImpactArtifacts {
		return ReviewMandated
	}
	return ReviewBelowThreshold
}

// ReviewerIneligibility 是审查者不合格理由的闭集，与 TS 的 `ReviewerIneligibility` 同集。
//
// 闭集而不是自由文本：这个值要写进审计行，自由文本会让它失去聚合能力
// （「本月有多少次审查因为同源被拒」必须是一次 GROUP BY，而不是一次人工阅读）。
type ReviewerIneligibility string

const (
	// ReviewerSelfReview 派发者不验收自己的活。与异构无关，是职责分离本身。
	ReviewerSelfReview ReviewerIneligibility = "self-review"
	// ReviewerHomogeneous 三维都不可证不同 —— 同源审查无法发现同源盲区（§24.8）。
	ReviewerHomogeneous ReviewerIneligibility = "homogeneous"
	// ReviewerHighImpactNeedsModelDiversity 影响面大时仅「换了节点」不算多样性。
	ReviewerHighImpactNeedsModelDiversity ReviewerIneligibility = "high-impact-needs-model-diversity"
	// ReviewerInvalidInput 输入本身不成立（`affectedArtifacts` 为负）。
	ReviewerInvalidInput ReviewerIneligibility = "invalid-input"
)

// ReviewerFacts 是判定一个候选审查者所需的全部事实（§24.8）。
//
// 六个维度字段**空串即缺省**，与 TS 的 `undefined` 同义（差异见文件头第 1 条）。
// 缺省不视为「不同」——判不出来不等于判为合格。
type ReviewerFacts struct {
	/** 派发该 Run 的主体（协调者 / agent 标识）。 */
	Dispatcher string
	/** 候选审查者。 */
	Reviewer string
	/** agent preset 维度。 */
	DispatcherPreset string
	ReviewerPreset   string
	/** 模型维度。 */
	DispatcherModel string
	ReviewerModel   string
	/** 承载节点维度。 */
	DispatcherNode string
	ReviewerNode   string
	/** 本批受影响的产出物数。 */
	AffectedArtifacts int
}

// ReviewerVerdict 是审查者判定结果。`Eligible == true` 时 `Reason` 必为空串；
// 否则 `Reason` 必是 {@link ReviewerIneligibility} 闭集里的一个值。
type ReviewerVerdict struct {
	Eligible bool                  `json:"eligible"`
	Reason   ReviewerIneligibility `json:"reason,omitempty"`
}

// ReviewerEligibility 判定一个候选审查者是否合格（§24.8）。
//
// # 缺省即同源
//
// 某一维度两侧都没给值时，**不认为它们不同**。这与 `remotability.ts` 的「未定级 = 拒绝」
// 同一条纪律：判不出差别时按没差别处理，而「没差别」在异构审查里是**拒绝侧**。
// 反过来写（缺省视为不同）会让「调用方没填 preset」变成一次静默放行——一次填写疏漏
// 就成了异构约束的绕过路径，而这正是这条约束存在的理由。
//
// # 影响面大时的加严（第 4 条）
//
// 「换了个节点」不构成多样性：同一份权重、同一套盲区在两台机器上跑出来的判断是一样的。
// 所以 `affectedArtifacts >= HighImpactArtifacts` 时必须**模型或 preset** 可证不同。
func ReviewerEligibility(facts ReviewerFacts) ReviewerVerdict {
	// 1. 输入先校验。排在最前是照抄 TS 的顺序：`invalid-input` 描述的是「这条输入不成立」，
	//    比任何业务判据都更靠前——它不该被「恰好 dispatcher == reviewer」掩盖掉。
	if facts.AffectedArtifacts < 0 {
		return ReviewerVerdict{Reason: ReviewerInvalidInput}
	}

	// 2. 派发者不验收自己的活。
	if facts.Dispatcher == facts.Reviewer {
		return ReviewerVerdict{Reason: ReviewerSelfReview}
	}

	// 3. 三维逐一比对。空串算缺省，缺省不算不同（见文件头差异 1）。
	presetDiffers := bothGivenAndDifferent(facts.DispatcherPreset, facts.ReviewerPreset)
	modelDiffers := bothGivenAndDifferent(facts.DispatcherModel, facts.ReviewerModel)
	nodeDiffers := bothGivenAndDifferent(facts.DispatcherNode, facts.ReviewerNode)

	if !presetDiffers && !modelDiffers && !nodeDiffers {
		return ReviewerVerdict{Reason: ReviewerHomogeneous}
	}

	// 4. 影响面大时，只有模型（或等价物：preset）不同才算数。
	//
	//    阈值只有一份实现：这里不重写 `>= HighImpactArtifacts`，而是把这个数问进
	//    {@link ReviewDispositionFor}。本判据的入参按 TS 的 `affectedArtifacts: number`
	//    语义是一个**已给定的数**，所以问的时候 `Proven` 为 true；「没有这个数」不允许
	//    从这条路径进来——治理面判不出来时在调用方止步，见 store 的 `review_impact`。
	if ReviewDispositionFor(ReviewImpact{Artifacts: facts.AffectedArtifacts, Proven: true}) == ReviewMandated &&
		!modelDiffers && !presetDiffers {
		return ReviewerVerdict{Reason: ReviewerHighImpactNeedsModelDiversity}
	}

	return ReviewerVerdict{Eligible: true}
}

// bothGivenAndDifferent 与 TS 的 `differs()` 同义：两侧都给值且不相等才算「可证不同」。
// 空串即缺省，缺省一律不算不同——这是「缺省即同源」唯一的一处实现。
func bothGivenAndDifferent(a, b string) bool {
	return a != "" && b != "" && a != b
}

// businessEventComplete 是 `TransitionBusinessTask` 的 targets 表里那个
// `"complete"` 事件（唯一指向 `DONE` 的事件，因此也是唯一承载组合验证闸门的边）。
const businessEventComplete = "complete"

// TransitionBusinessTaskGated 把 §24.7 的闸门挂到业务态机的 `IN_REVIEW → DONE` 边上。
//
// # 它不新增状态、不改闭集，也不重实现状态机
//
// 合法落点仍然只由 {@link TransitionBusinessTask} 判定（本函数先调它）；闸门只回答
// 「这条边最后指向 DONE 还是 ROUTING」。回退目标也不是这里写死的：它取自状态机里
// 既有的 `reroute` 边——§23.3 早已定义 `IN_REVIEW → ROUTING`，本函数只是引用它。
// 这样将来状态机若调整回退边，闸门自动跟随，不会留下一个硬编码的幽灵目标。
//
// 返回的 `verdict` 在 `complete` 以外的边上恒为 `IntegrationPass`：闸门不适用于那些边，
// 而不是它们「通过了」——`complete` 之外的事件调用方不应把该值写进审计。
//
// 打回**不是错误**：返回 nil error 且 `next == ROUTING`，调用方据此看出「整批打回」。
// 把它做成 error 会诱使调用方按「失败即不改状态」处理，而那恰好是 §24.7 不想要的
// 形状——它要的是业务态**真的**回到 ROUTING。
func TransitionBusinessTaskGated(from, event string, gate IntegrationGateFacts) (string, IntegrationVerdict, error) {
	next, err := TransitionBusinessTask(from, event)
	if err != nil {
		return "", "", err
	}
	if event != businessEventComplete {
		return next, IntegrationPass, nil
	}
	if IntegrationGate(gate) == IntegrationPass {
		return next, IntegrationPass, nil
	}
	reversion, err := TransitionBusinessTask(from, "reroute")
	if err != nil {
		// 走到这里说明状态机不再提供回退边，而闸门又判了打回——没有落点可用。
		// 暴露而不是退化成 DONE：放行一个没通过组合验证的批次，代价比一次 500 大得多。
		return "", IntegrationRejectBatch, fmt.Errorf("integration gate rejected but %s has no reversion edge: %w", from, err)
	}
	return reversion, IntegrationRejectBatch, nil
}
