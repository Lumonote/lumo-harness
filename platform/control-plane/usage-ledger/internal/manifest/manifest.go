// Package manifest 是台账与成本闭集的**单一真相源投影**。
//
// 数值真相源在 platform/shared/manifests/（TS 侧同源）。Go embed 不允许引用包目录
// 之外的文件（也不能跨模块），因此这里是**副本**；漂移防护由 manifest_test.go 的
// 双向锁承担：测试在运行期读取 ../../../../shared/manifests/ 下的原件逐字节比对，
// 任何一侧改动未同步另一侧即红。新增列/类型 = 改 shared 原件 + 拷贝此处 + 两侧锁绿。
package manifest

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed usage-ledger.schema.json
var ledgerSchemaJSON []byte

//go:embed cost-types.manifest.json
var costTypesJSON []byte

// RawLedgerSchema 返回 embed 的台账列清单原文（供漂移锁测试与调试）。
func RawLedgerSchema() []byte { return ledgerSchemaJSON }

// RawCostTypes 返回 embed 的成本闭集原文。
func RawCostTypes() []byte { return costTypesJSON }

// LedgerColumn 台账列定义（与 shared/manifests/usage-ledger.schema.json 同构）。
type LedgerColumn struct {
	Name       string `json:"name"`
	PGType     string `json:"pgType"`
	NotNull    bool   `json:"notNull"`
	Default    string `json:"default,omitempty"`
	PrimaryKey bool   `json:"primaryKey,omitempty"`
}

type ledgerSchema struct {
	Columns []LedgerColumn `json:"columns"`
}

// LedgerColumns 返回列清单（顺序 = DDL/INSERT 列序，与 TS 侧同源规则一致）。
func LedgerColumns() ([]LedgerColumn, error) {
	var s ledgerSchema
	if err := json.Unmarshal(ledgerSchemaJSON, &s); err != nil {
		return nil, fmt.Errorf("解析 usage-ledger.schema.json 失败: %w", err)
	}
	if len(s.Columns) == 0 {
		return nil, fmt.Errorf("usage-ledger.schema.json 的 columns 为空——清单不得为空")
	}
	return s.Columns, nil
}

// ColumnNames 返回全部列名（含主键）。
func ColumnNames() ([]string, error) {
	cols, err := LedgerColumns()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(cols))
	for _, c := range cols {
		names = append(names, c.Name)
	}
	return names, nil
}

// InsertColumns 返回 INSERT 列清单（排除自增主键）——批量写入的唯一列序。
func InsertColumns() ([]string, error) {
	cols, err := LedgerColumns()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(cols))
	for _, c := range cols {
		if c.PrimaryKey {
			continue
		}
		names = append(names, c.Name)
	}
	return names, nil
}

// LedgerDDL 由清单生成 CREATE TABLE（幂等；列段与 TS 侧 METERING_DDL 同源生成规则对齐）。
func LedgerDDL() (string, error) {
	cols, err := LedgerColumns()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("CREATE TABLE IF NOT EXISTS usage_ledger (\n")
	for i, c := range cols {
		b.WriteString("  " + c.Name + " " + c.PGType)
		if c.PrimaryKey {
			b.WriteString(" PRIMARY KEY")
		}
		if c.NotNull {
			b.WriteString(" NOT NULL")
		}
		if c.Default != "" {
			b.WriteString(" DEFAULT " + c.Default)
		}
		if i < len(cols)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString(")")
	return b.String(), nil
}

// LedgerIndexes 台账索引（与 TS 侧 METERING_MIGRATIONS 的既有动作对齐；
// event_key 唯一索引是幂等键的执法者）。
const LedgerIndexes = `
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_event_key_idx ON usage_ledger (event_key);
CREATE INDEX IF NOT EXISTS usage_ledger_trace_idx ON usage_ledger (trace_id);
CREATE INDEX IF NOT EXISTS usage_ledger_type_ts_idx ON usage_ledger (cost_type, ts DESC);
`

// CostTypes 返回成本闭集（type → unit）。
func CostTypes() (map[string]string, error) {
	var m struct {
		CostTypes map[string]struct {
			Unit string `json:"unit"`
		} `json:"costTypes"`
	}
	if err := json.Unmarshal(costTypesJSON, &m); err != nil {
		return nil, fmt.Errorf("解析 cost-types.manifest.json 失败: %w", err)
	}
	if len(m.CostTypes) == 0 {
		return nil, fmt.Errorf("cost-types.manifest.json 的 costTypes 为空")
	}
	out := make(map[string]string, len(m.CostTypes))
	for t, v := range m.CostTypes {
		out[t] = v.Unit
	}
	return out, nil
}
