// Package ledger 是 usage_ledger 的 Go 侧唯一写入路径（§6.4 单一写入者原则的
// Go 半边）：校验 + 批量幂等插入。发布/消费两侧（rmqpublish/rmqconsume）都经此落账，
// 不得各自写 INSERT——那是 schema 的第二份副本（与 TS 侧 batchInsertLedger 同哲学）。
package ledger

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/usage-ledger/internal/manifest"
)

// Event 与 TS 侧 CostEvent 同构（字段名按 JSON 传输形态）。
type Event struct {
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

// Attribution 归因维度（与 usage_ledger 列一致，缺一即拒绝）。
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

// Row 一条待入账记录：事件 + 幂等键 + 事件时刻（非投影时刻——不变式②）。
type Row struct {
	Ts       time.Time
	EventKey string
	E        Event
}

// ValidateEvent 入账前校验（与 TS 侧 assertCostEvent 同语义：闭集、单位一致、
// 有限非负、归因完整、llm.tokens 的 tokens/model 强制）。失败即拒——脏行进不了
// append-only 台账。
func ValidateEvent(e Event) error {
	costTypes, err := manifest.CostTypes()
	if err != nil {
		return err
	}
	unit, ok := costTypes[e.CostType]
	if !ok {
		keys := make([]string, 0, len(costTypes))
		for k := range costTypes {
			keys = append(keys, k)
		}
		return fmt.Errorf("未知成本类型 %s，拒绝入账。合法取值：%s",
			e.CostType, strings.Join(keys, " / "))
	}
	if e.Unit != unit {
		return fmt.Errorf("成本类型 %s 的单位必须是 %s，收到 %s", e.CostType, unit, e.Unit)
	}
	if math.IsNaN(e.Qty) || math.IsInf(e.Qty, 0) || e.Qty < 0 {
		return fmt.Errorf("%s 的 qty 必须是有限非负数，收到 %v", e.CostType, e.Qty)
	}
	// 负成本是记账错误，不是退款：退款是计费系统的冲正单据
	if math.IsNaN(e.CostUSD) || math.IsInf(e.CostUSD, 0) || e.CostUSD < 0 {
		return fmt.Errorf("%s 的 costUsd 必须是有限非负数，收到 %v", e.CostType, e.CostUSD)
	}
	if e.TraceID == "" {
		return fmt.Errorf("%s 缺 traceId", e.CostType)
	}
	if e.Emitter == "" {
		return fmt.Errorf("%s 缺 emitter", e.CostType)
	}
	a := e.Context
	if a.UserID == "" || a.DeptID == "" || a.Role == "" || a.ProjectID == "" ||
		a.AgentID == "" || a.ComponentID == "" || a.Feature == "" || a.SessionRef == "" {
		return fmt.Errorf("%s 的归因上下文不完整", e.CostType)
	}
	if e.CostType == "llm.tokens" {
		if e.Tokens == nil || e.Model == "" {
			return fmt.Errorf("llm.tokens 必须带 tokens 与 model —— 它是唯一的 token 截面")
		}
		if float64(*e.Tokens) != e.Qty {
			return fmt.Errorf("llm.tokens 的 qty(%v) 必须等于 tokens(%d)", e.Qty, *e.Tokens)
		}
	} else if e.Tokens != nil {
		return fmt.Errorf("%s 不得带 tokens —— 带了说明发出方把量塞错了列", e.CostType)
	}
	return nil
}

// InsertSQL 返回批量 INSERT（列清单由 embed 清单生成；幂等 = ON CONFLICT DO NOTHING）。
// placeholder 数 = 行数 × 列数——列清单变化时自动失配即响亮失败（与 TS 侧同性质）。
func InsertSQL(n int) (string, error) {
	cols, err := manifest.InsertColumns()
	if err != nil {
		return "", err
	}
	if n < 1 {
		return "", fmt.Errorf("批量插入行数必须 ≥ 1")
	}
	width := len(cols)
	placeholders := make([]string, 0, n)
	for r := 0; r < n; r++ {
		ph := make([]string, width)
		for c := 0; c < width; c++ {
			ph[c] = fmt.Sprintf("$%d", r*width+c+1)
		}
		placeholders = append(placeholders, "("+strings.Join(ph, ",")+")")
	}
	return fmt.Sprintf(
		"INSERT INTO usage_ledger (%s) VALUES %s ON CONFLICT (event_key) DO NOTHING",
		strings.Join(cols, ", "), strings.Join(placeholders, ","),
	), nil
}

// BatchInsert 批量落账。参数序与 manifest.InsertColumns() 严格一致；
// 非 token 类型的 tokens 列写 0（防 SUM(tokens) 静默变 NULL——与 TS 侧同注释同语义）。
func BatchInsert(ctx context.Context, pool *pgxpool.Pool, rows []Row) error {
	if len(rows) == 0 {
		return nil
	}
	for _, r := range rows {
		if err := ValidateEvent(r.E); err != nil {
			return fmt.Errorf("入账校验失败（event_key=%s）: %w", r.EventKey, err)
		}
	}
	sql, err := InsertSQL(len(rows))
	if err != nil {
		return err
	}
	cols, _ := manifest.InsertColumns()
	args := make([]any, 0, len(rows)*len(cols))
	for _, r := range rows {
		tokens := int64(0)
		var model any
		if r.E.Tokens != nil {
			tokens = *r.E.Tokens
		}
		if r.E.Model != "" {
			model = r.E.Model
		}
		args = append(args,
			r.Ts, // 事件时刻（不变式②）：来自消息，不是 now()
			r.E.Context.UserID, r.E.Context.DeptID, r.E.Context.Role, r.E.Context.ProjectID,
			r.E.Context.AgentID, r.E.Context.ComponentID, r.E.Context.Feature, r.E.Context.SessionRef,
			model, tokens,
			r.E.CostType, r.E.CostUSD, r.E.TraceID, r.E.Emitter, r.E.Qty, r.E.Unit, r.EventKey,
		)
	}
	_, err = pool.Exec(ctx, sql, args...)
	return err
}

// Init 幂等建表（与 TS 侧 init 同语义：既有库上跑多次不报错）。
func Init(ctx context.Context, pool *pgxpool.Pool) error {
	ddl, err := manifest.LedgerDDL()
	if err != nil {
		return err
	}
	if _, err := pool.Exec(ctx, ddl); err != nil {
		return fmt.Errorf("建 usage_ledger 失败: %w", err)
	}
	if _, err := pool.Exec(ctx, manifest.LedgerIndexes); err != nil {
		return fmt.Errorf("建 usage_ledger 索引失败: %w", err)
	}
	return nil
}
