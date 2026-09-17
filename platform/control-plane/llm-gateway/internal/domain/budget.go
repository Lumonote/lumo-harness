// Package domain LLM 网关领域层：预算四态与双树裁决的 Go 镜像。
//
// 语义真相源在 platform/shared/seam-contracts/budget-policy.ts（TS）；此处逐语义
// 镜像——单截面跨网成立的前提是执法语义不因语言分叉（设计说明 2026-08-26 §7
// 首风险）。两侧测试同矩阵：budget_test.go 逐格对照 TS budget-policy.spec 的判序。
package domain

// BudgetState 四态（严重度序：within < soft < overdraft < hard）。
const (
	StateWithin    = "within"
	StateSoft      = "soft"
	StateOverdraft = "overdraft"
	StateHard      = "hard"
)

// Severity 严重度序（与 TS SEVERITY 一致）——worseOf 的比较基。
var severity = map[string]int{StateWithin: 0, StateSoft: 1, StateOverdraft: 2, StateHard: 3}

// BudgetLimits 一棵树的限额（总额模型；nil 语义由调用方先判——见 StateOfTree）。
type BudgetLimits struct {
	Budget    int64
	SoftLimit int64
	Overdraft int64
}

// BudgetState 判态：used 左闭（「恰好用完预算」已越界——预算 1000 的树实际能用到
// 1000，第 1001 才进 soft？不——used === budget 即 soft，与 TS budgetState 同判）。
//
// softLimit/budget/overdraft 为 0 的语义：0 表示「未配置该档」（TS resolveLimits 的
// 缺省 0 同义——soft_limit=0 即无软限额档）。
//
// 负 overdraft 是**非法配置**，先拒绝（2026-09-15 补）。
//
// 判据在 canonical 那边：`budgetState` 走 `resolveLimits`，而后者对负数与非有限值
// **抛错**（`shared/seam-contracts/budget-policy.ts` 的 `finite()`；用例
// `budget-policy.spec.ts`「负数与非有限值抛错」钉住 `overdraft: -1` 必须抛）。
// 写入侧同源：`setBudget`/`adjustBudget` 落库前也调 `resolveLimits`，所以库里不该有
// 负 overdraft 的行。
//
// 这个函数没有错误返回值，于是把「拒绝」翻译成 `hard`——**返回一个看起来合理的态
// 比拒绝坏得多**（canonical 注释原话），而且负 overdraft 的具体后果是 `used < budget`
// 那一支会**遮住** hard 支（`budget+overdraft < budget`），于是一棵把透支额配成负数的
// 树永远判不到 hard，静默放行。
//
// 为什么读侧也要兜（而不是「反正写不进来」）：`budget_metrics.go` 的 SQL 聚合是同一
// 语义的第二份实现，它本来就按 `budget <= -overdraft` 把这种行算作 denied。若只让 Go
// 这边继续给 soft，两边就在这个角落分叉——监控面板说「这批租户被拦住了」，网关实际在
// 放行。镜像用例 `TestBudgetTreeCountsMirrorStateOfTree` 正是为抓这种分叉存在的。
func BudgetState(used int64, l BudgetLimits) string {
	if l.Overdraft < 0 {
		return StateHard
	}
	switch {
	case used < l.SoftLimit:
		return StateWithin
	case used < l.Budget:
		return StateSoft
	case used < l.Budget+l.Overdraft:
		return StateOverdraft
	default:
		return StateHard
	}
}

// WorseOf 双树取更严者（满足交换律与幂等——检查顺序不影响结论）。
func WorseOf(a, b string) string {
	if severity[a] >= severity[b] {
		return a
	}
	return b
}

// IsAllowed hard 之外都放行——透支是「放行且记账」，不是「拒绝」。
func IsAllowed(state string) bool { return state != StateHard }

// TreeRow budget_trees 一行的领域投影（列名对齐 TS BudgetTreeRow）。
type TreeRow struct {
	Budget      *int64
	BudgetTotal *int64
	SoftLimit   *int64
	Overdraft   *int64
}

// StateOfTree 单树判态（镜像 TS stateOfTree）：
//   - 行不存在 → hard（无预算记录 = 无隐性额度）
//   - 旧模式（budget_total NULL）：剩余 < need 即 hard，否则 within
//   - 总额模式：used = total - remaining + need 代入四态
func StateOfTree(row *TreeRow, need int64) string {
	if row == nil {
		return StateHard
	}
	if row.BudgetTotal == nil {
		if *row.Budget < need {
			return StateHard
		}
		return StateWithin
	}
	used := *row.BudgetTotal - *row.Budget + need
	return BudgetState(used, BudgetLimits{
		Budget:    *row.BudgetTotal,
		SoftLimit: deref(row.SoftLimit),
		Overdraft: deref(row.Overdraft),
	})
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// CostEvent 计量事件（与 usage-ledger 的 ledger.Event 同形状——网关是 TS cost-events
// 契约的第三消费方，字段名按 JSON 传输形态）。
type CostEvent struct {
	Context  Attribution `json:"context"`
	CostType string      `json:"costType"`
	Qty      float64     `json:"qty"`
	Unit     string      `json:"unit"`
	TraceID  string      `json:"traceId"`
	Emitter  string      `json:"emitter"`
	CostUSD  float64     `json:"costUsd"`
	Tokens   *int64      `json:"tokens,omitempty"`
	Model    string      `json:"model,omitempty"`
}

// Attribution 归因八维（缺一即拒绝入账——与 ledger.Attribution 同构）。
type Attribution struct {
	UserID      string `json:"userId"`
	DeptID      string `json:"deptId"`
	Role        string `json:"role"`
	ProjectID   string `json:"projectId"`
	AgentID     string `json:"agentId"`
	ComponentID string `json:"componentId"`
	Feature     string `json:"feature"`
	SessionRef  string `json:"sessionRef"`
}

// Usage OpenAI 兼容 usage 对象（流式末 chunk 或非流式响应内）。
type Usage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
}
