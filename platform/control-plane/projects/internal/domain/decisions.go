// 项目决策记忆领域层（§24.4，设计说明 2026-09-20 §5/§11）。
//
// 共享记忆承载的不是知识而是**决策的考古层**（§24.4 第 1 条）：文章举的三个例子
// （发布日期改到周五 / 为什么砍掉导出功能 / 动账单服务前要找谁）都是**无法从代码里
// 读出来**的东西。因此本层的三条硬约束：
//
//  1. **作用域是 (realm, project_id)**，不是 realm。决策属于项目工作区，跨项目污染
//     等于把「哪个项目的决定」这个前提抹掉。
//  2. **append-only + 显式取代**。新决策**追加**；被判定的旧条目只写 `superseded_by`
//     一个列，其余列一个字节都不改。为什么不做原地改：原地改会把「当初为什么这么定」
//     这段历史覆盖掉——而决策记忆唯一的价值就是这段历史；同时它让多写者冲突变成
//     「谁的后写谁赢」这种无人能事后复盘的静默结果。只有 `superseded_by IS NULL` 的行
//     才是 live。
//  3. **系统不裁决**。多写者冲突由协调者在验收时裁决（§24.4 第 4 条），本层只提供
//     取代关系与**只标注不裁决**的固化信号（见 consolidation.go）。
package domain

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ErrInvalidDecision 决策条目不合法的统一错误（server 层映射 400）。
//
// 与 store 层的领域错误（ErrNameTaken 等）不同，本错误**必须**定义在 domain：
// 校验发生在纯函数里，而 store 无法向上定义 domain 的错误。store 与 server 用
// errors.Is 判定，跨层身份靠它维持。
var ErrInvalidDecision = errors.New("非法决策条目")

// DecisionKind 闭集（§11 的 DDL 注释直译）。闭集外的值一律拒绝——不是「未知即跳过」：
// 一个拼错的 kind 会让决策在按 kind 过滤的读面里**静默消失**，而消失的决策表现为
// 「这条决定从没被记过」，正是这套记忆要防的事故。
const (
	DecisionKindDecision  = "decision"  // 决定了什么
	DecisionKindBoundary  = "boundary"  // 边界（哪里不碰、哪里必须先问）
	DecisionKindOwnership = "ownership" // 谁负责
	DecisionKindTrap      = "trap"      // 踩过的坑
)

// DecisionKinds 闭集的有序快照（错误信息与测试共用，避免两处手抄）。
var DecisionKinds = []string{
	DecisionKindDecision, DecisionKindBoundary, DecisionKindOwnership, DecisionKindTrap,
}

// 索引层行数上限（§24.4 第 2 条）。
//
// 为什么必须有这两个常量：索引是**常驻上下文**的那一层。膨胀的索引会同时损害
// 命中率（要读的东西变多）与上下文预算（每轮都要带上），所以读面「有 limit 参数」
// 还不够——**默认值本身就是上限**，调用方不传也必须被限住。上限之外的行不是丢失：
// 它们仍可被 supersede 的既成事实、以及正文按需读面拿到。
const (
	DecisionIndexDefaultLimit = 50
	DecisionIndexMaxLimit     = 200
)

// Decision 决策条目（project_decisions 表的领域投影，正文层）。
type Decision struct {
	ID        string `json:"id"`
	Realm     string `json:"realm"`
	ProjectID string `json:"project_id"`
	Kind      string `json:"kind"`
	Summary   string `json:"summary"`
	Body      string `json:"body,omitempty"`
	// Supersedes 指向本条取代的旧条目；SupersededBy 是反向指针，由取代动作回填。
	Supersedes   string `json:"supersedes,omitempty"`
	SupersededBy string `json:"superseded_by,omitempty"`
	// Evidence 与任务报告的证据坐标同形（§23.4 `(session_ref, seq)`），可空。
	// 决策常常拍在没有会话的地方（人在会议上定的），所以它是 nullable 而不是必填。
	Evidence  []ReportEvidence `json:"evidence,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
}

// DecisionIndexRow 索引层投影：**只有 summary，没有 body**。
//
// 单独一个类型而不是给 Decision 加 `omitempty`：这样「索引查询不小心把 body 也
// select 出来」在编译期就不可能——膨胀索引的代价正是这一列带来的。正文按需读，
// 走 GetDecision。
type DecisionIndexRow struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"`
	Summary    string    `json:"summary"`
	Supersedes string    `json:"supersedes,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// ValidDecisionKind kind 闭集校验。闭集外报错并列出合法取值。
func ValidDecisionKind(kind string) error {
	for _, k := range DecisionKinds {
		if kind == k {
			return nil
		}
	}
	return fmt.Errorf("%w: 未知 kind %q，合法取值：%s",
		ErrInvalidDecision, kind, strings.Join(DecisionKinds, " / "))
}

// ResolveDecisionIndexLimit 把调用方给的 limit 收敛到 [1, DecisionIndexMaxLimit]。
//
// 语义是**收敛而不是报错**：limit 是上下文预算的旋钮，不是身份或权限；调用方传 0
// （不限）时必须拿到有界结果而不是无界结果——「不限」在这条读面上从来不是合法意图。
// 非正数与超上限都夹到边界，不产生「看起来更大实则没生效」的静默值。
func ResolveDecisionIndexLimit(requested int) int {
	switch {
	case requested <= 0:
		return DecisionIndexDefaultLimit
	case requested > DecisionIndexMaxLimit:
		return DecisionIndexMaxLimit
	default:
		return requested
	}
}

// ValidateDecisionAppend 追加前的校验（纯函数，store 在事务外先跑一次）。
//
// 为什么 self-supersede 要单独拒：`supersedes == id` 的新行会被自己的取代动作写成
// `superseded_by == id`，于是它**一出生就不 live**——写的人以为记下了，读面永远看不到。
// 这种「写入成功但不可见」的形状必须变成显式错误。
func ValidateDecisionAppend(d Decision) error {
	if d.ID == "" || d.Realm == "" || d.ProjectID == "" {
		return fmt.Errorf("%w: id / realm / project_id 均不可为空（决策的作用域是 (realm, project_id)）", ErrInvalidDecision)
	}
	if err := ValidDecisionKind(d.Kind); err != nil {
		return err
	}
	if strings.TrimSpace(d.Summary) == "" {
		return fmt.Errorf("%w: summary 不可为空——索引行靠它命中，空 summary 等于一条读不到的决策", ErrInvalidDecision)
	}
	if strings.TrimSpace(d.Body) == "" {
		return fmt.Errorf("%w: body 不可为空——索引只有一行，全文是决策的全部内容", ErrInvalidDecision)
	}
	if d.Supersedes == d.ID {
		return fmt.Errorf("%w: 不可取代自身（该行会被自己写成 superseded_by=id，从此不 live）", ErrInvalidDecision)
	}
	if d.SupersededBy != "" {
		return fmt.Errorf("%w: 追加的行不可能已被取代——那是原地改的形状", ErrInvalidDecision)
	}
	for i, e := range d.Evidence {
		if e.SessionRef == "" || e.Seq < 0 {
			// 与任务报告的取舍相反：报告**过滤**坏证据（保留其余），决策**拒绝**整条。
			// 理由：报告的证据只为把段落标成已验证，少一条不影响其余；决策的证据要
			// 支撑「凭什么这么定」，坐标不可解析时留着它会变成一条看似有据的断言。
			return fmt.Errorf("%w: evidence[%d] 坐标不可解析（session_ref 非空且 seq >= 0）", ErrInvalidDecision, i)
		}
	}
	return nil
}

// SortDecisionSignals 固化任务的**唯一**排序规则（索引顺序：新在前，id 倒序兜平手）。
//
// 为什么排序要单独一个函数：剪枝候选（超出索引上限的行）的定义依赖「谁在索引里」，
// 而索引的 SQL 排序是 created_at DESC, id DESC。两处各写一遍排序，就会出现「索引显示
// A 在 B 之后、剪枝却说 A 该先剪」的自相矛盾。store 的查询 ORDER BY 与本函数必须同序。
func SortDecisionSignals(rows []DecisionSignal) {
	sort.Slice(rows, func(i, j int) bool {
		if !rows[i].CreatedAt.Equal(rows[j].CreatedAt) {
			return rows[i].CreatedAt.After(rows[j].CreatedAt)
		}
		return rows[i].ID > rows[j].ID
	})
}
