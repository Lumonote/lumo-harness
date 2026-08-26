package integration_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/usage-ledger/internal/ledger"
	"github.com/lumo-harness/platform/usage-ledger/internal/manifest"
)

// 活库集成闸：无 LUMO_TEST_PG_DSN 时跳过（且跳过可见，同仓库惯例）。
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过活库集成测试")
	}
	return dsn
}

// schemaDSN 给每个测试一个独立 schema（与 TS 侧 pg-schema.ts 同理由：
// 并行用例不得互相 TRUNCATE）。
func schemaDSN(t *testing.T, base, schema string) string {
	t.Helper()
	admin, err := pgxpool.New(context.Background(), base)
	if err != nil {
		t.Fatalf("admin 连接失败: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(context.Background(),
		fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s", schema)); err != nil {
		t.Fatalf("建 schema 失败: %v", err)
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("DSN 解析失败: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	return u.String()
}

func newPool(t *testing.T, schema string) *pgxpool.Pool {
	t.Helper()
	dsn := schemaDSN(t, testDSN(t), schema)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("连接失败: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func tokens(n int64) *int64 { return &n }

func mkRow(key string, ts time.Time) ledger.Row {
	return ledger.Row{
		Ts:       ts,
		EventKey: key,
		E: ledger.Event{
			Context: ledger.Attribution{
				UserID: "u1", DeptID: "d1", Role: "viewer", ProjectID: "p1",
				AgentID: "a1", ComponentID: "c1", Feature: "kb:qa", SessionRef: "s1",
			},
			CostType: "llm.tokens", Qty: 12, Unit: "tokens",
			TraceID: "tr-go", Emitter: "emitter:go-test", CostUSD: 0.5,
			Tokens: tokens(12), Model: "deepseek",
		},
	}
}

func countLedger(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		"SELECT count(*) FROM usage_ledger").Scan(&n); err != nil {
		t.Fatalf("count 失败: %v", err)
	}
	return n
}

// 判据 1/2：幂等——同 event_key 两批 = 一行（至少一次投递的消费侧重放靠它兜底）。
func TestIdempotentInsert(t *testing.T) {
	pool := newPool(t, "ul_ledger_test")
	ctx := context.Background()
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("init 失败: %v", err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE usage_ledger"); err != nil {
		t.Fatalf("TRUNCATE 失败: %v", err)
	}

	rows := []ledger.Row{mkRow("ek-1", time.Now()), mkRow("ek-2", time.Now())}
	if err := ledger.BatchInsert(ctx, pool, rows); err != nil {
		t.Fatalf("首批插入失败: %v", err)
	}
	// 整批重放（模拟至少一次投递）
	if err := ledger.BatchInsert(ctx, pool, rows); err != nil {
		t.Fatalf("重放应无错（DO NOTHING）: %v", err)
	}
	if n := countLedger(t, pool); n != 2 {
		t.Fatalf("重放后应为 2 行, got %d", n)
	}
}

// 判据 3：事件时刻保真——入库的 ts 必须是事件时刻，不是 now()。
func TestEventTimeFidelity(t *testing.T) {
	pool := newPool(t, "ul_ledger_ts_test")
	ctx := context.Background()
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("init 失败: %v", err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE usage_ledger"); err != nil {
		t.Fatalf("TRUNCATE 失败: %v", err)
	}

	eventTime := time.Date(2026, 1, 6, 23, 59, 58, 0, time.UTC)
	if err := ledger.BatchInsert(ctx, pool, []ledger.Row{mkRow("ek-ts", eventTime)}); err != nil {
		t.Fatalf("插入失败: %v", err)
	}
	var got time.Time
	if err := pool.QueryRow(ctx, "SELECT ts FROM usage_ledger").Scan(&got); err != nil {
		t.Fatalf("读 ts 失败: %v", err)
	}
	if !got.Equal(eventTime) {
		t.Fatalf("事件时刻未保真: got %v want %v", got, eventTime)
	}
}

// 判据 4：归因字段完整落列（8 维度全在）。
func TestAttributionColumns(t *testing.T) {
	pool := newPool(t, "ul_ledger_attr_test")
	ctx := context.Background()
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("init 失败: %v", err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE usage_ledger"); err != nil {
		t.Fatalf("TRUNCATE 失败: %v", err)
	}
	if err := ledger.BatchInsert(ctx, pool, []ledger.Row{mkRow("ek-attr", time.Now())}); err != nil {
		t.Fatalf("插入失败: %v", err)
	}
	var u, d, r, p, a, c, f, s, tr, em string
	if err := pool.QueryRow(ctx,
		`SELECT user_id, dept_id, role, project_id, agent_id, component_id,
		        feature, session_ref, trace_id, emitter FROM usage_ledger`).
		Scan(&u, &d, &r, &p, &a, &c, &f, &s, &tr, &em); err != nil {
		t.Fatalf("读归因列失败: %v", err)
	}
	if u != "u1" || d != "d1" || r != "viewer" || p != "p1" || a != "a1" ||
		c != "c1" || f != "kb:qa" || s != "s1" || tr != "tr-go" || em != "emitter:go-test" {
		t.Fatalf("归因列不符: %s/%s/%s/%s/%s/%s/%s/%s/%s/%s", u, d, r, p, a, c, f, s, tr, em)
	}
}

// 判据 6：校验拒绝发生在写库之前——台账不得有脏行（与 TS 侧「坏事件 0 行」同断言）。
func TestValidateBeforeWrite(t *testing.T) {
	pool := newPool(t, "ul_ledger_reject_test")
	ctx := context.Background()
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("init 失败: %v", err)
	}
	if _, err := pool.Exec(ctx, "TRUNCATE usage_ledger"); err != nil {
		t.Fatalf("TRUNCATE 失败: %v", err)
	}

	bad := mkRow("ek-bad", time.Now())
	bad.E.CostType = "made.up"
	if err := ledger.BatchInsert(ctx, pool, []ledger.Row{bad}); err == nil {
		t.Fatalf("闭集外类型应拒绝")
	}
	if n := countLedger(t, pool); n != 0 {
		t.Fatalf("校验失败不得落行, got %d", n)
	}
}

// Init 幂等：连跑两次不报错（既有库形态必然发生）。
func TestInitIdempotent(t *testing.T) {
	pool := newPool(t, "ul_ledger_init_test")
	ctx := context.Background()
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("init 失败: %v", err)
	}
	if err := ledger.Init(ctx, pool); err != nil {
		t.Fatalf("二次 init 应幂等: %v", err)
	}
	// DDL 来自清单：列数对齐 19 列基线
	ddl, err := manifest.LedgerDDL()
	if err != nil {
		t.Fatalf("DDL 生成失败: %v", err)
	}
	if !strings.Contains(ddl, "event_key TEXT") || strings.Count(ddl, "\n") < 19 {
		t.Fatalf("DDL 形状异常: %s", ddl)
	}
}
