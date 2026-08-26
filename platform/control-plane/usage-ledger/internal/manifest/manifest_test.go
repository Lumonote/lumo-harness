package manifest

import (
	"bytes"
	"os"
	"testing"
)

// 漂移锁：本包内嵌的清单副本必须与 platform/shared/manifests/ 下的原件逐字节一致。
//
// 为什么是副本而不是引用：Go embed 不得指向包目录之外（也不跨模块）。单一真相源
// 由「原件在 shared/manifests + 此处副本 + 本锁」三件套维持——改原件不改副本 →
// 本测试红；改副本不改原件 → 同样红。与 TS 侧的「清单锁」（outbox.spec）互为镜像。
//
// 注意：测试以包目录为工作目录，../../../../ = platform/。

func TestLedgerSchemaInSync(t *testing.T) {
	orig, err := os.ReadFile("../../../../shared/manifests/usage-ledger.schema.json")
	if err != nil {
		t.Fatalf("读取原件失败（路径漂移？）: %v", err)
	}
	if !bytes.Equal(orig, ledgerSchemaJSON) {
		t.Fatalf("usage-ledger.schema.json 与 shared/manifests 原件不一致——改清单必须两侧同步")
	}
}

func TestCostTypesInSync(t *testing.T) {
	orig, err := os.ReadFile("../../../../shared/manifests/cost-types.manifest.json")
	if err != nil {
		t.Fatalf("读取原件失败（路径漂移？）: %v", err)
	}
	if !bytes.Equal(orig, costTypesJSON) {
		t.Fatalf("cost-types.manifest.json 与 shared/manifests 原件不一致——改清单必须两侧同步")
	}
}

// 清单锁：19 列基线与 TS 侧 outbox.spec 的 USAGE_LEDGER_COLUMNS 基线一致。
// 加列 → 此锁红 → 显式同步两侧（包括 TS 的批量 INSERT 参数数）。
func TestColumnBaseline(t *testing.T) {
	names, err := ColumnNames()
	if err != nil {
		t.Fatalf("列清单解析失败: %v", err)
	}
	want := []string{
		"id", "ts", "user_id", "dept_id", "role", "project_id", "agent_id",
		"component_id", "feature", "session_ref", "model", "tokens",
		"cost_type", "cost_usd", "trace_id", "emitter", "qty", "unit", "event_key",
	}
	if len(names) != len(want) {
		t.Fatalf("列数不符: got %d want %d (%v)", len(names), len(want), names)
	}
	for i, n := range want {
		if names[i] != n {
			t.Fatalf("第 %d 列不符: got %s want %s", i, names[i], n)
		}
	}

	ins, err := InsertColumns()
	if err != nil {
		t.Fatalf("INSERT 列解析失败: %v", err)
	}
	if len(ins) != 18 {
		t.Fatalf("INSERT 列应为 18（排除自增主键）, got %d", len(ins))
	}
	for _, n := range ins {
		if n == "id" {
			t.Fatalf("INSERT 列不得含自增主键 id")
		}
	}
}

func TestCostTypesSix(t *testing.T) {
	m, err := CostTypes()
	if err != nil {
		t.Fatalf("闭集解析失败: %v", err)
	}
	if len(m) != 6 {
		t.Fatalf("闭集应恰 6 类, got %d", len(m))
	}
	if m["llm.tokens"] != "tokens" || m["seam.query"] != "rows" {
		t.Fatalf("闭集单位漂移: %v", m)
	}
}
